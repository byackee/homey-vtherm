/**
 * `drivers/vtherm/device.mts` — le câblage d'un thermostat.
 *
 * Ce fichier ne régule rien et ne décide rien. Il traduit des réglages Homey en `VThermConfig`,
 * fournit au participant l'implémentation de `DeviceHost`, et relaie vers les cartes Flow les
 * événements que le noyau a décidé d'émettre. Aucun `if (précédent !== courant)` n'a sa place ici :
 * un déclencheur qui naîtrait dans ce fichier serait une décision métier qu'aucun test ne couvre.
 */

import Homey from 'homey';

import {
  DEFAULT_AUTO_REGULATION_DTEMP, DEFAULT_AUTO_REGULATION_PERIOD_MIN, DEFAULT_CYCLE_MIN,
  DEFAULT_EXPERT_REGULATION, DEFAULT_MAX_CLOSING_DEGREE, DEFAULT_MAX_OPENING_DEGREE,
  DEFAULT_MIN_OPENING_DEGREE, DEFAULT_MOTION_DELAY_SEC, DEFAULT_MOTION_OFF_DELAY_SEC,
  DEFAULT_OPENING_THRESHOLD, DEFAULT_PRESET_TEMPS, DEFAULT_REGULATION_THRESHOLD, DEFAULT_SLOPE,
  DEFAULT_TPI, DEFAULT_WINDOW, DEFAULT_AWAY_TEMPS,
} from '../../lib/constants.mjs';
import type { Preset, VThermConfig } from '../../lib/types.mjs';
import type { CapValue } from '../../runtime/hub.mjs';
import { HomeyEmitterAdapter } from '../../runtime/emitter.mjs';
import {
  FRESHNESS, VThermParticipant,
  type DeviceHost, type ParticipantEvent, type PresenceOverride, type VThermSourceBindings,
} from '../../runtime/participants.mjs';
import type VThermApp from '../../app.mjs';

/**
 * Les six sources désignées au pairing, et la clé de `store` qui porte chacune.
 *
 * Les clés sont figées : elles voyagent de la vue de pairing jusqu'ici, et `onRepair` les réécrit
 * une par une quand un appareil Zigbee2MQTT ré-appairé a changé d'identifiant.
 */
export const SOURCE_STORE_KEYS = {
  room: 'roomId',
  emitter: 'emitterId',
  outdoor: 'outdoorId',
  window: 'windowId',
  motion: 'motionId',
  presence: 'presenceId',
} as const;

export type SourceKey = keyof typeof SOURCE_STORE_KEYS;

/** Capability lue sur chaque source. Le pairing propose les mêmes, il n'y a qu'une vérité. */
const SOURCE_CAPABILITIES: Record<SourceKey, string> = {
  room: 'measure_temperature',
  emitter: 'target_temperature',
  outdoor: 'measure_temperature',
  window: 'alarm_contact',
  motion: 'alarm_motion',
  presence: 'alarm_motion',
};

/** Sans elles, il n'y a pas de thermostat : une mesure de pièce et quelque chose à piloter. */
const REQUIRED_SOURCES: readonly SourceKey[] = ['room', 'emitter'];

const PRESETS: readonly Preset[] = ['frost', 'eco', 'comfort', 'boost', 'activity', 'none'];
const MOTION_PRESETS = ['frost', 'eco', 'comfort', 'boost'] as const;
const REGULATION_MODES = ['none', 'slow', 'light', 'medium', 'strong', 'expert'] as const;
const WINDOW_MODES = ['off', 'sensor', 'auto'] as const;
const WINDOW_ACTIONS = ['turn_off', 'frost', 'eco', 'fan_only'] as const;
const SYNC_MODES = ['off', 'external', 'calibration'] as const;

/**
 * Réglages de la dorsale de synchronisation figés à la construction de l'adaptateur d'émetteur.
 * `EmitterAdapter` n'expose aucun mutateur pour eux : leur changement ne prend effet qu'au
 * redémarrage de l'app, et `onSettings` le dit à l'utilisateur plutôt que de mentir par omission.
 */
const RESTART_ONLY_SETTINGS: readonly string[] = ['regulation_dtemp', 'regulation_period_min'];

const MS_PER_MINUTE = 60_000;

export default class VThermDevice extends Homey.Device {

  private participant: VThermParticipant | null = null;
  private sources: VThermSourceBindings = {
    room: null, outdoor: null, windowContact: null, motion: null, presence: null,
  };

