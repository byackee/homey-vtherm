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
 *  2. **Les têtes dont le mode diverge sont écartées de la CONSIGNE et de la VANNE — jamais de la
 *     bascule.** Voir `applySwitch` pour la raison, qui est le contraire d'un détail. Un
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
   * Le mode du groupe est celui du PLUS GRAND NOMBRE de têtes, jamais celui d'une tête désignée.
   *
   * Une première version suivait la tête n°1, et c'était une faute : un groupe de trois vannes dont
   * seule la PREMIÈRE est ré-annoncée sans consigne basculait tout entier en tout-ou-rien, écartait
   * les deux vannes saines, et les laissait figées sur leur dernière ouverture indéfiniment. Le cas
   * symétrique — une tête quelconque qui dérive — était pourtant déjà traité. Faire dépendre le
   * groupe d'une tête particulière donnait à un seul appareil le pouvoir de geler tous les autres.
   *
   * La majorité choisit donc le mode qui garde le plus de têtes pilotables. À égalité — un groupe de
   * deux dont l'une dérive — c'est le mode à CONSIGNE qui l'emporte, et l'asymétrie est délibérée :
   * une vanne Zigbee2MQTT ré-annoncée sans sa consigne est une panne observée et transitoire, alors
   * qu'un relais qui gagnerait une consigne n'existe pas.
   */
  get mode(): EmitterWriteMode {
    const tally = new Map<EmitterWriteMode, number>();
    for (const head of this.heads) tally.set(head.mode, (tally.get(head.mode) ?? 0) + 1);

    let best = this.heads[0]!.mode;
    for (const [mode, count] of tally) {
      const bestCount = tally.get(best) ?? 0;
      if (count > bestCount) best = mode;
      // Égalité : la consigne l'emporte sur le tout-ou-rien, jamais l'inverse.
      else if (count === bestCount && best === 'switch' && mode !== 'switch') best = mode;
    }
    return best;
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
   * L'indexation porte sur la liste COMPLÈTE : le noyau a raisonné sur `headCount`, et décaler les
   * indices ici enverrait à la tête n°2 ce qui était calculé pour la n°3 — c'est-à-dire l'inverse
   * du déphasage, deux radiateurs qui tirent ensemble.
   *
   * SEULE ÉCRITURE QUI NE FILTRE PAS SUR LE MODE, et ce n'est pas un oubli.
   *
   * Écarter ici une tête au mode divergent créait un mensonge : le noyau enregistre dans sa mémoire
   * d'écriture qu'il a commandé cette tête, alors que rien n'est parti. Quand elle revient, « rien
   * n'est jamais parti » est devenu faux, l'état commandé n'a pas basculé entre-temps, et une tête
   * qui ne rapporte pas son propre état ne peut pas non plus être vue en divergence. Elle n'est
   * alors JAMAIS commandée. À puissance saturée l'état commandé ne bascule plus jamais : le relais
   * reste éteint pour toujours pendant que la tuile affiche une pièce en chauffe — exactement la
   * panne que la réaffirmation sur divergence existe pour empêcher.
   *
   * Tenter ne coûte rien : une tête sans liaison d'interrupteur rend la main sans appeler Homey, et
   * son doute n'est pas lu tant qu'elle est hors du groupe. Le filtrage par mode reste en place là
   * où une écriture pourrait faire du dégât — la consigne et l'ouverture de vanne.
   */
  async applySwitch(states: readonly (boolean | null)[], nowMs: number): Promise<void> {
    const targets: { head: EmitterAdapter; on: boolean }[] = [];
    this.heads.forEach((head, index) => {
      const on = states[index] ?? null;
      if (on !== null) targets.push({ head, on });
    });

    await this.settleItems('bascule', targets, async ({ head, on }) => {
      await head.applySwitch([on], nowMs);
    });
  }

  async pushRoomTemperature(value: number, mode: SyncMode, nowMs: number): Promise<void> {
    await this.fanOut('température de pièce', (head) => head.pushRoomTemperature(value, mode, nowMs));
  }

  // --- Lectures --------------------------------------------------------------

  /**
   * Vrai dès qu'une tête chauffe — parmi celles dont la lecture est encore valable.
   *
   * LE FILTRE SUR LA FRAÎCHEUR N'EST PAS UN DÉTAIL. Une première version prenait le OU sur TOUTES
   * les lectures tout en ne déclarant le groupe périmé que si TOUTES l'étaient : une vanne tombée
   * du réseau alors qu'elle chauffait restait éternellement à `true`, une vanne saine lisait
   * `false`, et l'agrégat rendait « ça chauffe, et c'est frais ». Le noyau l'acceptait, la demande
   * restait `active` pour toujours, et la chaudière chauffait une pièce qui ne chauffait pas.
   *
   * Une lecture fraîche, même sur une seule tête, reste une information de première main : tant
   * qu'il en existe une, elle seule décide, et `atMs` est la plus récente d'entre elles. Quand
   * toutes se sont tues, on rend leur agrégat en le disant périmé — c'est au noyau de trancher ce
   * qu'il fait d'une ignorance, pas à l'adaptateur de la déguiser.
   */
  readHeating(nowMs: number): Reading<boolean> | null {
    const readings = this.collect((head) => head.readHeating(nowMs));
    if (readings.length === 0) return null;

    const fresh = readings.filter((r) => !r.stale);
    const usable = fresh.length > 0 ? fresh : readings;

    return {
      value: usable.some((r) => r.value),
      atMs: Math.max(...usable.map((r) => r.atMs)),
      stale: fresh.length === 0,
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

  /**
   * La pire pile du groupe — parmi celles dont la lecture est encore valable.
   *
   * Le filtre a la même raison d'être que dans `readHeating`, et il rattrape ici la panne même que
   * cette version corrigeait par ailleurs : le participant ne publie que les lectures fraîches, si
   * bien qu'une seule tête muette au-delà du seuil — la plus faible, justement, puisqu'une pile qui
   * s'épuise finit par ne plus rien émettre — supprimait la tuile pour TOUT le groupe, alors que
   * les autres têtes rapportaient parfaitement.
   *
   * Quand aucune lecture n'est fraîche on rend quand même la pire, périmée : le participant s'en
   * chargera. Rendre `null` effacerait la distinction entre « aucune tête n'a de pile » et « aucune
   * ne l'a dit récemment ».
   */
  readBattery(nowMs: number): Reading<number> | null {
    const readings = this.collect((head) => head.readBattery(nowMs));
    if (readings.length === 0) return null;

    const fresh = readings.filter((r) => !r.stale);
    const usable = fresh.length > 0 ? fresh : readings;

    return usable.reduce((worst, r) => (r.value < worst.value ? r : worst));
  }

  // --- Cycle de vie ----------------------------------------------------------

  /**
   * `false` dès qu'une tête est restée figée : l'utilisateur doit savoir qu'il en reste une.
   *
   * TOUTES les têtes, écartées comprises, et pour le mot près la raison écrite sous
   * `restoreSafeState` : une tête sortie du groupe est justement celle qu'on risque de laisser
   * ouverte pour toujours. Le filtre `participating()` était doublement fautif ici — la tête
   * divergente n'était pas libérée, ET son absence du `every()` faisait rendre `true`, donc
   * `valveStuck` restait faux et l'avertissement « vanne figée » ne partait pas. La dorsale tombait,
   * une vanne restait ouverte, et rien ne le disait.
   */
  async releaseValve(nowMs: number): Promise<boolean> {
    const results = await Promise.all(
      this.heads.map(async (head) => {
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
    await this.settleItems(label, heads.map((head) => ({ head })), ({ head }) => run(head));
  }

  /**
   * Tente sur tous les éléments, puis relaie la PREMIÈRE erreur.
   *
   * Par ÉLÉMENT et non par tête : une commande de bascule porte un état propre à chaque tête, et
   * retrouver cet état depuis la tête obligerait à chercher par identité d'objet dans la liste —
   * une correspondance qui devient fausse à la première tête présente deux fois.
   *
   * Relayer plutôt qu'avaler : `runtime/participants.mts` enveloppe chaque écriture dans son propre
   * `safely`, qui journalise. Avaler ici rendrait une écriture ratée totalement silencieuse.
   */
  private async settleItems<T extends { head: EmitterAdapter }>(
    label: string,
    items: readonly T[],
    run: (item: T) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(items.map(async (item) => run(item)));

    let first: unknown = null;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i]!;
      if (result.status !== 'rejected') continue;
      this.logError(`${label} sur ${items[i]!.head.deviceId} :`, result.reason);
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
