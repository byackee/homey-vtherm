/**
 * `runtime/participants.mts` — l'adhérence entre les appareils Homey et le noyau.
 *
 * Un participant ne décide rien. Il lit le monde par le hub, compose un `VThermInputs`, appelle
 * `stepVTherm`, puis exécute ce que le réducteur a décidé : capabilities, écritures vers
 * l'émetteur, déclencheurs Flow, avertissement, état durable. Toute décision qui se prend ici
 * plutôt que dans `lib/` est une décision qu'aucun test ne couvre — `tsconfig.test.json` ne compile
 * pas ce répertoire.
 *
 * Les participants ne savent rien de Homey au-delà de `DeviceHost` : c'est ce qui permet de les
 * instancier depuis un `device.mts` du lot suivant sans les y enfermer.
 */

import type {
  CentralMode, Demand, Preset, Reading, SyncMode, VThermConfig, VThermEvent,
  VThermInputs, VThermOutputs, VThermState, VThermStateDefaults,
} from '../lib/types.mjs';
import type { BoilerParams, BoilerState } from '../lib/types.mjs';
import {
  SETPOINT_MAX, SETPOINT_MIN, STALE_MEASUREMENT_SEC,
  TIMED_PRESET_MAX_MINUTES, TIMED_PRESET_MIN_MINUTES,
} from '../lib/constants.mjs';
import { createBoilerState, stepBoiler } from '../lib/boilerAggregator.mjs';
import { restoreVThermState } from '../lib/state.mjs';
import { stepVTherm } from '../lib/step.mjs';
import type { CapValue, SourceBinding } from './hub.mjs';
import type { EmitterAdapter } from './emitter.mjs';
import type { Tickable } from './scheduler.mjs';
import type { ValveBackend } from './valveBackend.mjs';

const MS_PER_MINUTE = 60_000;

/**
 * Seuils de fraîcheur, PAR NATURE DE SOURCE et jamais globaux (SPEC §1.1, PLAN lot 2 point 7).
 *
 * Un capteur de température dans une pièce stable se tait légitimement vingt minutes ; un contact
 * de fenêtre reste muet des jours entiers. Un seuil unique rendrait l'un hystérique et l'autre
 * aveugle. Rassemblés ici pour qu'il n'y ait qu'un seul endroit à modifier.
 *
 * Rappel : la fraîcheur vient de `capabilitiesObj[id].lastUpdated`. `last_seen` vaut `None` sur
 * l'installation de référence et n'a jamais été mis à jour — c'est un piège, pas une source.
 */
export const FRESHNESS = {
  /** ~1 h. Au-delà, plus aucune demande de chaleur : c'est le repli le plus strict de la table. */
  roomTempMs: STALE_MEASUREMENT_SEC * 1000,
  /** ~2 h. Non bloquant : le terme `coefExt` du TPI passe simplement à 0. */
  outdoorTempMs: 2 * 60 * MS_PER_MINUTE,
  /** ~7 jours. Un contact qui ne bouge pas n'émet rien ; un « ouvert » périmé gèlerait le logement. */
  windowContactMs: 7 * 24 * 60 * MS_PER_MINUTE,
  motionMs: 2 * 60 * MS_PER_MINUTE,
  presenceMs: 2 * 60 * MS_PER_MINUTE,
  /** ~2 h. Sans lui, la demande de chaleur en mode consigne devient `unknown` (chaudière OFF). */
  emitterHeatingMs: 2 * 60 * MS_PER_MINUTE,
  /** Une pile ne se rapporte que rarement ; l'afficher périmée n'apporterait rien. */
  emitterBatteryMs: 24 * 60 * MS_PER_MINUTE,
  emitterLocalTempMs: 2 * 60 * MS_PER_MINUTE,
} as const;

