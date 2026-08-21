/**
 * `runtime/emitter.mts` — l'émetteur d'un VTherm.
 *
 * Deux dorsales, comme tranché en SPEC §1.1 :
 *  - la dorsale Homey, toujours active, qui écrit une consigne décalée sur `target_temperature` ;
 *  - la dorsale MQTT, optionnelle, qui débloque l'ouverture de vanne et l'injection de la
 *    température de pièce. Sans elle, `mode` vaut toujours `'setpoint'` et tout le reste marche.
 *
 * Deux règles de ce fichier ne se négocient pas :
 *
 *  1. **La détection du mode lit `setable`, pas la présence de l'identifiant**, et se REJOUE à
 *     chaque ré-abonnement. Un device Zigbee2MQTT ré-annoncé après le redémarrage de l'app Z2M
 *     peut revenir avec un jeu de capabilities différent ; une détection faite une fois au pairing
 *     laisserait l'app écrire dans le vide pour toujours.
 *  2. **Anti-écho (SPEC §5.4).** Toute écriture mémorise sa valeur et son instant. Une relecture
 *     égale à la dernière valeur envoyée, ou survenue dans les 30 s qui suivent une écriture, est
 *     un écho de nous-mêmes. Sans ce filtre, l'app relit son propre `consigne + offset`, le prend
 *     pour une consigne utilisateur, réapplique l'offset par-dessus, et la vanne monte jusqu'à sa
 *     butée de 35 °C. Ce n'est pas une commodité, c'est ce qui empêche un emballement.
 */

import type { Reading, SyncMode } from '../lib/types.mjs';
import { SETPOINT_MAX, SETPOINT_MIN } from '../lib/constants.mjs';
import { shouldWrite, type LastWrite } from '../lib/writePolicy.mjs';
import type { CapValue, DeviceSummary, HomeyApiHub, SourceBinding } from './hub.mjs';
import {
  CALIBRATION_ABS_MAX, EXTERNAL_TEMPERATURE_MAX, EXTERNAL_TEMPERATURE_MIN,
  type ValveBackend,
} from './valveBackend.mjs';

type Logger = (...args: unknown[]) => void;

export type EmitterWriteMode = 'valve' | 'setpoint';

export interface EmitterCapabilities {
  setpoint: boolean;
  valve: boolean;
  externalTemp: boolean;
  calibration: boolean;
  heatingState: boolean;
}

export interface EmitterAdapter {
  readonly deviceId: string;
  readonly caps: EmitterCapabilities;
  get mode(): EmitterWriteMode;
  get available(): boolean;
  applySetpoint(v: number, nowMs: number): Promise<void>;
  applyValve(percent: number, nowMs: number): Promise<void>;
  pushRoomTemperature(t: number, mode: SyncMode, nowMs: number): Promise<void>;
  readHeating(nowMs: number): Reading<boolean> | null;
  readBattery(nowMs: number): Reading<number> | null;
  /** SPEC §11.1 : `onDeleted` et `onUninit`. Ne lève jamais — une sortie propre doit aller au bout. */
  restoreSafeState(userSetpoint: number): Promise<void>;

  // --- Cycle de vie, au-delà du contrat minimal -----------------------------
  /** (Re)lit les capabilities de l'appareil et en déduit le mode. Idempotent. */
  detect(nowMs: number): Promise<void>;
  /** Force la prochaine `detect()` à repartir du réel, après une reconnexion du hub. */
  invalidateDetection(): void;
  /** Vrai quand une détection est due : ré-abonnement, ou simple péremption périodique. */
  detectionDue(nowMs: number): boolean;
  setBackend(backend: ValveBackend | null): void;
  destroy(): void;
}

/**
 * Seuils de fraîcheur des lectures faites SUR l'émetteur. Fournis par l'appelant et non défaillés
 * ici : `runtime/participants.mts` porte la table complète, par nature de source (SPEC §1.1).
 */
export interface EmitterFreshness {
  heatingMs: number;
  batteryMs: number;
  localTempMs: number;
}

export interface EmitterAdapterOptions {
  hub: HomeyApiHub;
  deviceId: string;
  freshness: EmitterFreshness;
  backend?: ValveBackend | null;
  /** L'utilisateur peut refuser le pilotage direct de vanne sur cet émetteur. */
  valveControl?: boolean;
  /** `auto_regulation_dtemp` — variation minimale de la température poussée vers l'émetteur. */
  syncMinDeltaC?: number;
  /** `auto_regulation_period_min` — intervalle minimal entre deux poussées. */
  syncMinIntervalMs?: number;
  /** Rafraîchissement forcé (SPEC §5.5, règle 3) : sans lui la vanne retombe sur sa dernière valeur connue. */
  forceRefreshMs?: number;
  log?: Logger;
  error?: Logger;
}