  /**
   * Forçage de présence par carte Flow, mémorisé ici en plus du participant : la condition
   * « quelqu'un est présent » doit rendre la même réponse que la régulation, et le participant
   * n'expose pas son forçage.
   */
  private presenceOverride: PresenceOverride = 'auto';

  private registered = false;
  /** Homey refuse deux écouteurs sur la même capability, et `onInit` se rejoue à la réparation. */
  private listenersRegistered = false;

  override async onInit(): Promise<void> {
    const emitterId = this.sourceId('emitter');
    if (emitterId === null) {
      // Un thermostat sans émetteur ne peut rien piloter. On le dit et on s'arrête là plutôt que
      // de tourner à vide : `onRepair` est la voie pour lui en redonner un.
      await this.setUnavailable(this.homey.__('device.no_emitter'));
      return;
    }

    const app = this.app;
    const hub = app.hub;
    const config = this.readConfig();
    const settings = this.settings;

    for (const key of ['room', 'outdoor', 'window', 'motion', 'presence'] as const) {
      this.attachSource(key);
    }

    const emitter = new HomeyEmitterAdapter({
      hub,
      deviceId: emitterId,
      freshness: {
        heatingMs: FRESHNESS.emitterHeatingMs,
        batteryMs: FRESHNESS.emitterBatteryMs,
        localTempMs: FRESHNESS.emitterLocalTempMs,
      },
      syncMinDeltaC: config.autoRegulationDtemp,
      syncMinIntervalMs: config.autoRegulationPeriodMin * MS_PER_MINUTE,
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this.participant = new VThermParticipant({
      host: this.deviceHost(),
      emitter,
      sources: this.sources,
      config,
      syncMode: pick(settings, 'sync_mode', SYNC_MODES, 'off'),
      controlsBoiler: bool(settings, 'controls_boiler', true),
      centralMode: () => app.centralMode(),
      requestTick: (reason) => app.requestTick(`${this.deviceId()}:${reason}`),
      // Un thermostat neuf démarre sur Confort : sa consigne manuelle est celle du preset, pour
      // qu'un passage en Manuel ne fasse pas chuter la pièce à une valeur arbitraire.
      defaults: { preset: 'comfort', manualSetpoint: config.presetTemps.comfort },
      nowMs: Date.now(),
    });

    this.registerListeners();

    app.registerVTherm(this.participant);
    this.registered = true;
    await this.setAvailable();
  }

  // --- Contrat avec le participant -------------------------------------------

  /** Tout ce que le participant sait de Homey. Volontairement minuscule (SPEC, PLAN lot 4). */
  private deviceHost(): DeviceHost {
    return {
      id: this.deviceId(),
      getCapabilityValue: (capabilityId) => {
        if (!this.hasCapability(capabilityId)) return null;
        const value: unknown = this.getCapabilityValue(capabilityId);
        return isCapValue(value) ? value : null;
      },
      setCapabilityValue: async (capabilityId, value) => {
        if (!this.hasCapability(capabilityId)) return;
        await this.setCapabilityValue(capabilityId, value);
      },
      setWarning: async (message) => {
        await this.setWarning(message);
      },
      getStoreValue: (key) => this.getStoreValue(key) as unknown,
      setStoreValue: async (key, value) => {
        await this.setStoreValue(key, value);
      },
      triggerFlow: (event) => this.triggerFlowCard(event),
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    };
  }

  /**
   * Traduction événement du noyau → carte Flow déclarée.
   *
   * `sensor_quiet` s'appelle `sensor_went_quiet` côté carte, et `sensor_recovered`,
   * `preset_changed` et `state_changed` n'ont pas de carte propre : les deux derniers sont déjà
   * couverts par les déclencheurs `_changed` automatiques des capabilities. Un événement sans
   * carte est ignoré, jamais une erreur.
   */
  private async triggerFlowCard(event: ParticipantEvent): Promise<void> {
    switch (event.kind) {
      case 'demand_started':
        await this.trigger('demand_started', { power_percent: event.percent });
        return;
      case 'demand_stopped':
        await this.trigger('demand_stopped', {});
        return;
      case 'window_opened':
        await this.trigger('window_opened', {});
        return;
      case 'window_closed':
        await this.trigger('window_closed', {});
        return;
      case 'sensor_quiet':
        await this.trigger('sensor_went_quiet', {});
        return;
      default:
        return;
    }
  }

  private async trigger(cardId: string, tokens: Record<string, unknown>): Promise<void> {
    await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, tokens, {});
  }

  // --- Interface utilisateur --------------------------------------------------

  private registerListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    // La valeur est posée ici plutôt que laissée au SDK : le participant la relit à son prochain
    // pas, qui peut partir avant que Homey n'ait appliqué la demande.
    this.registerCapabilityListener('onoff', async (value: unknown) => {
      await this.setCapabilityValue('onoff', value === true);
      this.app.requestTick(`${this.deviceId()}:onoff`);
    });

    this.registerCapabilityListener('target_temperature', async (value: unknown) => {
      if (typeof value !== 'number') return;
      this.requireParticipant().setManualSetpoint(value);
    });

    this.registerCapabilityListener('vtherm_preset', async (value: unknown) => {
      const preset = toPreset(value);
      if (preset === null) return;
      this.requireParticipant().setPreset(preset);
    });
  }