/**
 * Écriture de l'état durable : au plus toutes les 5 minutes (usure de la mémoire flash),
 * mais IMMÉDIATE sur un changement de preset, de consigne ou de preset temporisé — ce sont
 * précisément les choix de l'utilisateur, ceux qu'un redémarrage ne doit pas perdre.
 */
const PERSIST_INTERVAL_MS = 5 * MS_PER_MINUTE;

const VTHERM_STORE_KEY = 'vtherm.state';
const BOILER_STORE_KEY = 'central.boiler';

// ---------------------------------------------------------------------------
// Contrat avec l'appareil Homey
// ---------------------------------------------------------------------------

export type CentralEvent =
  | { kind: 'boiler_started'; nbActive: number }
  | { kind: 'boiler_stopped' };

export type ParticipantEvent = VThermEvent | CentralEvent;

/**
 * Tout ce qu'un participant attend de son appareil Homey. Un `Homey.Device` l'implémente en une
 * douzaine de lignes ; un faux appareil de test aussi, ce qui est le point.
 */
export interface DeviceHost {
  readonly id: string;
  getCapabilityValue(capabilityId: string): CapValue | null;
  setCapabilityValue(capabilityId: string, value: CapValue): Promise<void>;
  setWarning(message: string | null): Promise<void>;
  getStoreValue(key: string): unknown;
  setStoreValue(key: string, value: unknown): Promise<void>;
  triggerFlow(event: ParticipantEvent): Promise<void>;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface VThermSourceBindings {
  room: SourceBinding | null;
  outdoor: SourceBinding | null;
  windowContact: SourceBinding | null;
  motion: SourceBinding | null;
  presence: SourceBinding | null;
}

/** Forçage de présence par carte Flow (SPEC §10). `auto` rend la main au capteur. */
export type PresenceOverride = 'auto' | 'home' | 'away';

export interface VThermParticipantOptions {
  host: DeviceHost;
  emitter: EmitterAdapter;
  sources: VThermSourceBindings;
  config: VThermConfig;
  syncMode: SyncMode;
  /** SPEC §9.2 : seuls les VTherm marqués « commande la chaudière » sont comptés. */
  controlsBoiler: boolean;
  centralMode: () => CentralMode;
  requestTick: (reason: string) => void;
  defaults: VThermStateDefaults;
  nowMs: number;
}

// ---------------------------------------------------------------------------
// Lectures typées
// ---------------------------------------------------------------------------

function readNumber(
  binding: SourceBinding | null,
  nowMs: number,
  freshnessMs: number,
): Reading<number> | null {
  if (binding === null) return null;

  const reading = binding.read(nowMs, freshnessMs);
  if (reading === null || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) {
    return null;
  }
  return { value: reading.value, atMs: reading.atMs, stale: reading.stale };
}

function readBoolean(
  binding: SourceBinding | null,
  nowMs: number,
  freshnessMs: number,
): Reading<boolean> | null {
  if (binding === null) return null;

  const reading = binding.read(nowMs, freshnessMs);
  if (reading === null) return null;

  // Un capteur d'ouverture Homey rapporte un booléen ; certains ponts publient 0/1. Tout le reste
  // n'est pas interprétable, et une lecture non interprétable est une lecture absente.
  let value: boolean;
  if (typeof reading.value === 'boolean') value = reading.value;
  else if (typeof reading.value === 'number') value = reading.value !== 0;
  else return null;

  return { value, atMs: reading.atMs, stale: reading.stale };
}

// ---------------------------------------------------------------------------
// VTherm
// ---------------------------------------------------------------------------

export class VThermParticipant implements Tickable {

  readonly tickId: string;

  private readonly host: DeviceHost;
  private readonly emitter: EmitterAdapter;
  private readonly sources: VThermSourceBindings;
  private readonly centralMode: () => CentralMode;
  private readonly requestTick: (reason: string) => void;

  private config: VThermConfig;
  private syncMode: SyncMode;
  private controlsBoilerFlag: boolean;

  private state: VThermState;

