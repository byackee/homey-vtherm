/**
 * `runtime/scheduler.mts` — l'unique timer de l'app.
 *
 * Pourquoi un seul : avec cinq boucles indépendantes, cinq VTherm annoncent leur demande de chaleur
 * à cinq instants différents, la chaudière est recomptée cinq fois par cycle et le garde-fou
 * anti-pulsation de 60 s se retrouve à servir en fonctionnement NOMINAL — un filet de sécurité
 * utilisé comme mécanisme de conception. Un timer unique fait porter le comptage des demandes sur
 * des données du même instant, et laisse le garde-fou à son rôle de filet.
 *
 * `requestTick` est le second pilier : il coalesce les recalculs hors cycle (consigne, preset,
 * nouvelle mesure, fenêtre, mouvement, mode central). Une rafale d'événements produit UN tick,
 * jamais un par événement — c'est la parade structurelle au risque de pulsation de la chaudière
 * et à l'usure des piles des vannes (SPEC §5.5, règle 1).
 */

import type Homey from 'homey';

/** L'instance Homey passée à l'app. `@types/homey` n'exporte pas la classe directement. */
type HomeyInstance = Homey.App['homey'];

type Logger = (...args: unknown[]) => void;

/**
 * Un participant à l'ordonnancement.
 *
 * `dueAtMs()` est SYNCHRONE et ne doit rien coûter : il est interrogé à chaque battement de base,
 * pour tout le monde. Il retourne l'instant à partir duquel ce participant a quelque chose à faire
 * — `Infinity` quand il n'attend rien.
 */
export interface Tickable {
  readonly tickId: string;
  dueAtMs(): number;
  tick(nowMs: number): Promise<void>;
}

export interface SchedulerOptions {
  /** Battement de base : la ronde qui vérifie qui est dû. 30 s par défaut. */
  baseMs?: number;
  /**
   * Fenêtre de coalescence des recalculs DEMANDÉS (consigne changée, nouvelle mesure, fenêtre…).
   *
   * Distincte du battement de base, et c'est le point : confondre les deux faisait attendre
   * jusqu'à trente secondes qu'une consigne modifiée à la main produise un effet, alors que le
   * seul motif de la coalescence est d'absorber les rafales.
   *
   * Baisser cette valeur ne coûte pas d'appels réseau : `hub.refresh` a son propre plancher d'une
   * minute, et les écritures vers les appareils sont dédupliquées par seuil et par intervalle.
   * Ce qui augmente est le nombre de calculs, qui sont gratuits.
   */
  coalesceMs?: number;
  log?: Logger;
  error?: Logger;
  /** Injectable pour les essais ; `runtime/` a le droit de lire l'horloge, `lib/` non. */
  now?: () => number;
}

/**
 * Battement de base : dix secondes.
 *
 * Il était à trente, ce qui allait tant que les échéances se comptaient en minutes. Le pilotage
 * par interrupteur a changé la donne : la bascule d'un cycle est honorée au battement suivant, donc
 * une marche de 222 secondes pouvait durer jusqu'à 252 — treize pour cent de trop, envoyés dans une
 * pièce déjà à température.
 *
 * Baisser cette valeur ne coûte AUCUN appel réseau : `hub.refresh` a son propre plancher d'une
 * minute et les écritures vers les appareils sont dédupliquées par seuil et par intervalle. Ce qui
 * augmente est le nombre de calculs, qui sont gratuits — le noyau est une fonction pure sur une
 * poignée d'appareils.
 */
export const DEFAULT_BASE_MS = 10_000;

/**
 * Cinq secondes : assez pour absorber une rafale d'événements, assez court pour qu'un geste de
 * l'utilisateur paraisse immédiat. Au-delà, l'app donne l'impression de ne pas répondre.
 */
export const DEFAULT_COALESCE_MS = 5_000;

/** Au-delà, les motifs accumulés n'apprennent plus rien et ne feraient que grossir. */
const MAX_PENDING_REASONS = 20;

export class Scheduler {

  private readonly tickables = new Map<string, Tickable>();
  private readonly baseMs: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly logError: Logger;

  private intervalId: NodeJS.Timeout | null = null;
  /** Le tick différé d'une rafale de `requestTick`. Au plus un armé à la fois : c'est la coalescence. */
  private deferredId: NodeJS.Timeout | null = null;

  private running: Promise<void> | null = null;
  private lastRunAtMs = Number.NEGATIVE_INFINITY;
  private pendingReasons: string[] = [];
  private started = false;