  override async onSettings(event: {
    oldSettings: Record<string, boolean | string | number | undefined | null>;
    newSettings: Record<string, boolean | string | number | undefined | null>;
    changedKeys: string[];
  }): Promise<string | void> {
    const participant = this.participant;
    if (participant === null) return;

    // `getSettings()` rend encore les anciennes valeurs à cet instant : la configuration se
    // reconstruit sur `newSettings`, sinon les réglages n'entreraient en vigueur qu'au suivant.
    const settings = event.newSettings;
    participant.updateConfig(this.readConfig(settings));
    participant.setSyncMode(pick(settings, 'sync_mode', SYNC_MODES, 'off'));
    participant.setControlsBoiler(bool(settings, 'controls_boiler', true));

    if (event.changedKeys.some((key) => RESTART_ONLY_SETTINGS.includes(key))) {
      return this.homey.__('device.sync_restart');
    }
  }

  // --- Cartes Flow : conditions ----------------------------------------------

  currentPreset(): string | null {
    const value: unknown = this.getCapabilityValue('vtherm_preset');
    return typeof value === 'string' ? value : null;
  }

  isWindowOpen(): boolean {
    return this.getCapabilityValue('alarm_contact') === true;
  }

  isCallingForHeat(): boolean {
    return this.participant?.demand.kind === 'active';
  }

  /**
   * Même lecture que celle qui alimente le noyau : le forçage Flow prime, une mesure périmée ou
   * absente ne déclare personne absent. Sans cet alignement, une condition pourrait dire « absent »
   * pendant que la régulation applique une température de présence.
   */
  isSomeoneHome(): boolean {
    if (this.presenceOverride !== 'auto') return this.presenceOverride === 'home';

    const reading = this.sources.presence?.read(Date.now(), FRESHNESS.presenceMs) ?? null;
    if (reading === null || reading.stale) return true;
    return reading.value !== false && reading.value !== 0;
  }

  // --- Cartes Flow : actions --------------------------------------------------

  applyPreset(preset: Preset): void {
    this.requireParticipant().setPreset(preset);
  }

  applyTimedPreset(preset: Preset, minutes: number): void {
    this.requireParticipant().setTimedPreset(preset, minutes, Date.now());
  }

  cancelTimedPreset(): void {
    this.requireParticipant().cancelTimedPreset();
  }

  applyTargetTemperature(temperature: number): void {
    this.requireParticipant().setManualSetpoint(temperature);
  }

  applyWindowBypass(bypass: boolean): void {
    this.requireParticipant().setWindowBypass(bypass);
  }

  applyPresenceOverride(override: PresenceOverride): void {
    this.presenceOverride = override;
    this.requireParticipant().forcePresence(override);
  }

  /**
   * Les coefficients réglés par Flow sont écrits dans les réglages du device : sans ça ils
   * disparaîtraient au redémarrage et l'utilisateur verrait dans l'interface des valeurs qui ne
   * sont pas celles qui régulent.
   */
  async applyTpiCoefficients(coefInt: number, coefExt: number): Promise<void> {
    const participant = this.requireParticipant();
    await this.setSettings({ tpi_coef_int: coefInt, tpi_coef_ext: coefExt });
    participant.updateConfig(this.readConfig());
  }

  // --- Réparation -------------------------------------------------------------