  private demandValue: Demand = { kind: 'unknown' };
  private wakeUpAt: number | null = null;
  private lastTickAtMs: number | null = null;

  private lastPersistAtMs: number;
  private persistedPreset: Preset;
  private persistedManualSetpoint: number;
  private persistedTimedUntil: number | null;

  /** Consigne CHOISIE au dernier pas, celle qu'exige la remise en état sûr (SPEC §11.1). */
  private userSetpoint: number;

  private windowBypass = false;
  private presenceOverride: PresenceOverride = 'auto';

  /** Ce qui a réellement été poussé sur les capabilities, pour ne pas réécrire à l'identique. */
  private readonly publishedCaps = new Map<string, CapValue>();
  private publishedWarning: string | null = null;

  constructor(options: VThermParticipantOptions) {
    this.tickId = options.host.id;
    this.host = options.host;
    this.emitter = options.emitter;
    this.sources = options.sources;
    this.centralMode = options.centralMode;
    this.requestTick = options.requestTick;
    this.config = options.config;
    this.syncMode = options.syncMode;
    this.controlsBoilerFlag = options.controlsBoiler;

    this.state = restoreVThermState(
      options.host.getStoreValue(VTHERM_STORE_KEY),
      options.nowMs,
      options.defaults,
    );

    const persistent = this.state.persistent;
    this.lastPersistAtMs = options.nowMs;
    this.persistedPreset = persistent.preset;
    this.persistedManualSetpoint = persistent.manualSetpoint;
    this.persistedTimedUntil = persistent.timedPreset?.untilMs ?? null;
    this.userSetpoint = persistent.manualSetpoint;
  }

  // --- Contrat d'ordonnancement --------------------------------------------

  /**
   * Échéance annoncée : le `wakeUpAtMs` du noyau (délais fenêtre, mouvement, preset temporisé),
   * borné par `cycle_min`. Le noyau n'arme aucune minuterie ; il dit quand sa décision changera.
   */
  dueAtMs(): number {
    if (this.lastTickAtMs === null) return Number.NEGATIVE_INFINITY;

    const cycleDue = this.lastTickAtMs + this.config.cycleMin * MS_PER_MINUTE;
    return this.wakeUpAt === null ? cycleDue : Math.min(cycleDue, this.wakeUpAt);
  }

  /** La demande du DERNIER pas abouti. `unknown` tant que le pas courant n'a pas rendu sa décision. */
  get demand(): Demand {
    return this.demandValue;
  }

  get controlsBoiler(): boolean {
    return this.controlsBoilerFlag;
  }

  async tick(nowMs: number): Promise<void> {
    // Remise à `unknown` D'ABORD : si ce pas échoue ou expire, l'agrégateur ne doit pas compter
    // une demande périmée. Une chaudière ne s'allume jamais sur de l'inconnu (PLAN lot 2).
    this.demandValue = { kind: 'unknown' };
    this.lastTickAtMs = nowMs;

    // La détection du mode se rejoue : un device Z2M ré-annoncé peut avoir changé de capabilities.
    if (this.emitter.detectionDue(nowMs)) {
      try {
        await this.emitter.detect(nowMs);
      } catch (err) {
        this.host.error('Détection des capabilities de l\'émetteur :', err);
      }
    }

    const roomTemp = readNumber(this.sources.room, nowMs, FRESHNESS.roomTempMs);
    const inputs = this.collectInputs(roomTemp, nowMs);

    const { outputs, nextState } = stepVTherm(this.state, inputs, this.config, nowMs);
    this.state = nextState;
    this.wakeUpAt = outputs.wakeUpAtMs;
    this.demandValue = outputs.demand;

    const target = outputs.capabilities.target_temperature;
    if (typeof target === 'number') this.userSetpoint = target;

    await this.applyOutputs(outputs, roomTemp, nowMs);
    await this.persistIfNeeded(nowMs);
  }

