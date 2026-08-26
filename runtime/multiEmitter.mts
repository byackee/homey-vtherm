/**
 * `runtime/multiEmitter.mts` — plusieurs têtes derrière un seul thermostat.
 *
 * Une pièce a souvent deux ou trois émetteurs : deux radiateurs sous deux fenêtres, un convecteur
 * de chaque côté d'un séjour traversant. Ils partagent une température, une consigne et un preset ;
 * seul le nombre de vannes change. Créer un thermostat par radiateur marche, mais envoie autant de
 * demandes distinctes à l'agrégateur de chaudière pour une seule pièce, et laisse l'utilisateur
 * avec deux tuiles de consigne qui peuvent diverger.
 *
 * Cette classe résout ça sans déplacer la moindre décision : elle IMPLÉMENTE `EmitterAdapter` et
 * diffuse vers N adaptateurs réels. `lib/step.mts` continue de raisonner sur LA PIÈCE — une
 * température, une consigne, un preset. Le nombre de têtes n'y entre que pour le découpage
 * temporel, seule décision qui doive produire une commande différente par tête (déphasage, voir
 * `lib/dutyCycle.mts`).
 *
 * Trois règles de ce fichier ne se négocient pas :
 *
 *  1. **Une écriture est tentée sur TOUTES les têtes, même si l'une échoue.** Un `Promise.all` nu
 *     abandonne les têtes restantes au premier rejet : un radiateur injoignable laisserait les
 *     autres à leur position précédente, et la pièce se réglerait sur une fraction de sa puissance
 *     sans que rien ne le dise. On tente tout, puis on relaie la première erreur.
 *  2. **Les têtes dont le mode diverge sont ÉCARTÉES des écritures, pas ignorées en silence.** Un
 *     appareil Zigbee2MQTT ré-annoncé peut revenir sans sa consigne, donc en mode `switch` dans un
 *     groupe de vannes. Lui envoyer une bascule échouerait à chaque pas, et son doute
 *     (`switchUnconfirmed`) rendrait la demande `unknown` pour toujours : la chaudière resterait
 *     éteinte pour toute la pièce à cause d'une seule tête. Elle est donc retirée du groupe tant
 *     qu'elle ne revient pas, et `mismatchedHeadIds` la nomme pour que l'appareil l'affiche.
 *  3. **`readHeating` est un OU, `readBattery` un minimum.** L'un répond « cette pièce est-elle en
 *     train d'être chauffée », et une seule tête suffit. L'autre alimente une tuile dont l'unique
 *     raison d'être est de prévenir avant la panne : c'est la pire pile qui compte, pas la moyenne,
 *     qu'une tête neuve rendrait rassurante jusqu'au jour où l'autre s'arrête.
 */

import type { Reading, SyncMode } from '../lib/types.mjs';
import type { ValveBackend } from './valveBackend.mjs';
import type { EmitterAdapter, EmitterCapabilities, EmitterWriteMode } from './emitter.mjs';

type Logger = (...args: unknown[]) => void;

export interface MultiEmitterOptions {
  /** Au moins une. La PREMIÈRE est la tête de référence : c'est son mode qui fait celui du groupe. */
  heads: readonly EmitterAdapter[];
  log?: Logger;
  error?: Logger;
}

export class MultiEmitterAdapter implements EmitterAdapter {

  private readonly heads: readonly EmitterAdapter[];
  private readonly log: Logger;
  private readonly logError: Logger;

  /** Têtes déjà signalées comme divergentes : le journal doit dire l'événement, pas le battement. */
  private readonly warned = new Set<string>();

  constructor(options: MultiEmitterOptions) {
    if (options.heads.length === 0) {
      // Un groupe vide n'a pas d'état sûr : il n'y a pas de tête de référence dont lire le mode, et
      // toutes les lectures rendraient `null` — c'est-à-dire « je ne sais pas » là où la vérité est
      // « il n'y a rien ». L'appelant doit avoir marqué l'appareil indisponible bien avant.
      throw new Error('MultiEmitterAdapter : au moins une tête est requise.');
    }
    this.heads = options.heads;
    this.log = options.log ?? (() => undefined);
    this.logError = options.error ?? (() => undefined);
  }

  // --- Identité et état ------------------------------------------------------

  /**
   * L'identifiant de la tête de référence.
   *
   * `EmitterAdapter` en expose un seul et rien hors de l'adaptateur ne le lit aujourd'hui — il sert
   * aux messages de journal. Rendre celui de la tête de référence est le choix le moins trompeur :
   * inventer un identifiant de groupe ferait apparaître dans les logs une chose qui n'existe pas
   * côté Homey.
   */
  get deviceId(): string {
    return this.heads[0]!.deviceId;
  }

  /** Les identifiants de toutes les têtes, dans l'ordre d'appairage. */
  get headIds(): readonly string[] {
    return this.heads.map((head) => head.deviceId);
  }