/** SPEC §5.4 : fenêtre pendant laquelle une relecture est présumée être notre propre écriture. */
export const ECHO_WINDOW_MS = 30_000;

/** Ré-détection périodique, en plus de celle jouée à chaque ré-abonnement. */
const DETECT_INTERVAL_MS = 5 * 60_000;

const DEFAULT_SYNC_MIN_DELTA_C = 0.5;
const DEFAULT_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_FORCE_REFRESH_MS = 60 * 60_000;

/** Chaque canal a sa propre mémoire d'écriture : un écho de consigne n'est pas un écho de vanne. */
type WriteChannel = 'setpoint' | 'valve' | 'externalTemp' | 'calibration';

/** Ordre de préférence : la sous-capability d'abord, l'identifiant nu en repli. */
const SETPOINT_CANDIDATES = ['target_temperature.local', 'target_temperature'] as const;
const LOCAL_TEMP_CANDIDATES = ['measure_temperature.local', 'measure_temperature'] as const;
const HEATING_CANDIDATES = ['running_state', 'onoff'] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** `running_state` vaut `heat`/`idle` ; `onoff` est booléen. Tout le reste est illisible, donc absent. */
function toHeating(value: CapValue): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'heat' || value === 'heating' || value === 'on') return true;
    if (value === 'idle' || value === 'off' || value === 'cool') return false;
  }
  return null;
}

export class HomeyEmitterAdapter implements EmitterAdapter {

  readonly deviceId: string;

  private readonly hub: HomeyApiHub;
  private readonly freshness: EmitterFreshness;
  private readonly syncMinDeltaC: number;
  private readonly syncMinIntervalMs: number;
  private readonly forceRefreshMs: number;
  private readonly log: Logger;
  private readonly logError: Logger;

  private backend: ValveBackend | null;
  private valveControl: boolean;

  private summary: DeviceSummary | null = null;
  private lastDetectAtMs: number | null = null;

  private setpointCapId: string | null = null;
  private localTempCapId: string | null = null;
  private heatingCapId: string | null = null;
  private batteryCapId: string | null = null;
  private systemModeCapId: string | null = null;

  private setpointBinding: SourceBinding | null = null;
  private localTempBinding: SourceBinding | null = null;
  private heatingBinding: SourceBinding | null = null;
  private batteryBinding: SourceBinding | null = null;
  private systemModeBinding: SourceBinding | null = null;

  private readonly lastSent = new Map<WriteChannel, LastWrite>();

  /** [ÉCART] SPEC §5.3 : écrit une seule fois, à la liaison de l'émetteur. */
  private sensorSelectApplied = false;
  /**
   * Le calibrage courant n'est lisible par AUCUNE capability Homey : on ne peut suivre que ce
   * qu'on a écrit soi-même. D'où la formule incrémentale de la SPEC §5.3, qui part de cette valeur
   * et non d'un absolu qui écraserait l'offset déjà appliqué.
   */
  private calibrationC = 0;
  private backendWarned = false;
  private destroyed = false;

  constructor(options: EmitterAdapterOptions) {
    this.hub = options.hub;
    this.deviceId = options.deviceId;
    this.freshness = options.freshness;
    this.backend = options.backend ?? null;
    this.valveControl = options.valveControl ?? true;
    this.syncMinDeltaC = options.syncMinDeltaC ?? DEFAULT_SYNC_MIN_DELTA_C;
    this.syncMinIntervalMs = options.syncMinIntervalMs ?? DEFAULT_SYNC_MIN_INTERVAL_MS;
    this.forceRefreshMs = options.forceRefreshMs ?? DEFAULT_FORCE_REFRESH_MS;
    this.log = options.log ?? (() => undefined);
    this.logError = options.error ?? (() => undefined);
  }

  // --- État -----------------------------------------------------------------

  get caps(): EmitterCapabilities {
    const backendReady = this.backend !== null && this.backend.available;
    return {
      setpoint: this.setpointCapId !== null,
      valve: backendReady,
      externalTemp: backendReady,
      calibration: backendReady,
      heatingState: this.heatingCapId !== null,
    };
  }