  private collectInputs(roomTemp: Reading<number> | null, nowMs: number): VThermInputs {
    const onoff = this.host.getCapabilityValue('onoff');

    return {
      roomTemp,
      outdoorTemp: readNumber(this.sources.outdoor, nowMs, FRESHNESS.outdoorTempMs),
      windowContact: readBoolean(this.sources.windowContact, nowMs, FRESHNESS.windowContactMs),
      motion: readBoolean(this.sources.motion, nowMs, FRESHNESS.motionMs),
      presence: this.resolvePresence(nowMs),
      emitterHeating: this.emitter.readHeating(nowMs),
      emitterMode: this.emitter.mode,
      centralMode: this.centralMode(),
      // Capability absente au tout premier pas : un thermostat neuf est allumé.
      onoff: typeof onoff === 'boolean' ? onoff : true,
      windowBypass: this.windowBypass,
    };
  }

  /** Le forçage Flow prime sur le capteur, et n'est jamais périmé : c'est une décision explicite. */
  private resolvePresence(nowMs: number): Reading<boolean> | null {
    if (this.presenceOverride !== 'auto') {
      return { value: this.presenceOverride === 'home', atMs: nowMs, stale: false };
    }
    return readBoolean(this.sources.presence, nowMs, FRESHNESS.presenceMs);
  }

  // --- Application des sorties ----------------------------------------------

  private async applyOutputs(
    outputs: VThermOutputs,
    roomTemp: Reading<number> | null,
    nowMs: number,
  ): Promise<void> {
    // Une clé ABSENTE de `outputs.capabilities` signifie « non calculable à ce pas » : la
    // capability garde sa valeur. C'est le gel de sortie sur capteur muet — publier un 0 de
    // remplacement mentirait à l'utilisateur et fausserait durablement les Insights.
    for (const [capabilityId, value] of Object.entries(outputs.capabilities)) {
      await this.publish(capabilityId, value);
    }

    const battery = this.emitter.readBattery(nowMs);
    if (battery !== null && !battery.stale) {
      // Volontairement PAS `measure_battery` : cette pile est celle de l'émetteur d'une autre app,
      // pas de notre appareil virtuel. La déclarer en `measure_battery` obligerait à annoncer un
      // `energy.batteries` — c'est-à-dire à affirmer que ce thermostat contient des piles, ce qui
      // est faux et fausserait le bilan énergétique de Homey.
      await this.publish('vtherm_emitter_battery', battery.value);
    }

    // L'ouverture d'abord : en contrôle direct de vanne c'est elle qui commande, la consigne
    // brute qui suit ne sert qu'à l'affichage de l'émetteur (SPEC §3, étape 4).
    const valvePercent = outputs.valvePercent;
    if (valvePercent !== null) {
      await this.safely('écriture de l\'ouverture de vanne', () =>
        this.emitter.applyValve(valvePercent, nowMs));
    }
    const setpointToEmitter = outputs.setpointToEmitter;
    if (setpointToEmitter !== null) {
      await this.safely('écriture de la consigne', () =>
        this.emitter.applySetpoint(setpointToEmitter, nowMs));
    }

    // SPEC §5.3 : la synchronisation part à chaque nouvelle mesure, indépendamment de la
    // régulation, mais reste soumise aux seuils de l'émetteur — ces vannes sont sur piles.
    if (roomTemp !== null && !roomTemp.stale) {
      await this.safely('synchronisation de la température de pièce', () =>
        this.emitter.pushRoomTemperature(roomTemp.value, this.syncMode, nowMs));
    }

    for (const event of outputs.events) {
      await this.safely(`déclencheur ${event.kind}`, () => this.host.triggerFlow(event));
    }

    if (outputs.warning !== this.publishedWarning) {
      this.publishedWarning = outputs.warning;
      await this.safely('avertissement', () => this.host.setWarning(outputs.warning));
    }
  }

