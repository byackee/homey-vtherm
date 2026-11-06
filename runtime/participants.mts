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
  CentralMode, Demand, Preset, PreheatLearning, PreheatPreset, PreheatTarget, Reading, SyncMode,
  VThermConfig, VThermEvent, VThermInputs, VThermOutputs, VThermState, VThermStateDefaults,
  VThermWarning,
} from '../lib/types.mjs';
import type { BoilerParams, BoilerResult, BoilerState } from '../lib/types.mjs';
import {
  BOILER_DIVERGENCE_RETRY_SEC, DEFAULT_PREHEAT_MAX_LEAD_MIN, PREHEAT_MAX_TARGETS, SETPOINT_MAX, SETPOINT_MIN,
  STALE_MEASUREMENT_SEC, TIMED_PRESET_MAX_MINUTES, TIMED_PRESET_MIN_MINUTES,
} from '../lib/constants.mjs';
import { createBoilerState, ignitionAllowedAtMs, stepBoiler } from '../lib/boilerAggregator.mjs';
import { addPreheatTarget, targetsAfterManualChange } from '../lib/preheat.mjs';
import {
  ACTIVITY_STUCK_MS, DEFAULT_PRESENCE_OFF_DELAY_MIN, DETECTOR_OBSERVATION_GAP_MS, detectorActivityAtMs,
  holdAbsence, isMotionOnlyCapability, trueSinceMs,
} from '../lib/presence.mjs';
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
  /**
   * ~7 jours, comme le contact : un détecteur n'émet qu'en changeant d'état. À 2 h, un mmWave qui
   * voyait quelqu'un depuis plus longtemps devenait périmé, donc « sans mouvement » : la pièce
   * passait au preset d'inoccupation sous les yeux de son occupant.
   */
  motionMs: 7 * 24 * 60 * MS_PER_MINUTE,
  /**
   * ~7 jours, pour la même raison. Une présence virtuelle pilotée par Flow ne publie rien entre un
   * départ et un retour : à 2 h, l'« absent » devenait périmé, et une présence périmée vaut
   * « présent » — tous les thermostats remettaient la consigne de présence dans un logement vide.
   * Un appareil réellement hors service reste couvert par `available`.
   */
  presenceMs: 7 * 24 * 60 * MS_PER_MINUTE,
  /** ~2 h. Sans lui, la demande de chaleur en mode consigne devient `unknown` (chaudière OFF). */
  emitterHeatingMs: 2 * 60 * MS_PER_MINUTE,
  /**
   * ~14 jours, et c'est le seuil le plus large de la table — délibérément.
   *
   * Une charge de pile ne bouge pas en une journée, et une TRVZB ne rapporte la sienne que tous
   * les plusieurs jours. À 24 h, la tuile restait donc vide la plupart du temps sur du matériel
   * qui fonctionne parfaitement : sur l'installation de référence, deux vannes sur trois avaient
   * une lecture vieille de sept jours, donc jamais publiée. Une tuile de pile qu'on n'affiche
   * jamais ne prévient de rien — c'est pourtant sa seule raison d'être.
   *
   * Le raisonnement est l'inverse de celui de `roomTempMs` : réguler sur une température figée est
   * dangereux, alors qu'une pile de deux semaines reste une information juste. Ce qui compte ici
   * n'est pas l'instant de la mesure mais l'ordre de grandeur de ce qu'elle annonce.
   */
  emitterBatteryMs: 14 * 24 * 60 * MS_PER_MINUTE,
  emitterLocalTempMs: 2 * 60 * MS_PER_MINUTE,
  /**
   * ~48 h sans AUCUN relevé de l'émetteur : la liaison est morte, même s'il paraît joignable.
   *
   * Large, parce que Homey ne date une capability qu'à son changement : une vanne saine dans une
   * pièce stable garde sa température plusieurs heures — huit sur l'installation de référence. La
   * panne visée, elle, se compte en semaines.
   */
  emitterSilentMs: 48 * 60 * MS_PER_MINUTE,
} as const;

/**
 * Écriture de l'état durable : au plus toutes les 5 minutes (usure de la mémoire flash),
 * mais IMMÉDIATE sur un changement de preset, de consigne ou de preset temporisé — ce sont
 * précisément les choix de l'utilisateur, ceux qu'un redémarrage ne doit pas perdre.
 */
const PERSIST_INTERVAL_MS = 5 * MS_PER_MINUTE;

/**
 * Avertissement du noyau → clé de traduction.
 *
 * Trois cas distincts, et l'ancien texte les confondait : il annonçait « aucune commande envoyée »
 * y compris quand le mode sécurité venait précisément d'en envoyer une.
 */
const WARNING_KEYS: Record<VThermWarning, string> = {
  no_sensor: 'device.warning.no_sensor',
  sensor_stale: 'device.warning.sensor_stale',
  sensor_stale_safety: 'device.warning.sensor_stale_safety',
};

/**
 * La dorsale a disparu et la vanne n'a pas pu être rendue : elle est restée sur sa dernière
 * ouverture. Le seul repli de l'app qui échouait en silence — le journal n'est lisible par
 * personne, et une vanne à 12 % ne chauffe pas quelle que soit la consigne écrite ensuite.
 */
const VALVE_STUCK_WARNING_KEY = 'device.warning.valve_stuck';

/**
 * Une tête du groupe a cessé d'être pilotée, et c'est la panne la plus silencieuse de toutes.
 *
 * Elle ne coupe rien, ne lève rien, ne fait faiblir aucune demande : la pièce chauffe simplement à
 * une fraction de sa puissance pendant que la tuile affiche une régulation normale. Sans ce
 * bandeau, le seul signe en serait une ligne de journal — que personne ne lit, et qu'une app
 * installée par CLI ne rend même pas lisible.
 */
const EMITTER_MISMATCH_WARNING_KEY = 'device.warning.emitter_mismatch';

/**
 * L'émetteur ne remonte plus rien depuis `FRESHNESS.emitterSilentMs`. Sans ce bandeau, la tuile
 * affiche une régulation normale pendant que nos consignes se perdent : voir
 * `EmitterAdapter.reportedAtMs`.
 */
const EMITTER_SILENT_WARNING_KEY = 'device.warning.emitter_silent';

const VTHERM_STORE_KEY = 'vtherm.state';
const BOILER_STORE_KEY = 'central.boiler';

// ---------------------------------------------------------------------------
// Contrat avec l'appareil Homey
// ---------------------------------------------------------------------------