  constructor(private readonly homey: HomeyInstance, opts: SchedulerOptions = {}) {
    this.baseMs = opts.baseMs !== undefined && opts.baseMs > 0 ? opts.baseMs : DEFAULT_BASE_MS;
    // Jamais au-dessus du battement de base : une fenêtre plus longue que la ronde n'aurait
    // aucun effet, sinon retarder ce que la ronde ferait de toute façon.
    const coalesce = opts.coalesceMs !== undefined && opts.coalesceMs > 0
      ? opts.coalesceMs
      : DEFAULT_COALESCE_MS;
    this.coalesceMs = Math.min(coalesce, this.baseMs);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => undefined);
    this.logError = opts.error ?? (() => undefined);
  }

  register(t: Tickable): void {
    this.tickables.set(t.tickId, t);
  }

  unregister(tickId: string): void {
    this.tickables.delete(tickId);
  }

  /**
   * Un tick IMMÉDIAT, puis un toutes les `baseMs`.
   *
   * `this.homey.setInterval` et jamais le `setInterval` global : le SDK détruit les siens à la
   * destruction de l'app. Un intervalle global survivrait au rechargement et deux ordonnanceurs
   * finiraient par piloter les mêmes vannes.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.intervalId = this.homey.setInterval(() => {
      void this.run('base');
    }, this.baseMs);

    void this.run('start');
  }

  /**
   * Arrête les battements. Un tick déjà en vol va jusqu'au bout : l'interrompre laisserait une
   * écriture à moitié partie vers une vanne.
   */
  stop(): void {
    this.started = false;

    if (this.intervalId !== null) {
      this.homey.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.deferredId !== null) {
      this.homey.clearTimeout(this.deferredId);
      this.deferredId = null;
    }
    this.pendingReasons = [];
  }

  /**
   * Demande un recalcul hors cycle. COALESCÉ : au plus un tick toutes les `coalesceMs`, quel que soit
   * le nombre d'appels. Ne jamais transformer ceci en « un tick par événement » — c'est exactement
   * ce que la SPEC §5.5 interdit.
   */
  requestTick(reason: string): void {
    if (!this.started) return;

    if (this.pendingReasons.length < MAX_PENDING_REASONS) {
      this.pendingReasons.push(reason);
    }
    this.armDeferred();
  }

  /** Vrai tant que l'ordonnanceur bat. Sert aux journaux de diagnostic. */
  get active(): boolean {
    return this.started;
  }

  private armDeferred(): void {
    // Déjà armé, ou un tick est en vol : la rafale est absorbée par ce qui est déjà prévu.
    if (this.deferredId !== null || this.running !== null) return;

    const waitMs = this.coalesceMs - (this.now() - this.lastRunAtMs);
    if (waitMs <= 0) {
      void this.run('request');
      return;
    }

    this.deferredId = this.homey.setTimeout(() => {
      this.deferredId = null;
      void this.run('request');
    }, waitMs);
  }

  private async run(trigger: string): Promise<void> {
    if (!this.started) return;

    // Un tick lent (réseau qui hoquette) ne doit pas en empiler un second : les deux écriraient
    // sur les mêmes vannes avec deux instantanés différents.
    if (this.running !== null) return;

    const nowMs = this.now();
    this.lastRunAtMs = nowMs;

    const reasons = this.pendingReasons;
    this.pendingReasons = [];

    // Un tick demandé par un événement force TOUT le monde : le participant qui vient de changer
    // n'est pas forcément celui dont l'échéance est atteinte.
    const forced = reasons.length > 0;
    if (forced) this.log(`Tick (${trigger}) : ${reasons.join(', ')}.`);

    this.running = this.execute(forced, nowMs).finally(() => {
      this.running = null;
      // Une demande arrivée pendant le tick n'est pas perdue : elle repart sur le battement suivant.
      if (this.pendingReasons.length > 0) this.armDeferred();
    });

    await this.running;
  }

  private async execute(forced: boolean, nowMs: number): Promise<void> {
    const due = [...this.tickables.values()].filter((t) => forced || this.isDue(t, nowMs));
    if (due.length === 0) return;

    // Isolation : un participant qui tombe n'emporte pas les autres, et surtout pas le timer.
    const results = await Promise.allSettled(due.map((t) => t.tick(nowMs)));

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logError(`Tick de ${due[index]?.tickId ?? '?'} :`, result.reason);
      }
    });
  }

  /** Une échéance illisible fait tiquer : mieux vaut réguler une fois de trop que jamais. */
  private isDue(t: Tickable, nowMs: number): boolean {
    try {
      return t.dueAtMs() <= nowMs;
    } catch {
      return true;
    }
  }
}