  private async publish(capabilityId: string, value: CapValue): Promise<void> {
    if (this.publishedCaps.get(capabilityId) === value) return;

    try {
      await this.host.setCapabilityValue(capabilityId, value);
      this.publishedCaps.set(capabilityId, value);
    } catch (err) {
      // Non mémorisé : la prochaine tentative doit réessayer, sinon une capability qui a échoué
      // une fois resterait figée pour toute la durée de vie de l'app.
      this.host.error(`Publication de ${capabilityId} :`, err);
    }
  }

  private async safely(label: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.host.error(`${label} :`, err);
    }
  }

  // --- Persistance ----------------------------------------------------------

  private async persistIfNeeded(nowMs: number): Promise<void> {
    const persistent = this.state.persistent;
    const timedUntil = persistent.timedPreset?.untilMs ?? null;

    const userChoiceChanged = persistent.preset !== this.persistedPreset
      || persistent.manualSetpoint !== this.persistedManualSetpoint
      || timedUntil !== this.persistedTimedUntil;

    if (!userChoiceChanged && nowMs - this.lastPersistAtMs < PERSIST_INTERVAL_MS) return;

    try {
      await this.host.setStoreValue(VTHERM_STORE_KEY, persistent);
      this.lastPersistAtMs = nowMs;
      this.persistedPreset = persistent.preset;
      this.persistedManualSetpoint = persistent.manualSetpoint;
      this.persistedTimedUntil = timedUntil;
    } catch (err) {
      this.host.error('Écriture de l\'état durable :', err);
    }
  }

  // --- Mutations (cartes Flow, interface, réglages) --------------------------
  //
  // L'état durable appartient au participant : le laisser modifier de l'extérieur produirait deux
  // vérités. Chaque mutation demande un recalcul, que l'ordonnanceur coalesce.

  setPreset(preset: Preset): void {
    // Un choix manuel annule le preset temporisé : les deux en même temps rendraient la consigne
    // inexplicable dans l'interface.
    this.mutate({ preset, timedPreset: null }, 'preset');
  }