export type CentralEvent =
  | { kind: 'boiler_started'; nbActive: number }
  | { kind: 'boiler_stopped' }
  /**
   * Le mode central a réellement changé. L'événement naît dans `setMode`, qui porte déjà la
   * comparaison avec le mode précédent : régler le mode courant ne change rien et n'émet rien.
   */
  | { kind: 'central_mode_changed'; mode: CentralMode };

export type ParticipantEvent = VThermEvent | CentralEvent;

/**
 * Tout ce qu'un participant attend de son appareil Homey. Un `Homey.Device` l'implémente en une
 * douzaine de lignes ; un faux appareil de test aussi, ce qui est le point.
 */
export interface DeviceHost {
  readonly id: string;
  /**
   * `homey.__()`. Le noyau rend des CLÉS de traduction — `lib/` est pur et ne connaît aucune
   * langue — et c'est ici, au contact de Homey, qu'elles deviennent une phrase.
   */
  translate(key: string): string;
  getCapabilityValue(capabilityId: string): CapValue | null;
  /**
   * `false` quand l'écriture n'a PAS eu lieu faute de capability sur l'appareil. Le participant ne
   * mémorise alors rien : une tuile ajoutée plus tard recevrait sinon la valeur pour la première
   * fois seulement quand elle CHANGE — jamais, pour une présence sans capteur.
   */
  setCapabilityValue(capabilityId: string, value: CapValue): Promise<boolean>;
  setWarning(message: string | null): Promise<void>;
  getStoreValue(key: string): unknown;
  setStoreValue(key: string, value: unknown): Promise<void>;
  triggerFlow(event: ParticipantEvent): Promise<void>;
  /**
   * Affiche ce que la préchauffe a appris (SPEC §14). Facultatif : un hôte qui ne l'implémente pas
   * n'affiche rien, et la régulation n'en dépend pas.
   */
  showPreheatStatus?(learning: PreheatLearning, excluded: boolean): Promise<void>;
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
  /**
   * Le capteur de pièce est-il l'un des émetteurs ? Relu à chaque pas : les sources se re-désignent
   * à chaud. Absent = jamais.
   */
  roomSensorIsEmitter?: () => boolean;
  /**
   * Dernière activité vue dans le LOGEMENT par les détecteurs de tous les thermostats (instant, ou
   * `null` si aucun n'a rien vu). Retient l'absence de la présence de Homey : la géolocalisation ne
   * voit ni la nounou ni les enfants. Absent = aucune activité connue.
   */
  houseActivityAtMs?: (nowMs: number) => number | null;
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

interface DetectorMemory {
  activityAtMs: number | null;
  trueSinceMs: number | null;
  observedAtMs: number | null;
}

export function readBoolean(
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

/**
 * Ce qui, dans la préchauffe, mérite une écriture immédiate du `store` : les cibles (choix de
 * l'utilisateur) et un épisode ACCEPTÉ (des heures de mesure). Un rejet attend l'intervalle
 * ordinaire — il n'apprend rien, et le compter ici écrivait la flash à chaque rejet.
 */
function preheatSignature(state: VThermState): string {
  const { preheatTargets, preheatLearning } = state.persistent;
  return JSON.stringify([preheatTargets, preheatLearning.accepted]);
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
  private readonly roomSensorIsEmitter: () => boolean;
  private readonly houseActivityAtMs: (nowMs: number) => number | null;

  private config: VThermConfig;
  private syncMode: SyncMode;
  private controlsBoilerFlag: boolean;

  private state: VThermState;

  private demandValue: Demand = { kind: 'unknown' };
  private wakeUpAt: number | null = null;
  /**
   * Ce que l'on sait de chaque détecteur, par LIAISON — une re-désignation par Réparer repart de
   * zéro au lieu d'hériter du passé de l'ancien appareil. `activityAtMs` : dernière activité lue,
   * qu'un détecteur momentanément illisible garde au lieu de faire croire la maison calme.
   * `trueSinceMs` : voir `trueSinceMs()`. `observedAtMs` : dernière lecture exploitable vue.
   */
  private readonly detectors = new WeakMap<SourceBinding, DetectorMemory>();
  /** Instant de création : l'activité d'un détecteur jamais encore lu, faute de mieux. */
  private readonly createdAtMs: number;
  private lastTickAtMs: number | null = null;

  private lastPersistAtMs: number;
  private persistedPreset: Preset;
  private persistedManualSetpoint: number;
  private persistedTimedUntil: number | null;
  /** Cibles et compteurs d'apprentissage tels que persistés : voir `preheatSignature`. */
  private persistedPreheat: string;
  /** Apprentissage tel qu'affiché, `null` tant que rien ne l'a été. */
  private shownPreheat: string | null = null;

  /** Consigne CHOISIE au dernier pas, celle qu'exige la remise en état sûr (SPEC §11.1). */
  private userSetpoint: number;

  private windowBypass = false;
  private presenceOverride: PresenceOverride = 'auto';

  /** Ce qui a réellement été poussé sur les capabilities, pour ne pas réécrire à l'identique. */
  private readonly publishedCaps = new Map<string, CapValue>();
  /**
   * La CLÉ publiée, pas la phrase : comparer des phrases traduites n'aurait aucun sens.
   *
   * `undefined` au départ, et non `null` : Homey garde l'avertissement d'un appareil d'un démarrage
   * de l'app à l'autre. Partir de `null` revenait à croire le bandeau vide, et un « mesure
   * périmée » d'avant le redémarrage restait affiché sur une pièce qui chauffait normalement.
   */
  private publishedWarningKey: string | null | undefined = undefined;
  /** Dernier avertissement du noyau, pour recomposer l'affichage hors d'un pas. */
  private coreWarning: VThermWarning | null = null;
  /** La dorsale est tombée ET la vanne est restée figée : voir `onValveBackendAvailability`. */
  private valveStuck = false;
  /** Têtes écartées du groupe au dernier pas. Relu de l'émetteur, jamais déduit ici. */
  private emitterMismatch = false;
  /** L'émetteur n'a rien remonté depuis `FRESHNESS.emitterSilentMs`. Recalculé à chaque pas. */
  private emitterSilent = false;
  /** Plus AUCUNE tête ne répond : la demande de cette pièce ne vaut plus rien. */
  private emitterAllSilent = false;

  /** Vrai pendant qu'un pas est en vol. Garde de réentrance, voir `tick`. */
  private ticking = false;
  /** Un pas a été abandonné pendant que celui-ci écrivait : il est à relancer à la fin. */
  private tickAbandoned = false;

  constructor(options: VThermParticipantOptions) {
    this.tickId = options.host.id;
    this.host = options.host;
    this.emitter = options.emitter;
    this.sources = options.sources;
    this.centralMode = options.centralMode;
    this.requestTick = options.requestTick;
    this.roomSensorIsEmitter = options.roomSensorIsEmitter ?? (() => false);
    this.houseActivityAtMs = options.houseActivityAtMs ?? (() => null);
    this.createdAtMs = options.nowMs;
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
    this.persistedPreheat = preheatSignature(this.state);
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

  /**
   * L'ouverture RÉELLEMENT détectée au dernier pas, quelle que soit la façon de la détecter.
   * En mode `auto` il n'y a aucun contact : la détection vient de la pente, et la capability
   * `alarm_contact` n'est alors ni publiée ni même déclarée. Lire la capability ferait répondre
   * « fermée » à une condition placée derrière un déclencheur qui vient de partir.
   * C'est exactement la valeur que `step` compare pour émettre `window_opened`/`window_closed`.
   * `null` (aucun pas encore abouti) vaut « pas d'ouverture détectée », comme pour les événements.
   */
  get windowOpen(): boolean {
    return this.state.volatile.lastPublished.windowOpen === true;
  }

  get controlsBoiler(): boolean {
    return this.controlsBoilerFlag;
  }

  async tick(nowMs: number): Promise<void> {
    // Un pas est déjà en vol : on ne l'attend pas, on renonce à celui-ci.
    //
    // Le délai de garde de l'app (20 s) REJETTE mais n'annule rien — rien ne peut annuler une
    // écriture Zigbee déjà partie. Le pas abandonné continue donc d'écrire pendant que le suivant
    // démarre, dix secondes plus tard. Les deux liraient puis écraseraient `this.state`,
    // `dutyCycle`, `lastWrite` et `lastPublished` : le second réécrirait par-dessus les décisions
    // du premier, et le premier viendrait ensuite ressusciter un état déjà périmé.
    //
    // Abandonné, pas oublié : ce pas portait peut-être une fenêtre qui vient de s'ouvrir, et son
    // motif est déjà consommé. Sans relance, elle attendait le prochain cycle, cinq minutes par
    // défaut, derrière une écriture lente vers un émetteur.
    if (this.ticking) {
      this.host.log('Pas précédent encore en cours : celui-ci est abandonné.');
      this.tickAbandoned = true;
      return;
    }
    this.ticking = true;
    try {
      await this.runTick(nowMs);
    } finally {
      this.ticking = false;
      if (this.tickAbandoned) {
        this.tickAbandoned = false;
        this.requestTick('tick-abandoned');
      }
    }
  }

  private async runTick(nowMs: number): Promise<void> {
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

    // APRÈS la détection, qui est ce qui fait sortir une tête du groupe ou l'y ramène.
    this.emitterMismatch = this.emitter.mismatchedHeadIds.length > 0;
    // Pas de date, pas de verdict : un relais n'a aucune mesure à remonter.
    const silentSince = (atMs: number | null): boolean => this.emitter.available
      && atMs !== null
      && nowMs - atMs > FRESHNESS.emitterSilentMs;
    this.emitterSilent = silentSince(this.emitter.reportedAtMs);
    this.emitterAllSilent = silentSince(this.emitter.newestReportedAtMs);

    const roomTemp = readNumber(this.sources.room, nowMs, FRESHNESS.roomTempMs);
    const presence = this.resolvePresence(nowMs);
    const inputs = this.collectInputs(roomTemp, presence.reading, nowMs);

    const { outputs, nextState } = stepVTherm(this.state, inputs, this.config, nowMs);
    this.state = nextState;
    // Le délai avant absence a son échéance propre, hors du noyau : la plus proche des deux gagne.
    const wakeUp = Math.min(outputs.wakeUpAtMs ?? Infinity, presence.wakeUpAtMs ?? Infinity);
    this.wakeUpAt = Number.isFinite(wakeUp) ? wakeUp : null;

    const target = outputs.capabilities.target_temperature;
    if (typeof target === 'number') this.userSetpoint = target;

    await this.applyOutputs(outputs, roomTemp, nowMs);
    // APRÈS les écritures, jamais avant : c'est seulement une fois la commande tentée qu'on sait
    // si l'émetteur a reçu quelque chose. Voir `confirmedDemand` et `forgetUnconfirmedValveWrite`.
    this.demandValue = this.confirmedDemand(outputs.demand);
    this.forgetUnconfirmedValveWrite();
    await this.persistIfNeeded(nowMs);
    await this.refreshPreheatStatus();
  }

  private collectInputs(
    roomTemp: Reading<number> | null,
    presence: Reading<boolean> | null,
    nowMs: number,
  ): VThermInputs {
    const onoff = this.host.getCapabilityValue('onoff');

    return {
      roomTemp,
      // La LIAISON, pas la lecture : une liaison orpheline — capteur ré-appairé, donc introuvable —
      // rend `null` comme une absence de capteur, et le noyau doit pouvoir les distinguer.
      roomSensorBound: this.sources.room !== null,
      outdoorTemp: readNumber(this.sources.outdoor, nowMs, FRESHNESS.outdoorTempMs),
      windowContact: readBoolean(this.sources.windowContact, nowMs, FRESHNESS.windowContactMs),
      motion: readBoolean(this.sources.motion, nowMs, FRESHNESS.motionMs),
      presence,
      emitterHeating: this.emitter.readHeating(nowMs),
      // Joignable ET pourvu d'une consigne : c'est la preuve que la détection a eu lieu. Avant
      // elle, toutes les capabilities valent faux, et l'absence d'état de chauffe ne prouve rien.
      emitterLacksHeatingState: this.emitter.available
        && this.emitter.caps.setpoint
        && !this.emitter.caps.heatingState,
      emitterHeatingHeads: this.emitter.readHeatingHeads(nowMs),
      emitterMode: this.emitter.mode,
      emitterCount: this.emitter.headCount,
      centralMode: this.centralMode(),
      // Capability absente au tout premier pas : un thermostat neuf est allumé.
      onoff: typeof onoff === 'boolean' ? onoff : true,
      windowBypass: this.windowBypass,
      roomSensorIsEmitter: this.roomSensorIsEmitter(),
    };
  }

  /**
   * Le forçage Flow prime sur le capteur, et n'est jamais périmé : c'est une décision explicite.
   * Un capteur ne déclare l'absence qu'après le délai avant absence ; la présence de Homey, elle,
   * est déjà confirmée et passe sans délai.
   */
  private resolvePresence(nowMs: number): { reading: Reading<boolean> | null; wakeUpAtMs: number | null } {
    if (this.presenceOverride !== 'auto') {
      return { reading: { value: this.presenceOverride === 'home', atMs: nowMs, stale: false }, wakeUpAtMs: null };
    }
    const binding = this.sources.presence;
    const reading = readBoolean(binding, nowMs, FRESHNESS.presenceMs);
    const delayMs = (this.config.presenceOffDelayMin ?? DEFAULT_PRESENCE_OFF_DELAY_MIN) * MS_PER_MINUTE;
    if (binding?.confirmedAbsence !== true) {
      // Seul un détecteur de MOUVEMENT retombe dès que personne ne bouge. Un capteur de présence —
      // mmWave, appareil virtuel piloté par géofence, état d'alarme — dit déjà l'absence.
      if (binding === null || !isMotionOnlyCapability(binding.capabilityId)) return { reading, wakeUpAtMs: null };
      // Figé sur « quelqu'un » depuis plus de `ACTIVITY_STUCK_MS` (pile morte, animal) : il compte
      // comme retombé à cette borne, et le délai court ensuite.
      const since = this.observeDetector(binding, reading, nowMs).trueSinceMs;
      if (reading !== null && reading.value && since !== null) {
        const stuckAtMs = since + ACTIVITY_STUCK_MS;
        if (nowMs < stuckAtMs) return { reading, wakeUpAtMs: stuckAtMs };
        return holdAbsence({ ...reading, value: false, atMs: stuckAtMs }, nowMs, delayMs);
      }
      return holdAbsence(reading, nowMs, delayMs);
    }

    // Présence de Homey : personne n'est géolocalisé, mais un détecteur de la maison a vu quelqu'un
    // il y a moins que le délai — la nounou est restée avec les enfants. L'absence attend que la
    // maison soit calme depuis le délai entier.
    if (reading === null || reading.value || reading.stale) return { reading, wakeUpAtMs: null };
    const activityAtMs = this.houseActivityAtMs(nowMs);
    if (activityAtMs === null) return { reading, wakeUpAtMs: null };
    const held = holdAbsence({ ...reading, atMs: activityAtMs }, nowMs, delayMs);
    return held.wakeUpAtMs === null ? { reading, wakeUpAtMs: null } : held;
  }

  /**
   * Dernière activité que les détecteurs DE CE thermostat ont vue (`detectorActivityAtMs`). Le
   * détecteur de présence ne compte que s'il est un vrai capteur — la présence de Homey n'est pas
   * une activité dans la maison.
   *
   * Un détecteur illisible rend sa dernière activité connue ; jamais lu depuis la création du
   * thermostat (démarrage, liaison pas encore rattachée), il compte comme actif à la création. Le
   * logement n'est donc pas vidé au démarrage, et un détecteur définitivement disparu cesse de le
   * retenir un délai après.
   */
  lastActivityAtMs(nowMs: number): number | null {
    let latest: number | null = null;
    const consider = (key: 'motion' | 'presence', freshnessMs: number): void => {
      const binding = this.sources[key];
      if (binding === null || binding.confirmedAbsence === true) return;
      const reading = readBoolean(binding, nowMs, freshnessMs);
      const known = this.observeDetector(binding, reading, nowMs);
      // La borne du figé ne vaut que pour le mouvement : un mmWave reste à vrai toute une nuit
      // devant une nounou endormie, et la maison n'est pas vide pour autant.
      const stuckSince = isMotionOnlyCapability(binding.capabilityId) ? known.trueSinceMs : null;
      const atMs = detectorActivityAtMs(reading, nowMs, stuckSince) ?? known.activityAtMs ?? this.createdAtMs;
      if (latest === null || atMs > latest) latest = atMs;
    };
    consider('motion', FRESHNESS.motionMs);
    consider('presence', FRESHNESS.presenceMs);
    return latest;
  }

  /**
   * Met à jour, puis rend, ce que l'on sait d'un détecteur. Idempotent pour un même instant.
   *
   * Un appel dont l'instant précède la dernière observation — une condition Flow à l'heure murale
   * pendant un pas daté plus tôt — lit sans écrire : la mémoire ne recule jamais. Une lecture
   * absente ne compte pas comme une observation : un détecteur resté hors ligne plus que
   * `DETECTOR_OBSERVATION_GAP_MS` n'a pas été vu à vrai sans interruption.
   */
  private observeDetector(binding: SourceBinding, reading: Reading<boolean> | null, nowMs: number): DetectorMemory {
    const previous = this.detectors.get(binding)
      ?? { activityAtMs: null, trueSinceMs: null, observedAtMs: null };
    const watched = previous.observedAtMs !== null && nowMs - previous.observedAtMs <= DETECTOR_OBSERVATION_GAP_MS;
    const since = trueSinceMs(reading, watched ? previous.trueSinceMs : null);
    const activityAtMs = detectorActivityAtMs(
      reading, nowMs, isMotionOnlyCapability(binding.capabilityId) ? since : null,
    );
    const known: DetectorMemory = {
      activityAtMs: activityAtMs ?? previous.activityAtMs,
      trueSinceMs: since,
      observedAtMs: reading === null ? previous.observedAtMs : nowMs,
    };
    if (previous.observedAtMs === null || nowMs >= previous.observedAtMs) this.detectors.set(binding, known);
    return known;
  }

  /** Ce thermostat suit-il la présence de Homey, donc l'activité de toute la maison ? */
  get followsHouseActivity(): boolean {
    return this.presenceOverride === 'auto' && this.sources.presence?.confirmedAbsence === true;
  }

  /**
   * La présence telle que la régulation l'applique : forçage, délai avant absence compris. Une
   * lecture absente ou périmée ne déclare personne absent.
   */
  isSomeoneHome(nowMs: number): boolean {
    const { reading } = this.resolvePresence(nowMs);
    return reading === null || reading.stale || reading.value;
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
    } else if (this.emitter.mode === 'setpoint') {
      // Rien de neuf à envoyer, mais la tête porte peut-être autre chose : en mode consigne, c'est
      // elle qui commande. Voir `EmitterAdapter.reassertSetpoint`.
      await this.safely('réaffirmation de la consigne', async () => {
        if (await this.emitter.reassertSetpoint(nowMs)) {
          this.host.log('Consigne de l\'émetteur divergente : réécrite.');
        }
      });
    }

    // `null` = le noyau n'a rien à commander : soit les relais sont déjà dans le bon état, soit la
    // mesure s'est tue et on n'y touche pas. Écrire quand même userait le contacteur pour rien.
    // Une entrée `null` dans la liste dit la même chose de CETTE tête-là — les têtes d'un groupe
    // sont déphasées, elles ne basculent donc pas au même pas.
    const switchOn = outputs.switchOn;
    if (switchOn !== null && switchOn.some((on) => on !== null)) {
      await this.safely('bascule de l\'interrupteur', () =>
        this.emitter.applySwitch(switchOn, nowMs));
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

    this.coreWarning = outputs.warning;
    await this.refreshWarning();
  }

  /**
   * Un seul bandeau pour deux sources : le noyau, et la perte de la dorsale.
   *
   * L'appareil n'a qu'un `setWarning` ; deux écrivains qui s'ignorent finiraient par effacer
   * l'avertissement de l'autre. Le capteur muet passe devant : il suspend la régulation, alors
   * qu'une vanne figée la dégrade.
   */
  private async refreshWarning(): Promise<void> {
    // Ordre de priorité, du plus grave au moins grave. Le capteur muet passe devant : il suspend
    // toute la régulation. Viennent ensuite l'émetteur muet puis la tête écartée, DURABLES et
    // invisibles tous deux — le muet d'abord, il ne reçoit plus rien du tout —, là où la vanne
    // figée accompagne une panne de dorsale que l'utilisateur constate par ailleurs.
    const core = this.coreWarning;
    let key: string | null = null;
    if (core !== null) key = WARNING_KEYS[core];
    else if (this.emitterSilent) key = EMITTER_SILENT_WARNING_KEY;
    else if (this.emitterMismatch) key = EMITTER_MISMATCH_WARNING_KEY;
    else if (this.valveStuck) key = VALVE_STUCK_WARNING_KEY;

    if (key === this.publishedWarningKey) return;
    this.publishedWarningKey = key;

    const message = key === null ? null : this.host.translate(key);
    await this.safely('avertissement', () => this.host.setWarning(message));
  }

  /**
   * Rabat la demande sur `unknown` quand l'ouverture de vanne n'a pas pu partir.
   *
   * Le noyau déduit la demande de chaleur de son INTENTION (`on_percent >= openingThreshold`),
   * jamais d'une confirmation de la vanne — il ne peut pas faire autrement, aucune capability
   * Homey ne relit `valve_opening_degree`. Tant que l'écriture part, cette intention est fidèle.
   * Quand elle ne part pas — vannes renommées dans Zigbee2MQTT, donc introuvables — la vanne reste
   * là où elle était, souvent presque fermée, pendant que l'app la croit ouverte : le relais de
   * chaudière s'enclencherait alors sur un circuit fermé. `unknown` est le seul verdict honnête,
   * et le contrat du type veut qu'il laisse la chaudière éteinte.
   */
  private confirmedDemand(demand: Demand): Demand {
    // Une chaudière ne s'allume jamais sur de l'inconnu : quand la commande de l'émetteur n'est pas
    // partie, la demande de cette pièce ne vaut rien et ne doit pas compter dans l'agrégat.
    //
    // Le mode consigne n'a pas besoin de cette garde : sa demande se lit sur `emitterHeating`, qui
    // rend `null` sur une liaison orpheline. Les deux autres commandent à l'aveugle — le mode vanne
    // par la dorsale, le mode interrupteur par notre propre découpage temporel — et doivent donc
    // dire quand rien n'est parti.
    //
    // L'émetteur muet est le même doute, en plus durable : rien ne dit que nos commandes arrivent.
    // La tête du salon, sous le pilote Sonoff officiel, faisait tourner la chaudière pour un
    // radiateur froid depuis des semaines. Seulement quand TOUTES les têtes se taisent : une tête
    // morte dans un groupe ne doit pas laisser les autres radiateurs sans eau chaude.
    if (this.emitterAllSilent) return { kind: 'unknown' };
    if (this.emitter.mode === 'valve' && this.emitter.valveUnconfirmed) return { kind: 'unknown' };
    if (this.emitter.mode === 'switch' && this.emitter.switchUnconfirmed) return { kind: 'unknown' };
    return demand;
  }

  /**
   * Efface du noyau la trace d'une ouverture que l'émetteur n'a PAS pu envoyer.
   *
   * Il y a DEUX mémoires d'écriture, et elles ne mesurent pas la même chose. Celle de l'émetteur
   * n'enregistre que ce qui est réellement parti — `if (sent) this.remember(...)` — précisément
   * pour qu'une même valeur puisse être retentée. Celle du noyau enregistre ce qu'il a DÉCIDÉ de
   * commander, et c'est elle qui garde la porte : `shouldWrite` déduplique contre elle, sans
   * `maxIntervalMs`. Une valeur inchangée ne repasse donc jamais, et l'émetteur n'a plus jamais
   * l'occasion de réessayer.
   *
   * Le scénario complet : la dorsale Zigbee2MQTT hoquette, l'ouverture n'est pas envoyée, la
   * demande de chaleur tombe à `unknown` et la chaudière s'éteint. La pièce refroidit, donc le TPI
   * sature à 100 %, donc l'ouverture visée ne bouge plus — et le seuil de variation de 3 % qui
   * garde le noyau ne se rouvre jamais. Vanne à sa dernière position, chaudière éteinte, aucune
   * sortie : `lastWrite` est volatile, seul un redémarrage de l'app y mettait fin.
   *
   * Oublier la trace rend la main à l'émetteur au pas suivant. C'est le noyau qui doit céder :
   * lui seul croit avoir écrit.
   */
  private forgetUnconfirmedValveWrite(): void {
    if (this.emitter.mode !== 'valve' || !this.emitter.valveUnconfirmed) return;

    const { lastWrite } = this.state.volatile;
    if (lastWrite.valvePercent === null) return;

    this.state = {
      ...this.state,
      volatile: { ...this.state.volatile, lastWrite: { ...lastWrite, valvePercent: null } },
    };
  }

  private async publish(capabilityId: string, value: CapValue): Promise<void> {
    if (this.publishedCaps.get(capabilityId) === value) return;

    try {
      if (await this.host.setCapabilityValue(capabilityId, value)) {
        this.publishedCaps.set(capabilityId, value);
      }
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

    const preheat = preheatSignature(this.state);

    // Les cibles de préchauffe sont des choix de l'utilisateur au même titre que le preset, et un
    // épisode accepté représente des heures de mesure : ni l'un ni l'autre n'attend l'intervalle.
    const userChoiceChanged = persistent.preset !== this.persistedPreset
      || persistent.manualSetpoint !== this.persistedManualSetpoint
      || timedUntil !== this.persistedTimedUntil
      || preheat !== this.persistedPreheat;

    if (!userChoiceChanged && nowMs - this.lastPersistAtMs < PERSIST_INTERVAL_MS) return;

    try {
      await this.host.setStoreValue(VTHERM_STORE_KEY, persistent);
      this.lastPersistAtMs = nowMs;
      this.persistedPreset = persistent.preset;
      this.persistedManualSetpoint = persistent.manualSetpoint;
      this.persistedTimedUntil = timedUntil;
      this.persistedPreheat = preheat;
    } catch (err) {
      this.host.error('Écriture de l\'état durable :', err);
    }
  }

  // --- Mutations (cartes Flow, interface, réglages) --------------------------
  //
  // L'état durable appartient au participant : le laisser modifier de l'extérieur produirait deux
  // vérités. Chaque mutation demande un recalcul, que l'ordonnanceur coalesce.

  setPreset(preset: Preset, nowMs: number = Date.now()): void {
    // Un choix manuel annule le preset temporisé : les deux en même temps rendraient la consigne
    // inexplicable dans l'interface.
    this.mutate({
      preset, timedPreset: null, preheatTargets: this.targetsAfterManualChange(nowMs),
    }, 'preset');
  }

  setManualSetpoint(setpoint: number, nowMs: number = Date.now()): void {
    if (!Number.isFinite(setpoint)) return;
    const value = Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, setpoint));
    this.mutate({
      preset: 'none',
      manualSetpoint: value,
      timedPreset: null,
      preheatTargets: this.targetsAfterManualChange(nowMs),
    }, 'setpoint');
  }

  setTimedPreset(preset: Preset, minutes: number, nowMs: number): void {
    // `minutes` est typé `number` mais vient d'une carte Flow : un argument absent ou mal saisi
    // arrive `undefined`. `Math.round(undefined)` rend `NaN`, que `Math.min`/`Math.max` propagent
    // jusqu'à `untilMs`, puis `wakeUpAtMs`, puis `dueAtMs()` — et l'agrégation `Math.min` de l'app
    // rend alors `NaN` pour TOUT le logement : l'ordonnanceur ne juge plus jamais le cycle dû, et
    // la régulation périodique s'arrête en silence. Même garde que `setManualSetpoint`.
    if (!Number.isFinite(minutes)) return;

    const bounded = Math.min(TIMED_PRESET_MAX_MINUTES, Math.max(TIMED_PRESET_MIN_MINUTES, Math.round(minutes)));
    const previous = this.state.persistent.timedPreset?.previous ?? this.state.persistent.preset;
    this.mutate({
      timedPreset: { preset, untilMs: nowMs + bounded * MS_PER_MINUTE, previous },
      preheatTargets: this.targetsAfterManualChange(nowMs),
    }, 'timed-preset');
  }

  /**
   * Pose une cible de préchauffe (SPEC §14). Lève quand la liste est pleine : la carte Flow
   * s'affiche alors en échec dans son historique, ce qui est le seul refus que l'utilisateur voie.
   */
  addPreheatTarget(preset: PreheatPreset, atMs: number): void {
    if (!Number.isFinite(atMs)) return;
    const next = addPreheatTarget(this.state.persistent.preheatTargets, { preset, atMs });
    if (next === null) {
      throw new Error(this.host.translate('device.preheat.full').replace('{max}', String(PREHEAT_MAX_TARGETS)));
    }
    this.mutate({ preheatTargets: next }, 'preheat-target');
  }

  cancelPreheatTargets(): void {
    if (this.state.persistent.preheatTargets.length === 0) return;
    this.mutate({ preheatTargets: [] }, 'preheat-cancel');
  }

  get preheatTargets(): readonly PreheatTarget[] {
    return this.state.persistent.preheatTargets;
  }

  /**
   * Un changement manuel annule les cibles dont il tombe dans la fenêtre de démarrage. Un écho de
   * consigne venu de la tête n'en est pas un : `reassertSetpoint` le réécrase sans passer par ici.
   */
  private targetsAfterManualChange(nowMs: number): readonly PreheatTarget[] {
    return targetsAfterManualChange(
      this.state.persistent.preheatTargets,
      nowMs,
      this.config.preheatMaxLeadMin ?? DEFAULT_PREHEAT_MAX_LEAD_MIN,
    );
  }

  private async refreshPreheatStatus(): Promise<void> {
    const show = this.host.showPreheatStatus;
    if (show === undefined) return;

    const learning = this.state.persistent.preheatLearning;
    const excluded = this.roomSensorIsEmitter();
    const key = JSON.stringify([learning.accepted, learning.rejected, learning.lastRejectReason,
      learning.plateauTemp, learning.ratePerHour, learning.deadTimeMin, excluded]);
    if (key === this.shownPreheat) return;
    try {
      await show.call(this.host, learning, excluded);
      // Mémorisé APRÈS l'écriture : un échec doit être retenté au pas suivant, pas oublié jusqu'au
      // prochain épisode.
      this.shownPreheat = key;
    } catch (err) {
      this.host.error('état de la préchauffe :', err);
    }
  }

  cancelTimedPreset(nowMs: number = Date.now()): void {
    const timed = this.state.persistent.timedPreset;
    if (timed === null) return;
    this.mutate({
      preset: timed.previous,
      timedPreset: null,
      preheatTargets: this.targetsAfterManualChange(nowMs),
    }, 'cancel-timed-preset');
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

  /**
   * La dorsale Zigbee2MQTT vient de tomber, ou de revenir.
   *
   * Ne pas confondre avec `setValveBackend` : celui-là ne part que sur un changement de RÉGLAGES.
   * Une chute de connexion en cours de journée n'y passe jamais — seul `backend.available`
   * bascule. Le mode retombait bien sur la consigne, mais la vanne restait figée sur sa dernière
   * ouverture : ramenée à 12 % par le TPI, une pièce à 16 °C ne remontait plus jamais, et le seul
   * signe en était une ligne de journal que personne ne lit.
   */
  async onValveBackendAvailability(available: boolean, nowMs: number): Promise<void> {
    if (available) {
      // La vanne est reprise en main par le pas suivant : plus rien à signaler.
      this.valveStuck = false;
      await this.refreshWarning();
      this.requestTick('valve-backend-back');
      return;
    }

    const released = await this.emitter.releaseValve(nowMs);
    this.valveStuck = !released;
    await this.refreshWarning();
    this.requestTick('valve-backend-lost');
  }

  /**
   * La dorsale va être retirée des réglages : dernière occasion de rendre la vanne. Au mieux :
   * sans dorsale, rien ne pourra plus jamais la toucher, donc rien à signaler non plus.
   */
  async releaseValveBeforeBackendRemoval(nowMs: number): Promise<void> {
    await this.safely('libération de la vanne', () => this.emitter.releaseValve(nowMs));
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
  /** Le refus d'allumage a déjà été tracé : il est réévalué à chaque pas, pas le journal. */
  private ignitionBlockedLogged = false;
  /** Dernières valeurs réellement publiées. Voir `publish` : le central republiait à chaque cycle. */
  private readonly publishedCaps = new Map<string, CapValue>();

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

  async setMode(mode: CentralMode): Promise<void> {
    if (mode === this.centralMode) return;
    this.centralMode = mode;
    // Le recalcul d'abord, le Flow ensuite : la régulation ne doit pas attendre qu'une carte
    // Flow ait fini de se déclencher pour tenir compte du nouveau mode.
    this.requestTick('central-mode');
    await this.safely('déclencheur mode central', () =>
      this.host.triggerFlow({ kind: 'central_mode_changed', mode }));
  }

  updateParams(params: BoilerParams): void {
    this.params = params;
    this.requestTick('boiler-settings');
  }

  setBoilerBinding(binding: SourceBinding | null): void {
    this.boiler?.destroy();
    this.boiler = binding;

    /*
     * Un relais fraîchement lié doit être RÉAFFIRMÉ, donc on redésarme le drapeau.
     *
     * La réaffirmation de démarrage est une fois-pour-toutes. Quand l'appareil central existe sans
     * relais désigné — cas normal jusqu'à ce que l'utilisateur en choisisse un — le premier pas la
     * consomme dans le vide : `applyBoiler` n'écrit rien faute de liaison, mais l'état marque
     * l'affirmation comme faite. Le relais désigné plus tard n'était alors jamais remis en accord.
     *
     * La réaffirmation sur divergence rattrape ce cas dès que le relais est LISIBLE, mais elle ne
     * peut rien quand il ne l'est pas. Redésarmer ici traite la cause plutôt que le symptôme.
     */
    if (binding !== null) {
      this.boilerState = { ...this.boilerState, affirmed: false };
    }
  }

  /** Délai d'activation en cours, ou prochain keep-alive. `Infinity` quand rien n'attend. */
  dueAtMs(): number {
    const state = this.boilerState;

    if (state.pendingSinceMs !== null) {
      const activationAtMs = state.pendingSinceMs + this.params.activationDelaySec * 1000;
      /*
       * Le garde-fou anti-pulsation repousse l'allumage plus loin que le délai d'activation, et
       * il faut le dire ici. Sans ce `max`, l'échéance annoncée pendant l'attente est dans le
       * PASSÉ : le cycle complet du logement se juge dû à chaque battement pendant toute la
       * minute, pour un allumage qu'on sait déjà refusé — et la reprise a lieu au battement
       * suivant plutôt qu'à l'instant exact où le garde-fou expire.
       */
      return Math.max(activationAtMs, ignitionAllowedAtMs(state, this.params) ?? Number.NEGATIVE_INFINITY);
    }
    /*
     * Une correction différée doit se réveiller seule. Le relais divergent n'est vu que si un pas
     * a lieu : sans cette échéance, une correction repoussée par l'espacement des retentatives
     * attendait le prochain pas d'un AUTRE participant — jusqu'à `cycle_min`, cinq minutes par
     * défaut, pendant lesquelles un relais resté allumé continue de chauffer.
     */
    if (state.lastDivergenceFixMs !== null) {
      return state.lastDivergenceFixMs + BOILER_DIVERGENCE_RETRY_SEC * 1000;
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
    const result = stepBoiler(previous, nbActive, this.params, nowMs, this.readRelay(nowMs));
    this.boilerState = result.nextState;

    const binding = this.boiler;
    if (result.command !== null && binding !== null) {
      try {
        // Un keep-alive comme une réaffirmation écrivent une valeur inchangée : la déduplication
        // les supprimerait, alors que forcer l'écriture est précisément leur raison d'être.
        await binding.write(result.command, {
          nowMs,
          maxIntervalMs: result.keepAlive || result.affirmation || result.divergence ? 1 : undefined,
        });
      } catch (err) {
        // L'ordre n'est pas parti : revenir à l'état précédent pour que le tick suivant le
        // retente. Garder l'état optimiste laisserait la chaudière allumée dans le modèle et
        // éteinte dans la maison, sans que rien ne le rattrape.
        //
        // Ce chemin couvre AUSSI la liaison pas encore résolue, cas le plus insidieux : le hub
        // monte en tâche de fond, le premier tick part avant lui, et `stepBoiler` ne produit un
        // ordre que sur CHANGEMENT. Un ordre avalé au démarrage n'était jamais réémis — la maison
        // ne chauffait pas de la journée, la tuile affichait « en marche », aucune erreur.
        //
        // L'espacement des retentatives, lui, SURVIT au retour arrière : il compte les tentatives,
        // pas les succès. Une écriture qui échoue a quand même coûté son appel d'API — et le cas
        // qui la fait échouer est justement le quota Athom atteint. Rendre la marque effacerait
        // l'espacement exactement quand il sert, et l'app retenterait à chaque pas.
        this.boilerState = result.divergence
          ? { ...previous, lastDivergenceFixMs: result.nextState.lastDivergenceFixMs }
          : previous;
        this.host.error('Commande de la chaudière :', err);
      }
    }

    // Publiées APRÈS l'écriture : afficher une chaudière active dont l'ordre n'est pas parti
    // serait le seul endroit de l'app où l'interface ment sur ce qui a réellement été commandé.
    await this.publish('vtherm_nb_active', nbActive);
    await this.publish('vtherm_boiler_active', this.boilerState.commanded);

    this.traceIgnitionBlock(result, nbActive, nowMs);

    if (result.command === null || result.keepAlive) return;
    if (this.boilerState !== result.nextState) return; // l'écriture a échoué, rien à annoncer.

    if (result.divergence) {
      // Le relais avait dérivé de l'état commandé : il vient d'y être ramené. Rien à persister —
      // ni l'état commandé ni l'instant de la dernière commutation n'ont changé — et surtout
      // aucune carte Flow : « la chaudière démarre » n'a de sens que sur une vraie commutation.
      this.host.log(
        `Relais de chaudière trouvé ${result.command ? 'ÉTEINT' : 'ALLUMÉ'} alors qu'il était `
        + `commandé ${result.command ? 'ALLUMÉ' : 'ÉTEINT'} : remis en accord.`,
      );
      // Une coupure imposée a arrêté un brûleur qui tournait : le garde-fou qu'elle vient d'armer
      // doit survivre à un redémarrage, sinon l'app revient et rallume aussitôt.
      if (result.command === false) await this.persist();
      return;
    }

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

    const nowMs = Date.now();
    await this.safely('extinction de la chaudière', () =>
      binding.write(false, { nowMs, maxIntervalMs: 1 }));

    /*
     * Persister l'extinction, sinon elle n'a jamais eu lieu du point de vue du redémarrage.
     *
     * L'état relu dirait encore `commanded: true` : la réaffirmation partirait au premier pas —
     * et elle est délibérément exemptée du garde-fou anti-pulsation, alors que la commutation
     * précédente daterait de quelques secondes. Une mise à jour d'app à 3 h du matin donnait ainsi
     * OFF puis ON quinze secondes plus tard, exactement le court-cycle que la SPEC §9.2 interdit.
     *
     * Écrit même si la commande n'est pas partie : le relais est alors dans un état qu'on ne
     * connaît pas, et repartir d'« éteinte » est le seul point de départ qui ne l'allume pas.
     */
    this.boilerState = {
      ...this.boilerState,
      commanded: false,
      lastChangeMs: nowMs,
      pendingSinceMs: null,
      lastKeepAliveMs: null,
      affirmed: true,
      // Les marques de correction appartiennent à la session qui s'arrête : les traîner
      // contredirait l'invariant du type, et retiendrait la première correction de la suivante.
      lastDivergenceFixMs: null,
      lastForcedOffMs: null,
    };
    await this.persist();
  }

  destroy(): void {
    this.boiler?.destroy();
    this.boiler = null;
  }

  /**
   * L'état RÉELLEMENT porté par le relais, ou `null` quand il n'est pas lisible.
   *
   * L'ÂGE est délibérément ignoré (`Infinity`). Un relais qui ne bascule pas ne réémet rien
   * pendant des heures, et c'est précisément dans ce régime-là que la divergence doit se voir :
   * un seuil de fraîcheur ordinaire aurait rendu la correction aveugle au cas qu'elle existe pour
   * rattraper. `stale` ne reste donc vrai que sur un appareil INDISPONIBLE — dont on ne sait rien
   * et sur lequel une écriture échouerait de toute façon.
   */
  private readRelay(nowMs: number): boolean | null {
    const reading = this.boiler?.read(nowMs, Number.POSITIVE_INFINITY) ?? null;
    if (reading === null || reading.stale) return null;

    // Certains ponts publient 0/1 là où Homey attend un booléen. Tout le reste n'est pas
    // interprétable, et une lecture non interprétable ne doit rien corriger.
    if (typeof reading.value === 'boolean') return reading.value;
    if (typeof reading.value === 'number') return reading.value !== 0;
    return null;
  }

  /**
   * Trace une attente du garde-fou anti-pulsation : son ENTRÉE, et sa fin quand rien n'en sort.
   *
   * C'est la seule explication disponible du symptôme « je change ma consigne et la chaudière ne
   * change pas de statut » : l'attente est légitime, silencieuse, et dure une minute. Tracée à
   * chaque pas elle noierait le tampon de diagnostic ; jamais tracée, elle est indiagnosticable.
   *
   * Une attente qui débouche sur un allumage n'est pas annoncée deux fois — la commutation est
   * journalisée juste après. Seule l'attente ABANDONNÉE mérite sa ligne : la demande a disparu
   * avant l'expiration, et sans elle le journal s'arrête sur « allumage différé de 47 s » qui ne
   * se conclut jamais.
   */
  private traceIgnitionBlock(result: BoilerResult, nbActive: number, nowMs: number): void {
    if (result.ignitionBlocked === this.ignitionBlockedLogged) return;
    this.ignitionBlockedLogged = result.ignitionBlocked;

    if (!result.ignitionBlocked) {
      if (result.command !== true) {
        this.host.log('Attente d\'allumage abandonnée : plus aucun émetteur en demande.');
      }
      return;
    }

    const allowedAtMs = ignitionAllowedAtMs(this.boilerState, this.params);
    const remainingSec = allowedAtMs === null
      ? 0
      : Math.max(0, Math.ceil((allowedAtMs - nowMs) / 1000));
    this.host.log(
      `${nbActive} émetteur(s) en demande, mais le garde-fou anti-pulsation diffère l'allumage `
      + `de ${remainingSec} s : la chaudière vient de commuter.`,
    );
  }

  private async persist(): Promise<void> {
    await this.safely('état durable de la chaudière', () => this.host.setStoreValue(BOILER_STORE_KEY, {
      commanded: this.boilerState.commanded,
      lastChangeMs: this.boilerState.lastChangeMs,
      lastForcedOffMs: this.boilerState.lastForcedOffMs,
    }));
  }

  private async publish(capabilityId: string, value: CapValue): Promise<void> {
    // Même déduplication que celle du thermostat, et pour la même raison — elle manquait ici.
    // `applyBoiler` publie `vtherm_nb_active` et `vtherm_boiler_active` à CHAQUE cycle, et un tick
    // demandé par une source fait tourner le cycle entier : sur un logement fourni, cela faisait
    // plus d'un millier d'écritures par heure sur deux capabilities alimentées en Insights, alors
    // que leur valeur ne change que rarement.
    if (this.publishedCaps.get(capabilityId) === value) return;

    try {
      if (await this.host.setCapabilityValue(capabilityId, value)) {
        this.publishedCaps.set(capabilityId, value);
      }
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

  return {
    ...state,
    commanded,
    lastChangeMs: pastInstant(record.lastChangeMs, nowMs),
    lastForcedOffMs: pastInstant(record.lastForcedOffMs, nowMs),
  };
}

/** Un instant relu du `store`, ou `null` s'il est illisible ou dans le futur. */
function pastInstant(raw: unknown, nowMs: number): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw <= nowMs ? raw : null;
}