  /**
   * Le mode du groupe est celui de la tête de référence.
   *
   * Pas un vote majoritaire : la branche entière de `lib/step.mts` en dépend, et une majorité qui
   * bascule ferait passer une pièce du découpage temporel au pilotage d'ouverture en cours de
   * cycle. L'appairage impose des têtes homogènes ; ceci n'est que le comportement en cas de
   * dérive constatée après coup.
   */
  get mode(): EmitterWriteMode {
    return this.heads[0]!.mode;
  }

  /** Les têtes qui ne sont pas dans le mode du groupe, et qui ne reçoivent donc plus rien. */
  get mismatchedHeadIds(): readonly string[] {
    const mode = this.mode;
    return this.heads.filter((head) => head.mode !== mode).map((head) => head.deviceId);
  }

  /** Une seule tête joignable suffit à chauffer, même mal : le groupe reste utilisable. */
  get available(): boolean {
    return this.heads.some((head) => head.available);
  }

  get caps(): EmitterCapabilities {
    // Union : la capacité du groupe est ce qu'au moins une tête sait faire. Personne ne la lit hors
    // de l'adaptateur, mais une intersection décrirait un groupe plus pauvre que la réalité.
    const heads = this.participating();
    return {
      setpoint: heads.some((h) => h.caps.setpoint),
      valve: heads.some((h) => h.caps.valve),
      externalTemp: heads.some((h) => h.caps.externalTemp),
      calibration: heads.some((h) => h.caps.calibration),
      heatingState: heads.some((h) => h.caps.heatingState),
      switch: heads.some((h) => h.caps.switch),
    };
  }

  /**
   * Un doute sur UNE tête est un doute sur le groupe.
   *
   * C'est volontairement pessimiste, et c'est la même intention que sur une tête seule : la demande
   * passe `unknown`, et l'agrégateur laisse la chaudière éteinte plutôt que de la faire tourner sur
   * un circuit dont on ne sait pas s'il consomme.
   */
  get valveUnconfirmed(): boolean {
    return this.participating().some((head) => head.valveUnconfirmed);
  }

  get switchUnconfirmed(): boolean {
    return this.participating().some((head) => head.switchUnconfirmed);
  }

  // --- Écritures -------------------------------------------------------------

  async applySetpoint(value: number, nowMs: number): Promise<void> {
    await this.fanOut('consigne', (head) => head.applySetpoint(value, nowMs));
  }

  async applyValve(percent: number, nowMs: number): Promise<void> {
    await this.fanOut('ouverture de vanne', (head) => head.applyValve(percent, nowMs));
  }

  /**
   * Chaque tête reçoit SON état, pas celui du groupe.
   *
   * L'indexation porte sur la liste COMPLÈTE, têtes écartées comprises : le noyau a raisonné sur
   * `headCount`, et décaler les indices ici enverrait à la tête n°2 ce qui était calculé pour la
   * n°3 — c'est-à-dire l'inverse du déphasage, deux radiateurs qui tirent ensemble.
   */
  async applySwitch(states: readonly (boolean | null)[], nowMs: number): Promise<void> {
    const mode = this.mode;
    const targets = this.heads
      .map((head, index) => ({ head, on: states[index] ?? null }))
      .filter((entry) => entry.on !== null && entry.head.mode === mode);

    await this.settleAll(
      'bascule',
      targets.map((entry) => entry.head),
      async (head) => {
        const entry = targets.find((t) => t.head === head)!;
        await head.applySwitch([entry.on], nowMs);
      },
    );
  }

  async pushRoomTemperature(value: number, mode: SyncMode, nowMs: number): Promise<void> {
    await this.fanOut('température de pièce', (head) => head.pushRoomTemperature(value, mode, nowMs));
  }

  // --- Lectures --------------------------------------------------------------

  /**
   * Vrai dès qu'une tête chauffe.
   *
   * `stale` n'est vrai que si TOUTES les lectures le sont : une lecture fraîche, même sur une seule
   * tête, est une information de première main sur la pièce. `atMs` est la plus récente, pour la
   * même raison — dater le groupe sur la tête la plus muette ferait périmer une information qu'on
   * vient d'obtenir.
   */
  readHeating(nowMs: number): Reading<boolean> | null {
    const readings = this.collect((head) => head.readHeating(nowMs));
    if (readings.length === 0) return null;

    return {
      value: readings.some((r) => r.value),
      atMs: Math.max(...readings.map((r) => r.atMs)),
      stale: readings.every((r) => r.stale),
    };
  }

  get headCount(): number {
    // La liste COMPLÈTE : c'est la longueur sur laquelle le noyau indexe ses commandes. La réduire
    // aux têtes qui participent décalerait les indices dès qu'une tête sort du groupe.
    return this.heads.length;
  }

  /**
   * L'état de chaque tête, aligné sur `headCount`.
   *
   * Une tête écartée rend `null` : on ne détecte pas de divergence sur un appareil auquel on
   * n'envoie plus rien — ce serait une divergence permanente, donc une réécriture perpétuelle.
   */
  readHeatingHeads(nowMs: number): readonly (Reading<boolean> | null)[] {
    const mode = this.mode;
    return this.heads.map((head) => (head.mode === mode ? head.readHeating(nowMs) : null));
  }