  /**
   * Re-désigne une source sans refaire le pairing (risque n°12 du PLAN).
   *
   * Un appareil Zigbee2MQTT ré-appairé revient avec un autre identifiant : le `store` pointe alors
   * dans le vide et la pièce cesse d'être régulée en silence. L'écriture est immédiate — une
   * session de réparation peut se fermer sans dernière vue, et un choix gardé en mémoire serait
   * perdu.
   */
  async rebindSource(key: SourceKey, deviceId: string | null): Promise<void> {
    if (deviceId === null && REQUIRED_SOURCES.includes(key)) {
      throw new Error(this.homey.__('pair.error.incomplete'));
    }

    await this.setStoreValue(SOURCE_STORE_KEYS[key], deviceId);

    if (key === 'emitter') {
      // L'adaptateur d'émetteur tient ses propres liaisons et n'est pas remplaçable à chaud :
      // l'appareil se recharge pour repartir du nouvel identifiant.
      await this.reload();
      return;
    }

    this.attachSource(key);
    const participant = this.participant;
    if (participant === null) return;

    // Le mouvement conditionne le preset Activité : sa présence ou son absence change la config.
    if (key === 'motion') participant.updateConfig(this.readConfig());
    this.app.requestTick(`${this.deviceId()}:repair:${key}`);
  }

  /** Ré-instancie le device au complet. Utilisé quand l'émetteur change d'identifiant. */
  private async reload(): Promise<void> {
    await this.teardown();
    await this.onInit();
  }

  // --- Cycle de vie -----------------------------------------------------------

  override async onUninit(): Promise<void> {
    await this.teardown();
  }

  override async onDeleted(): Promise<void> {
    await this.teardown();
  }

  /**
   * SPEC §11.1 : l'émetteur est rendu dans un état sûr AVANT que les liaisons ne disparaissent.
   * Une vanne laissée figée sur la dernière consigne d'une app qui ne la pilote plus, c'est une
   * pièce vide chauffée sans personne pour la corriger.
   */
  private async teardown(): Promise<void> {
    const participant = this.participant;
    this.participant = null;

    if (participant === null) return;

    if (this.registered) {
      this.app.unregisterVTherm(participant.tickId);
      this.registered = false;
    }

    try {
      await participant.restoreSafeState();
    } catch (err) {
      this.error('Remise en état sûr de l\'émetteur :', err);
    }

    participant.destroy();
    this.sources = { room: null, outdoor: null, windowContact: null, motion: null, presence: null };
  }

  // --- Sources ----------------------------------------------------------------

  /**
   * (Re)crée la liaison d'une source. Le rappel `onChange` demande un tick : une nouvelle mesure
   * doit être régulée sans attendre le battement suivant, et l'ordonnanceur coalesce les rafales.
   */
  private attachSource(key: Exclude<SourceKey, 'emitter'>): void {
    const slot = SOURCE_SLOTS[key];
    this.sources[slot]?.destroy();

    const deviceId = this.sourceId(key);
    if (deviceId === null) {
      this.sources[slot] = null;
      return;
    }

    this.sources[slot] = this.app.hub.bind(
      deviceId,
      SOURCE_CAPABILITIES[key],
      () => this.app.requestTick(`${this.deviceId()}:${key}`),
    );
  }