  /**
   * `valve` exige la dorsale MQTT : aucune capability Homey n'expose `valve_opening_degree`
   * (SPEC §1.1). Sans dorsale — ou si l'utilisateur l'a refusée pour cet émetteur — on régule par
   * consigne décalée, et c'est un mode de fonctionnement complet, pas un mode dégradé.
   */
  get mode(): EmitterWriteMode {
    return this.valveControl && this.backend !== null && this.backend.available ? 'valve' : 'setpoint';
  }

  get available(): boolean {
    return this.summary !== null && this.summary.available;
  }

  setBackend(backend: ValveBackend | null): void {
    this.backend = backend;
    // Le mode de commande change : la vanne doit être reprise en main dès le prochain pas, et
    // `temperature_sensor_select` réaffirmé sur une dorsale qui vient de revenir.
    this.sensorSelectApplied = false;
    this.backendWarned = false;
  }

  setValveControl(enabled: boolean): void {
    this.valveControl = enabled;
  }

  // --- Détection ------------------------------------------------------------

  detectionDue(nowMs: number): boolean {
    if (this.destroyed) return false;
    if (this.lastDetectAtMs === null) return true;
    return nowMs - this.lastDetectAtMs >= DETECT_INTERVAL_MS;
  }

  invalidateDetection(): void {
    this.lastDetectAtMs = null;
  }

  /**
   * Relit le jeu de capabilities réel et en déduit les identifiants à écrire.
   *
   * `summary.setable[id]` vient de `capabilitiesObj[id].setable` : une capability peut être
   * présente et en lecture seule. Sur l'installation de référence, la consigne s'écrit dans
   * `target_temperature.local` et non dans `target_temperature` nu — c'est la sous-capability
   * qu'on cherche d'abord.
   */
  async detect(nowMs: number): Promise<void> {
    if (this.destroyed) return;

    const summary = await this.hub.getDeviceSummary(this.deviceId);
    this.lastDetectAtMs = nowMs;

    if (summary === null) {
      // Device disparu : on garde les liaisons, `read()` rendra `null` et le hub les réparera.
      this.summary = null;
      return;
    }

    this.summary = summary;

    const setpointCapId = pickSetable(summary, SETPOINT_CANDIDATES);
    const localTempCapId = pickPresent(summary, LOCAL_TEMP_CANDIDATES);
    const heatingCapId = pickPresent(summary, HEATING_CANDIDATES);
    const batteryCapId = pickPresent(summary, ['measure_battery']);
    const systemModeCapId = pickSetable(summary, ['system_mode']);

    if (setpointCapId !== this.setpointCapId) {
      this.setpointBinding = this.rebind(this.setpointBinding, setpointCapId);
      this.setpointCapId = setpointCapId;
      // La consigne mémorisée porte sur l'ANCIENNE capability : la garder ferait passer la
      // première écriture sur la nouvelle pour un doublon.
      this.lastSent.delete('setpoint');
    }
    if (localTempCapId !== this.localTempCapId) {
      this.localTempBinding = this.rebind(this.localTempBinding, localTempCapId);
      this.localTempCapId = localTempCapId;
    }
    if (heatingCapId !== this.heatingCapId) {
      this.heatingBinding = this.rebind(this.heatingBinding, heatingCapId);
      this.heatingCapId = heatingCapId;
    }
    if (batteryCapId !== this.batteryCapId) {
      this.batteryBinding = this.rebind(this.batteryBinding, batteryCapId);
      this.batteryCapId = batteryCapId;
    }
    if (systemModeCapId !== this.systemModeCapId) {
      this.systemModeBinding = this.rebind(this.systemModeBinding, systemModeCapId);
      this.systemModeCapId = systemModeCapId;
    }

    if (this.setpointCapId === null) {
      this.logError(`Émetteur ${summary.name} : aucune consigne inscriptible, aucune écriture ne partira.`);
    }
  }

  private rebind(previous: SourceBinding | null, capabilityId: string | null): SourceBinding | null {
    previous?.destroy();
    if (capabilityId === null) return null;
    return this.hub.bind(this.deviceId, capabilityId);
  }

  // --- Écritures ------------------------------------------------------------

  /**
   * `maxIntervalMs` et non un seuil de variation : la déduplication fine a déjà été tranchée par
   * le noyau (`stepVTherm`, qui aligne la consigne sur le pas de 0,5 °C AVANT de comparer).
   * Ce qui reste ici, c'est le rafraîchissement forcé de la SPEC §5.5, que le noyau ne fait pas.
   */
  async applySetpoint(v: number, nowMs: number): Promise<void> {
    const binding = this.setpointBinding;
    if (binding === null) return;

    const value = clamp(v, SETPOINT_MIN, SETPOINT_MAX);
    const wrote = await binding.write(value, { nowMs, maxIntervalMs: this.forceRefreshMs });
    if (wrote) this.remember('setpoint', value, nowMs);
  }