  /** La pire pile du groupe, telle quelle : c'est elle qui décidera de la prochaine intervention. */
  readBattery(nowMs: number): Reading<number> | null {
    const readings = this.collect((head) => head.readBattery(nowMs));
    if (readings.length === 0) return null;

    return readings.reduce((worst, r) => (r.value < worst.value ? r : worst));
  }

  // --- Cycle de vie ----------------------------------------------------------

  /** `false` dès qu'une tête est restée figée : l'utilisateur doit savoir qu'il en reste une. */
  async releaseValve(nowMs: number): Promise<boolean> {
    const results = await Promise.all(
      this.participating().map(async (head) => {
        try {
          return await head.releaseValve(nowMs);
        } catch (err) {
          this.logError(`Libération de la vanne ${head.deviceId} :`, err);
          return false;
        }
      }),
    );
    return results.every((released) => released);
  }

  /**
   * Ne lève jamais, et n'écarte AUCUNE tête.
   *
   * Une sortie propre doit aller au bout : une tête écartée pour divergence de mode est justement
   * celle qu'on risque de laisser ouverte pour toujours si on ne la remet pas en état ici.
   */
  async restoreSafeState(userSetpoint: number): Promise<void> {
    await Promise.all(this.heads.map(async (head) => {
      try {
        await head.restoreSafeState(userSetpoint);
      } catch (err) {
        this.logError(`Remise en état sûr de ${head.deviceId} :`, err);
      }
    }));
  }

  /**
   * Toutes les têtes, y compris celles qui divergent : c'est cette détection qui les fait revenir.
   *
   * Les écarter ici les condamnerait — leur mode ne serait plus jamais relu, donc jamais réaligné.
   */
  async detect(nowMs: number): Promise<void> {
    await this.fanOutAll('détection', (head) => head.detect(nowMs));
    this.reportMismatch();
  }

  invalidateDetection(): void {
    for (const head of this.heads) head.invalidateDetection();
  }

  detectionDue(nowMs: number): boolean {
    return this.heads.some((head) => head.detectionDue(nowMs));
  }

  setBackend(backend: ValveBackend | null): void {
    for (const head of this.heads) head.setBackend(backend);
  }

  destroy(): void {
    for (const head of this.heads) head.destroy();
  }

  // --- Internes --------------------------------------------------------------

  /** Les têtes qui reçoivent réellement les commandes : celles du mode du groupe. */
  private participating(): readonly EmitterAdapter[] {
    const mode = this.mode;
    const kept = this.heads.filter((head) => head.mode === mode);
    // La tête de référence définit le mode : elle en fait toujours partie, ce filtre ne peut pas
    // rendre une liste vide. L'invariant est écrit ici parce que tout le reste du fichier s'y fie.
    return kept;
  }

  private collect<T>(read: (head: EmitterAdapter) => Reading<T> | null): Reading<T>[] {
    const out: Reading<T>[] = [];
    for (const head of this.participating()) {
      const reading = read(head);
      if (reading !== null) out.push(reading);
    }
    return out;
  }

  private async fanOut(label: string, run: (head: EmitterAdapter) => Promise<void>): Promise<void> {
    await this.settleAll(label, this.participating(), run);
  }

  private async fanOutAll(label: string, run: (head: EmitterAdapter) => Promise<void>): Promise<void> {
    await this.settleAll(label, this.heads, run);
  }

  /**
   * Tente sur toutes les têtes, puis relaie la PREMIÈRE erreur.
   *
   * Relayer plutôt qu'avaler : `runtime/participants.mts` enveloppe chaque écriture dans son propre
   * `safely`, qui journalise. Avaler ici rendrait une écriture ratée totalement silencieuse.
   */
  private async settleAll(
    label: string,
    heads: readonly EmitterAdapter[],
    run: (head: EmitterAdapter) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(heads.map(async (head) => run(head)));

    let first: unknown = null;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i]!;
      if (result.status !== 'rejected') continue;
      this.logError(`${label} sur ${heads[i]!.deviceId} :`, result.reason);
      if (first === null) first = result.reason;
    }

    if (first !== null) throw first instanceof Error ? first : new Error(String(first));
  }

  /** Une ligne de journal quand une tête sort du groupe ou y revient, jamais à chaque pas. */
  private reportMismatch(): void {
    const mismatched = new Set(this.mismatchedHeadIds);

    for (const id of mismatched) {
      if (this.warned.has(id)) continue;
      this.warned.add(id);
      this.log(
        `Émetteur ${id} : mode différent du groupe (${this.mode}) — écarté des commandes tant `
        + 'qu\'il n\'est pas revenu.',
      );
    }

    for (const id of [...this.warned]) {
      if (mismatched.has(id)) continue;
      this.warned.delete(id);
      this.log(`Émetteur ${id} : revenu dans le mode du groupe (${this.mode}).`);
    }
  }
}