  private sourceId(key: SourceKey): string | null {
    const value: unknown = this.getStoreValue(SOURCE_STORE_KEYS[key]);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  // --- Réglages ---------------------------------------------------------------

  private get settings(): Record<string, unknown> {
    return this.getSettings() as Record<string, unknown>;
  }

  private readConfig(raw?: Record<string, unknown>): VThermConfig {
    const s = raw ?? this.settings;

    return {
      tpi: {
        coefInt: num(s, 'tpi_coef_int', DEFAULT_TPI.coefInt),
        coefExt: num(s, 'tpi_coef_ext', DEFAULT_TPI.coefExt),
        thresholdHigh: num(s, 'tpi_threshold_high', DEFAULT_TPI.thresholdHigh),
        thresholdLow: num(s, 'tpi_threshold_low', DEFAULT_TPI.thresholdLow),
      },
      slope: DEFAULT_SLOPE,
      window: {
        mode: pick(s, 'window_mode', WINDOW_MODES, DEFAULT_WINDOW.mode),
        delaySec: num(s, 'window_delay', DEFAULT_WINDOW.delaySec),
        offDelaySec: num(s, 'window_off_delay', DEFAULT_WINDOW.offDelaySec),
        action: pick(s, 'window_action', WINDOW_ACTIONS, DEFAULT_WINDOW.action),
        autoOpenThreshold: num(s, 'window_auto_open_threshold', DEFAULT_WINDOW.autoOpenThreshold),
        autoCloseThreshold: num(s, 'window_auto_close_threshold', DEFAULT_WINDOW.autoCloseThreshold),
        // Réglage en minutes, contrat du noyau en secondes.
        autoMaxDurationSec: num(s, 'window_auto_max_duration', DEFAULT_WINDOW.autoMaxDurationSec / 60) * 60,
      },
      presetTemps: {
        frost: num(s, 'temp_frost', DEFAULT_PRESET_TEMPS.frost),
        eco: num(s, 'temp_eco', DEFAULT_PRESET_TEMPS.eco),
        comfort: num(s, 'temp_comfort', DEFAULT_PRESET_TEMPS.comfort),
        boost: num(s, 'temp_boost', DEFAULT_PRESET_TEMPS.boost),
      },
      awayTemps: {
        eco: num(s, 'away_eco', DEFAULT_AWAY_TEMPS.eco),
        comfort: num(s, 'away_comfort', DEFAULT_AWAY_TEMPS.comfort),
        boost: num(s, 'away_boost', DEFAULT_AWAY_TEMPS.boost),
      },
      motion: {
        // Pas de détecteur lié, pas de preset Activité : la question ne se pose même pas.
        enabled: this.sourceId('motion') !== null,
        motionPreset: pick(s, 'motion_preset', MOTION_PRESETS, 'comfort'),
        noMotionPreset: pick(s, 'no_motion_preset', MOTION_PRESETS, 'eco'),
        delaySec: num(s, 'motion_delay', DEFAULT_MOTION_DELAY_SEC),
        offDelaySec: num(s, 'motion_off_delay', DEFAULT_MOTION_OFF_DELAY_SEC),
      },
      regulationMode: pick(s, 'regulation_mode', REGULATION_MODES, 'medium'),
      expertRegulation: {
        kp: num(s, 'expert_kp', DEFAULT_EXPERT_REGULATION.kp),
        ki: num(s, 'expert_ki', DEFAULT_EXPERT_REGULATION.ki),
        kExt: num(s, 'expert_k_ext', DEFAULT_EXPERT_REGULATION.kExt),
        offsetMax: num(s, 'expert_offset_max', DEFAULT_EXPERT_REGULATION.offsetMax),
        accumulatedErrorThreshold: num(s, 'expert_acc_threshold', DEFAULT_EXPERT_REGULATION.accumulatedErrorThreshold),
        overheatProtection: bool(s, 'expert_overheat', DEFAULT_EXPERT_REGULATION.overheatProtection),
      },
      minOpeningDegree: num(s, 'min_opening_degree', DEFAULT_MIN_OPENING_DEGREE),
      maxOpeningDegree: num(s, 'max_opening_degree', DEFAULT_MAX_OPENING_DEGREE),
      maxClosingDegree: num(s, 'max_closing_degree', DEFAULT_MAX_CLOSING_DEGREE),
      // Le réglage se saisit en %, le noyau attend une fraction sur l'échelle de `on_percent`.
      openingThreshold: num(s, 'opening_threshold', DEFAULT_OPENING_THRESHOLD * 100) / 100,
      regulationThreshold: num(s, 'regulation_threshold', DEFAULT_REGULATION_THRESHOLD),
      autoRegulationDtemp: num(s, 'regulation_dtemp', DEFAULT_AUTO_REGULATION_DTEMP),
      autoRegulationPeriodMin: num(s, 'regulation_period_min', DEFAULT_AUTO_REGULATION_PERIOD_MIN),
      cycleMin: num(s, 'cycle_min', DEFAULT_CYCLE_MIN),
      useCentralMode: bool(s, 'use_central_mode', true),
    };
  }

  // --- Outils -----------------------------------------------------------------

  private get app(): VThermApp {
    return this.homey.app as VThermApp;
  }

  /** `data.id`, tiré une seule fois au pairing : c'est l'identité du participant. */
  private deviceId(): string {
    const data = this.getData() as { id?: unknown };
    return typeof data.id === 'string' ? data.id : this.getName();
  }

  private requireParticipant(): VThermParticipant {
    const participant = this.participant;
    if (participant === null) throw new Error(this.homey.__('device.no_emitter'));
    return participant;
  }
}

/** Correspondance entre les clés du `store` et les champs de `VThermSourceBindings`. */
const SOURCE_SLOTS: Record<Exclude<SourceKey, 'emitter'>, keyof VThermSourceBindings> = {
  room: 'room',
  outdoor: 'outdoor',
  window: 'windowContact',
  motion: 'motion',
  presence: 'presence',
};

function isCapValue(value: unknown): value is CapValue {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

export function toPreset(value: unknown): Preset | null {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value)
    ? value as Preset
    : null;
}

/** Un réglage illisible retombe sur le défaut : jamais sur `NaN`, qui contaminerait tout le pas. */
function num(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === 'boolean' ? value : fallback;
}

function pick<T extends string>(
  settings: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = settings[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}