  async applyValve(percent: number, nowMs: number): Promise<void> {
    const backend = this.backend;
    if (backend === null || !backend.available) {
      this.warnNoBackend();
      return;
    }

    // Pas de 1 % accepté par la TRVZB : arrondir AVANT de comparer, sinon 42,4 et 42,6 comptent
    // pour deux écritures vers un appareil qui les ramène toutes deux à 42.
    const value = clamp(Math.round(percent), 0, 100);
    if (!this.allowWrite('valve', value, nowMs, { maxIntervalMs: this.forceRefreshMs })) return;

    await backend.setValveOpening(this.deviceId, value);
    this.remember('valve', value, nowMs);
  }

  /**
   * Synchronisation du capteur de pièce vers l'émetteur (SPEC §5.3).
   *
   * Sans elle, la TRVZB régule sur son propre thermomètre, collé au radiateur — c'est-à-dire sur
   * une température qui n'est celle de personne.
   */
  async pushRoomTemperature(t: number, mode: SyncMode, nowMs: number): Promise<void> {
    if (mode === 'off' || !Number.isFinite(t)) return;

    const backend = this.backend;
    if (backend === null || !backend.available) {
      this.warnNoBackend();
      return;
    }

    const opts = {
      minDelta: this.syncMinDeltaC,
      minIntervalMs: this.syncMinIntervalMs,
      maxIntervalMs: this.forceRefreshMs,
    };

    if (mode === 'external') {
      if (!this.sensorSelectApplied) {
        await backend.setTemperatureSensorSelect(this.deviceId, 'external');
        this.sensorSelectApplied = true;
      }

      const value = roundTo(clamp(t, EXTERNAL_TEMPERATURE_MIN, EXTERNAL_TEMPERATURE_MAX), 1);
      if (!this.allowWrite('externalTemp', value, nowMs, opts)) return;

      await backend.setExternalTemperature(this.deviceId, value);
      this.remember('externalTemp', value, nowMs);
      return;
    }

    // Mode calibrage : INCRÉMENTAL. `local_temperature` reflète déjà le calibrage appliqué ;
    // écrire `T_pièce − local_temperature` en absolu écraserait l'offset courant et l'erreur se
    // cumulerait à chaque écriture.
    if (this.isSettling('calibration', nowMs)) return;

    const local = this.readNumber(this.localTempBinding, nowMs, this.freshness.localTempMs);
    if (local === null || local.stale) return;

    const value = clamp(
      roundTo(this.calibrationC + (t - local.value), 1),
      -CALIBRATION_ABS_MAX,
      CALIBRATION_ABS_MAX,
    );
    if (!this.allowWrite('calibration', value, nowMs, opts)) return;

    await backend.setLocalTemperatureCalibration(this.deviceId, value);
    this.calibrationC = value;
    this.remember('calibration', value, nowMs);
  }

  // --- Lectures -------------------------------------------------------------

  readHeating(nowMs: number): Reading<boolean> | null {
    const binding = this.heatingBinding;
    if (binding === null) return null;

    const reading = binding.read(nowMs, this.freshness.heatingMs);
    if (reading === null) return null;

    const value = toHeating(reading.value);
    if (value === null) return null;

    return { value, atMs: reading.atMs, stale: reading.stale };
  }

  readBattery(nowMs: number): Reading<number> | null {
    return this.readNumber(this.batteryBinding, nowMs, this.freshness.batteryMs);
  }

  /**
   * La consigne telle que l'émetteur la porte, débarrassée de nos propres échos (SPEC §5.4).
   *
   * `null` quand la valeur relue est celle qu'on vient d'envoyer, ou qu'elle arrive dans les 30 s
   * suivant une écriture. C'est ce filtre qui empêche de reprendre `consigne + offset` pour une
   * consigne utilisateur et de réappliquer l'offset par-dessus jusqu'à la butée de la vanne.
   */
  readSetpoint(nowMs: number): Reading<number> | null {
    const reading = this.readNumber(this.setpointBinding, nowMs, Number.POSITIVE_INFINITY);
    if (reading === null) return null;

    const last = this.lastSent.get('setpoint');
    if (last !== undefined) {
      if (last.value === reading.value) return null;
      if (nowMs - last.atMs < ECHO_WINDOW_MS) return null;
    }
    return reading;
  }