  setManualSetpoint(setpoint: number): void {
    if (!Number.isFinite(setpoint)) return;
    const value = Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, setpoint));
    this.mutate({ preset: 'none', manualSetpoint: value, timedPreset: null }, 'setpoint');
  }

  setTimedPreset(preset: Preset, minutes: number, nowMs: number): void {
    const bounded = Math.min(TIMED_PRESET_MAX_MINUTES, Math.max(TIMED_PRESET_MIN_MINUTES, Math.round(minutes)));
    const previous = this.state.persistent.timedPreset?.previous ?? this.state.persistent.preset;
    this.mutate({
      timedPreset: { preset, untilMs: nowMs + bounded * MS_PER_MINUTE, previous },
    }, 'timed-preset');
  }

  cancelTimedPreset(): void {
    const timed = this.state.persistent.timedPreset;
    if (timed === null) return;
    this.mutate({ preset: timed.previous, timedPreset: null }, 'cancel-timed-preset');
  }

  setWindowBypass(bypass: boolean): void {
    this.windowBypass = bypass;
    this.requestTick('window-bypass');
  }

  forcePresence(override: PresenceOverride): void {
    this.presenceOverride = override;
    this.requestTick('presence');
  }

  updateConfig(config: VThermConfig): void {
    this.config = config;
    this.requestTick('settings');
  }

  setSyncMode(mode: SyncMode): void {
    this.syncMode = mode;
    this.requestTick('sync-mode');
  }

  setControlsBoiler(controls: boolean): void {
    this.controlsBoilerFlag = controls;
    this.requestTick('controls-boiler');
  }

  setValveBackend(backend: ValveBackend | null): void {
    this.emitter.setBackend(backend);
    this.requestTick('valve-backend');
  }

  /** Un ré-abonnement a eu lieu : le jeu de capabilities de l'émetteur est peut-être différent. */
  invalidateEmitterDetection(): void {
    this.emitter.invalidateDetection();
  }

  private mutate(
    patch: Partial<VThermState['persistent']>,
    reason: string,
  ): void {
    this.state = {
      persistent: { ...this.state.persistent, ...patch },
      volatile: this.state.volatile,
    };
    this.requestTick(reason);
  }

  // --- Cycle de vie ---------------------------------------------------------

  /** SPEC §11.1. Appelé depuis `onDeleted` et `onUninit`, avant que le hub ne ferme. */
  async restoreSafeState(): Promise<void> {
    await this.emitter.restoreSafeState(this.userSetpoint);
  }

  destroy(): void {
    this.emitter.destroy();
    for (const binding of Object.values(this.sources)) {
      binding?.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration centrale et chaudière
// ---------------------------------------------------------------------------

export interface CentralParticipantOptions {
  host: DeviceHost;
  /** Liaison `onoff` du relais de chaudière. `null` quand aucune chaudière n'est pilotée. */
  boiler: SourceBinding | null;
  params: BoilerParams;
  mode: CentralMode;
  requestTick: (reason: string) => void;
  nowMs: number;
}

export class CentralParticipant {

  private readonly host: DeviceHost;
  private readonly requestTick: (reason: string) => void;

  private boiler: SourceBinding | null;
  private params: BoilerParams;
  private centralMode: CentralMode;
  private boilerState: BoilerState;

  constructor(options: CentralParticipantOptions) {
    this.host = options.host;
    this.boiler = options.boiler;
    this.params = options.params;
    this.centralMode = options.mode;
    this.requestTick = options.requestTick;

    // SPEC §9.2 : sans relecture, un redémarrage d'app remettrait le garde-fou de 60 s à zéro —
    // et deux allumages à une seconde d'intervalle sont exactement la panne qu'il existe pour
    // empêcher.
    this.boilerState = restoreBoilerState(options.host.getStoreValue(BOILER_STORE_KEY), options.nowMs);
  }

  get mode(): CentralMode {
    return this.centralMode;
  }

  setMode(mode: CentralMode): void {
    if (mode === this.centralMode) return;
    this.centralMode = mode;
    this.requestTick('central-mode');
  }

  updateParams(params: BoilerParams): void {
    this.params = params;
    this.requestTick('boiler-settings');
  }

  setBoilerBinding(binding: SourceBinding | null): void {
    this.boiler?.destroy();
    this.boiler = binding;
  }

  /** Délai d'activation en cours, ou prochain keep-alive. `Infinity` quand rien n'attend. */
  dueAtMs(): number {
    const state = this.boilerState;

    if (state.pendingSinceMs !== null) {
      return state.pendingSinceMs + this.params.activationDelaySec * 1000;
    }
    if (state.commanded && this.params.keepAliveSec > 0) {
      const baseline = state.lastKeepAliveMs ?? state.lastChangeMs;
      if (baseline !== null) return baseline + this.params.keepAliveSec * 1000;
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * UNE seule commande chaudière par tick, sur un instantané cohérent des demandes.
   *
   * `unknown` ne compte pas comme actif : le type l'impose plutôt que la discipline. Avec un
   * `boolean[]`, quelqu'un finirait par défauter un manquant à `true` et allumerait une chaudière
   * sur de l'inconnu.
   */
  async applyBoiler(demands: readonly Demand[], nowMs: number): Promise<void> {
    const nbActive = demands.reduce((count, demand) => count + (demand.kind === 'active' ? 1 : 0), 0);

    const previous = this.boilerState;
    const result = stepBoiler(previous, nbActive, this.params, nowMs);
    this.boilerState = result.nextState;

    const binding = this.boiler;
    if (result.command !== null && binding !== null) {
      try {
        // Un keep-alive comme une réaffirmation écrivent une valeur inchangée : la déduplication
        // les supprimerait, alors que forcer l'écriture est précisément leur raison d'être.
        await binding.write(result.command, {
          nowMs,
          maxIntervalMs: result.keepAlive || result.affirmation ? 1 : undefined,
        });
      } catch (err) {
        // L'ordre n'est pas parti : revenir à l'état précédent pour que le tick suivant le
        // retente. Garder l'état optimiste laisserait la chaudière allumée dans le modèle et
        // éteinte dans la maison, sans que rien ne le rattrape.
        this.boilerState = previous;
        this.host.error('Commande de la chaudière :', err);
      }
    }

    // Publiées APRÈS l'écriture : afficher une chaudière active dont l'ordre n'est pas parti
    // serait le seul endroit de l'app où l'interface ment sur ce qui a réellement été commandé.
    await this.publish('vtherm_nb_active', nbActive);
    await this.publish('vtherm_boiler_active', this.boilerState.commanded);

    if (result.command === null || result.keepAlive) return;
    if (this.boilerState !== result.nextState) return; // l'écriture a échoué, rien à annoncer.

    if (result.affirmation) {
      // Réaffirmation au démarrage : le relais vient d'être remis en accord avec l'état restauré.
      // Ce n'est pas une commutation — annoncer « la chaudière démarre » ferait partir les Flows
      // de l'utilisateur à chaque redémarrage de l'app, ce qui est exactement le faux positif que
      // le noyau évite ailleurs en ne publiant rien au premier pas.
      this.host.log(`Chaudière réaffirmée ${result.command ? 'ALLUMÉE' : 'ÉTEINTE'} au démarrage.`);
      await this.persist();
      return;
    }

    // SPEC §9.2 : chaque commutation est journalisée.
    this.host.log(`Chaudière ${result.command ? 'ALLUMÉE' : 'ÉTEINTE'} — ${nbActive} émetteur(s) en demande.`);

    await this.safely('déclencheur chaudière', () => this.host.triggerFlow(
      result.command === true ? { kind: 'boiler_started', nbActive } : { kind: 'boiler_stopped' },
    ));
    await this.persist();
  }

  /** À l'arrêt de l'app : une chaudière laissée allumée sans personne pour la couper est un danger. */
  async restoreSafeState(): Promise<void> {
    const binding = this.boiler;
    if (binding === null) return;

    await this.safely('extinction de la chaudière', () =>
      binding.write(false, { nowMs: Date.now(), maxIntervalMs: 1 }));
  }

  destroy(): void {
    this.boiler?.destroy();
    this.boiler = null;
  }

  private async persist(): Promise<void> {
    await this.safely('état durable de la chaudière', () => this.host.setStoreValue(BOILER_STORE_KEY, {
      commanded: this.boilerState.commanded,
      lastChangeMs: this.boilerState.lastChangeMs,
    }));
  }

  private async publish(capabilityId: string, value: CapValue): Promise<void> {
    try {
      await this.host.setCapabilityValue(capabilityId, value);
    } catch (err) {
      this.host.error(`Publication de ${capabilityId} :`, err);
    }
  }

  private async safely(label: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.host.error(`${label} :`, err);
    }
  }
}

/**
 * Relit `{commanded, lastChangeMs}` du `store`. Comme partout ailleurs : devant une valeur
 * inattendue on repart du défaut, jamais de la valeur lue.
 *
 * Un `lastChangeMs` dans le futur (horloge qui a reculé) est écarté : le conserver bloquerait tout
 * allumage jusqu'à ce que l'horloge le rattrape.
 */
function restoreBoilerState(raw: unknown, nowMs: number): BoilerState {
  const state = createBoilerState();
  if (typeof raw !== 'object' || raw === null) return state;

  const record = raw as Record<string, unknown>;
  const commanded = record.commanded === true;
  const lastChangeMs = typeof record.lastChangeMs === 'number'
    && Number.isFinite(record.lastChangeMs)
    && record.lastChangeMs <= nowMs
    ? record.lastChangeMs
    : null;

  return { ...state, commanded, lastChangeMs };
}