  // --- Sortie propre --------------------------------------------------------

  /**
   * SPEC §11.1 : `system_mode` à `auto`, consigne = consigne utilisateur BRUTE, sans offset.
   *
   * Sans ça, la vanne reste figée sur la dernière valeur écrite par une app qui ne la pilote plus
   * — une consigne à 24 °C dans une pièce vide, sans personne pour la corriger. Chaque étape est
   * isolée : celle qui échoue ne doit pas empêcher les suivantes.
   */
  async restoreSafeState(userSetpoint: number): Promise<void> {
    const nowMs = Date.now();
    // Un rappel périodique de 1 ms : la remise en état sûr doit partir même si la valeur visée est
    // exactement la dernière écrite. C'est le seul endroit où la déduplication doit être forcée.
    const force = { nowMs, maxIntervalMs: 1 };

    const backend = this.backend;
    if (backend !== null && backend.available) {
      // Rendus AVANT la consigne : une vanne laissée à 20 % d'ouverture, ou attendant une
      // température externe que plus personne ne publie, ne chauffera pas quelle que soit sa consigne.
      await this.safely('valve_opening_degree', () => backend.setValveOpening(this.deviceId, 100));
      if (this.sensorSelectApplied) {
        await this.safely('temperature_sensor_select', () => backend.setTemperatureSensorSelect(this.deviceId, 'internal'));
      }
      if (this.calibrationC !== 0) {
        await this.safely('local_temperature_calibration', () => backend.setLocalTemperatureCalibration(this.deviceId, 0));
      }
    }

    const systemMode = this.systemModeBinding;
    if (systemMode !== null) {
      await this.safely('system_mode', () => systemMode.write('auto', force));
    }

    const setpoint = this.setpointBinding;
    if (setpoint !== null && Number.isFinite(userSetpoint)) {
      const value = clamp(userSetpoint, SETPOINT_MIN, SETPOINT_MAX);
      await this.safely('target_temperature', () => setpoint.write(value, force));
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const binding of [
      this.setpointBinding, this.localTempBinding, this.heatingBinding,
      this.batteryBinding, this.systemModeBinding,
    ]) {
      binding?.destroy();
    }
    this.setpointBinding = null;
    this.localTempBinding = null;
    this.heatingBinding = null;
    this.batteryBinding = null;
    this.systemModeBinding = null;
  }

  // --- Outils privés --------------------------------------------------------

  private allowWrite(
    channel: WriteChannel,
    value: number,
    nowMs: number,
    opts: { minDelta?: number; minIntervalMs?: number; maxIntervalMs?: number },
  ): boolean {
    return shouldWrite(this.lastSent.get(channel) ?? null, value, opts, nowMs).write;
  }

  private remember(channel: WriteChannel, value: number, atMs: number): void {
    this.lastSent.set(channel, { value, atMs });
  }

  /** Vrai tant que l'appareil n'a pas eu le temps de digérer notre dernière écriture (SPEC §5.4). */
  private isSettling(channel: WriteChannel, nowMs: number): boolean {
    const last = this.lastSent.get(channel);
    return last !== undefined && nowMs - last.atMs < ECHO_WINDOW_MS;
  }

  private readNumber(
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

  /** Une seule fois par indisponibilité : un avertissement à chaque pas serait un bandeau ignoré. */
  private warnNoBackend(): void {
    if (this.backendWarned) return;
    this.backendWarned = true;
    this.log(
      `Émetteur ${this.deviceId} : dorsale MQTT indisponible — ouverture de vanne et injection de `
      + 'température de pièce inactives, régulation par consigne décalée (SPEC §1.1).',
    );
  }

  private async safely(label: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.logError(`Remise en état sûr de ${this.deviceId} (${label}) :`, err);
    }
  }
}

/** Premier candidat réellement INSCRIPTIBLE. La présence de l'identifiant ne suffit pas (PLAN lot 4). */
function pickSetable(summary: DeviceSummary, candidates: readonly string[]): string | null {
  for (const id of candidates) {
    if (summary.capabilities.includes(id) && summary.setable[id] === true) return id;
  }
  return null;
}

function pickPresent(summary: DeviceSummary, candidates: readonly string[]): string | null {
  for (const id of candidates) {
    if (summary.capabilities.includes(id)) return id;
  }
  return null;
}
