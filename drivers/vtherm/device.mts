/**
 * `drivers/vtherm/device.mts` — le câblage d'un thermostat.
 *
 * Ce fichier ne régule rien et ne décide rien. Il traduit des réglages Homey en `VThermConfig`,
 * fournit au participant l'implémentation de `DeviceHost`, et relaie vers les cartes Flow les
 * événements que le noyau a décidé d'émettre. Aucun `if (précédent !== courant)` n'a sa place ici :
 * un déclencheur qui naîtrait dans ce fichier serait une décision métier qu'aucun test ne couvre.
 */

import { resolveCapabilityId } from '../../lib/capabilityMatch.mjs';
import {
  EMITTER_LIST_STORE_KEY, MAX_EMITTERS, SOURCE_STORE_KEYS, SOURCE_CAPABILITIES, EMITTER_CLASSES,
  emitterExtraCapabilities, emitterStorePatch, readEmitterIds, type SourceKey,
} from '../../lib/sources.mjs';
import {
  VTHERM_EXPLAIN_IDS, changedSettings, explainSettings, joinLinkedLabels,
} from '../../lib/settingsExplain.mjs';
import Homey from 'homey';

import {
  DEFAULT_AUTO_REGULATION_DTEMP, DEFAULT_AUTO_REGULATION_PERIOD_MIN, DEFAULT_CYCLE_MIN,
  DEFAULT_EXPERT_REGULATION, DEFAULT_MAX_CLOSING_DEGREE, DEFAULT_MAX_OPENING_DEGREE,
  DEFAULT_MIN_OPENING_DEGREE, DEFAULT_MOTION_DELAY_SEC, DEFAULT_MOTION_OFF_DELAY_SEC,
  DEFAULT_MIN_ACTIVATION_SEC, DEFAULT_MIN_DEACTIVATION_SEC,
  DEFAULT_OPENING_THRESHOLD, DEFAULT_PRESET_TEMPS, DEFAULT_REGULATION_THRESHOLD, DEFAULT_SLOPE,
  DEFAULT_TPI, DEFAULT_WINDOW, DEFAULT_AWAY_TEMPS, DEFAULT_SAFETY } from '../../lib/constants.mjs';
import type { Preset, VThermConfig } from '../../lib/types.mjs';
import type { CapValue } from '../../runtime/hub.mjs';
import { HomeyEmitterAdapter, type EmitterAdapter } from '../../runtime/emitter.mjs';
import { MultiEmitterAdapter } from '../../runtime/multiEmitter.mjs';
import {
  FRESHNESS, VThermParticipant,
  type DeviceHost, type ParticipantEvent, type PresenceOverride, type VThermSourceBindings,
} from '../../runtime/participants.mjs';
import type VThermApp from '../../app.mjs';

export {
  EMITTER_LIST_STORE_KEY, MAX_EMITTERS, SOURCE_STORE_KEYS, SOURCE_CAPABILITIES, EMITTER_CLASSES,
  emitterExtraCapabilities, emitterStorePatch, readEmitterIds,
} from '../../lib/sources.mjs';
export type { SourceKey } from '../../lib/sources.mjs';


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

  /**
   * Sources liées sur une capability DEVINÉE, faute de hub au moment de l'appairage ou du
   * démarrage. Voir `resolveAndBind` : ces liaisons ne tirent jamais si la capability devinée
   * n'existe pas sur l'appareil, et rien ne les répare — `reattachAll` rejoue le même identifiant.
   */
  private readonly provisionalSources = new Set<Exclude<SourceKey, 'emitter'>>();
  /** Retenu pour pouvoir se désabonner : un appareil supprimé ne doit pas laisser d'écouteur. */
  private onHubConnected: (() => void) | null = null;
  /** Homey refuse deux écouteurs sur la même capability, et `onInit` se rejoue à la réparation. */
  private listenersRegistered = false;

  override async onInit(): Promise<void> {
    const emitterIds = this.emitterIds();
    if (emitterIds.length === 0) {
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

    // Une tête par appareil désigné, puis un groupe seulement s'il y en a plusieurs. Envelopper
    // systématiquement coûterait une indirection à toutes les installations existantes, dont
    // l'immense majorité n'a qu'un radiateur par pièce.
    const heads = emitterIds.map((deviceId) => new HomeyEmitterAdapter({
      hub,
      deviceId,
      freshness: {
        heatingMs: FRESHNESS.emitterHeatingMs,
        batteryMs: FRESHNESS.emitterBatteryMs,
        localTempMs: FRESHNESS.emitterLocalTempMs,
      },
      syncMinDeltaC: config.autoRegulationDtemp,
      syncMinIntervalMs: config.autoRegulationPeriodMin * MS_PER_MINUTE,
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    }));

    const emitter: EmitterAdapter = heads.length === 1
      ? heads[0]!
      : new MultiEmitterAdapter({
        heads,
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

    // `onoff` est une entrée du noyau, pas une de ses sorties : rien ne la publie donc, et elle
    // resterait `null` après un pairing. Le réducteur traite `null` comme allumé — c'est le bon
    // défaut — mais la tuile afficherait un interrupteur dans un état indéfini, en désaccord avec
    // ce que l'app fait réellement. On aligne l'affichage sur le comportement, une seule fois.
    //
    // APRÈS `setAvailable()`, et ce n'est pas un détail de style : « When a device is marked as
    // unavailable, all capabilities and Flow actions will be prevented » (doc Athom, Devices ›
    // Availability). Un thermostat appairé sans émetteur est marqué indisponible plus haut, et cet
    // état survit au redémarrage — l'écriture partait donc dans le vide au démarrage suivant,
    // c'est-à-dire précisément quand l'utilisateur venait de lier son émetteur.
    if (typeof this.getCapabilityValue('onoff') !== 'boolean') {
      await this.setCapabilityValue('onoff', true).catch((err: unknown) => {
        this.error('Initialisation de onoff :', err);
      });
    }

    // Quand le hub arrive, refaire les résolutions qui ont été devinées faute de lui. Sans cela,
    // une source liée sur la mauvaise capability ne tire jamais et n'est jamais réparée : la pièce
    // reste en sécurité jusqu'à une intervention manuelle.
    this.onHubConnected = () => { void this.resolveProvisionalSources(); };
    this.app.hub.on('connected', this.onHubConnected);

    // Les noms des appareils liés, pour les réglages. En tâche de fond : ils passent par le hub,
    // et l'initialisation ne doit pas attendre le réseau pour rendre l'appareil disponible.
    void this.refreshLinkedLabels();
    void this.refreshExplanations();
  }

  /**
   * Refait les liaisons dont la capability avait été devinée.
   *
   * `getDeviceSummary` rend `null` aussi bien quand le hub n'est pas monté que quand l'appareil n'a
   * réellement aucune des capabilities attendues. Les deux menaient au même repli — la capability
   * PRÉFÉRÉE — et une sonde qui expose `measure_temperature.local` se retrouvait liée sur
   * `measure_temperature`, qu'elle n'a pas. `makeCapabilityInstance` ne lève pas dans ce cas : la
   * liaison ne tire simplement jamais.
   */
  private async resolveProvisionalSources(): Promise<void> {
    if (this.provisionalSources.size === 0) return;

    for (const key of [...this.provisionalSources]) {
      const deviceId = this.sourceId(key);
      if (deviceId === null) {
        this.provisionalSources.delete(key);
        continue;
      }
      await this.resolveAndBind(key, SOURCE_SLOTS[key], deviceId);
    }
  }

  // --- Contrat avec le participant -------------------------------------------

  /** Tout ce que le participant sait de Homey. Volontairement minuscule (SPEC, PLAN lot 4). */
  private deviceHost(): DeviceHost {
    return {
      id: this.deviceId(),
      translate: (key) => this.homey.__(key),
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
   * `sensor_quiet` s'appelle `sensor_went_quiet` côté carte. `sensor_recovered` et
   * `state_changed` n'ont pas de carte : le premier est le retour à la normale d'un
   * avertissement, le second se lit sur la capability `vtherm_state`. Un événement sans carte
   * est ignoré, jamais une erreur.
   *
   * Ce commentaire a longtemps affirmé que `preset_changed` était « déjà couvert par les
   * déclencheurs `_changed` automatiques des capabilities ». C'était faux : Homey ne fabrique
   * ces cartes que pour les capabilities dont l'identifiant porte un préfixe SYSTÈME
   * (`measure_`, `meter_`, `alarm_`…). `vtherm_preset` n'en porte aucun — aucune carte
   * n'existait, et le changement de preset n'était donc déclenchable par personne.
   */
  private async triggerFlowCard(event: ParticipantEvent): Promise<void> {
    switch (event.kind) {
      case 'preset_changed':
        await this.trigger('preset_changed', { preset: event.preset });
        return;
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

  /**
   * Même source que le déclencheur `window_opened`, pas la capability : `alarm_contact` n'existe
   * que si un contact a été désigné au pairing, alors que le mode « Temperature drop » détecte
   * l'ouverture sans aucun capteur. Lire la capability faisait répondre « fermée » dans ce mode.
   */
  isWindowOpen(): boolean {
    return this.participant?.windowOpen === true;
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
  /**
   * Recopie la liste des appareils liés dans les réglages, en un seul champ.
   *
   * Les réglages de Homey ne savent pas ouvrir une page personnalisée ni afficher un sélecteur
   * d'appareil : leurs listes déroulantes sont figées dans le manifeste et il n'existe aucune
   * action de maintenance. Le plus proche est un groupe unique, que Homey présente comme une
   * entrée dépliable — d'où un seul champ qui porte les six sources, plutôt que six champs.
   *
   * Écrit à l'initialisation et après chaque re-liaison, jamais en boucle : c'est de la mémoire
   * flash.
   */
  private async refreshLinkedLabels(): Promise<void> {
    const labels: Record<SourceKey, string> = {
      room: this.homey.__('settings.linked.room'),
      emitter: this.homey.__('settings.linked.emitter'),
      outdoor: this.homey.__('settings.linked.outdoor'),
      window: this.homey.__('settings.linked.window'),
      motion: this.homey.__('settings.linked.motion'),
      presence: this.homey.__('settings.linked.presence'),
    };

    const lines = await Promise.all(
      (Object.keys(SOURCE_STORE_KEYS) as SourceKey[]).map(async (key) => {
        // L'émetteur est le seul à pouvoir être multiple : ses têtes tiennent sur une ligne,
        // séparées par des virgules. Une ligne par tête ferait grossir un champ qui porte déjà les
        // six sources, et Homey n'en affiche qu'un.
        const deviceIds = key === 'emitter' ? this.emitterIds() : [this.sourceId(key)];
        const present = deviceIds.filter((id): id is string => id !== null);
        if (present.length === 0) {
          return `${labels[key]} : ${this.homey.__('settings.linked.none')}`;
        }

        const names = await Promise.all(present.map(async (deviceId) => {
          let name: string | null = null;
          try {
            name = (await this.app.hub.getDeviceSummary(deviceId))?.name ?? null;
          } catch {
            name = null;
          }
          // Un identifiant orphelin est le cas le plus fréquent : un appareil Zigbee ré-appairé
          // change d'identifiant, et sans ce message rien n'expliquerait le silence du thermostat.
          return name ?? this.homey.__('settings.linked.missing');
        }));

        return `${labels[key]} : ${names.join(', ')}`;
      }),
    );

    try {
      await this.setSettings({ linked_devices: joinLinkedLabels(lines) });
    } catch (err) {
      this.error('Mise à jour des appareils liés :', err);
    }
  }

  /**
   * Remplit les explications de chaque groupe de réglages.
   *
   * Elles ne peuvent pas venir du manifeste : Homey affiche la VALEUR d'un réglage `label`, et une
   * valeur par défaut de `driver.settings.compose.json` n'est pas traduisible. Sans cette écriture,
   * chaque groupe montre un cadre gris vide — ce que l'utilisateur voyait avant ce correctif.
   */
  private async refreshExplanations(): Promise<void> {
    const desired = explainSettings(VTHERM_EXPLAIN_IDS, (key) => this.homey.__(key));
    const pending = changedSettings(desired, (key) => this.getSetting(key));
    if (Object.keys(pending).length === 0) return;

    try {
      await this.setSettings(pending);
    } catch (err) {
      this.error('Mise à jour des explications de réglages :', err);
    }
  }

  /** Les identifiants actuellement liés, pour que la page d'édition montre d'où l'on part. */
  currentSources(): Record<SourceKey, string | null> {
    const out = {} as Record<SourceKey, string | null>;
    for (const key of Object.keys(SOURCE_STORE_KEYS) as SourceKey[]) {
      out[key] = this.sourceId(key);
    }
    return out;
  }

  async rebindSource(key: SourceKey, deviceId: string | null): Promise<void> {
    if (deviceId === null && REQUIRED_SOURCES.includes(key)) {
      throw new Error(this.homey.__('pair.error.incomplete'));
    }

    if (key === 'emitter') {
      // Re-désigner « l'émetteur » remplace la tête n°1 SANS toucher aux suivantes : c'est la voie
      // de réparation d'une vanne ré-appairée, pas une remise à zéro du groupe. Écrire `emitterId`
      // seul laisserait `emitterIds` pointer sur l'ancien identifiant, qui l'emporte à la lecture —
      // la réparation n'aurait alors servi à rien, en silence.
      const ids = this.emitterIds();
      ids[0] = deviceId!;
      await this.setEmitterIds(ids);
      return;
    }

    await this.setStoreValue(SOURCE_STORE_KEYS[key], deviceId);
    void this.refreshLinkedLabels();

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
    if (this.onHubConnected !== null) {
      this.app.hub.off('connected', this.onHubConnected);
      this.onHubConnected = null;
    }
    this.provisionalSources.clear();

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

    // La capability à lire dépend de l'appareil : un détecteur mmWave publie `alarm_presence`
    // là où un PIR publie `alarm_motion`, et une vanne range sa température dans
    // `measure_temperature.local`. On résout, on ne suppose pas.
    void this.resolveAndBind(key, slot, deviceId);
  }

  private async resolveAndBind(
    key: Exclude<SourceKey, 'emitter'>,
    slot: keyof VThermSourceBindings,
    deviceId: string,
  ): Promise<void> {
    let capabilityId: string | null = null;
    try {
      const summary = await this.app.hub.getDeviceSummary(deviceId);
      if (summary !== null) {
        for (const accepted of SOURCE_CAPABILITIES[key]) {
          capabilityId = resolveCapabilityId(summary.capabilities, accepted);
          if (capabilityId !== null) break;
        }
      }
    } catch {
      // Appareil injoignable pour l'instant : on retombe sur la capability préférée, et le
      // ré-abonnement du hub reprendra la main quand il répondra.
    }

    // Repli : la première capability acceptée. Mieux vaut une liaison qui attend l'appareil
    // qu'une source silencieusement absente.
    const resolved = capabilityId ?? SOURCE_CAPABILITIES[key][0];
    if (resolved === undefined) return;

    if (capabilityId === null) {
      // Le repli est PROVISOIRE tant que le hub n'a pas parlé. `getDeviceSummary` rend `null` aussi
      // bien quand le hub n'est pas monté que quand l'appareil n'a réellement aucune capability
      // attendue : sans cette distinction, une sonde en `measure_temperature.local` restait liée à
      // vie sur `measure_temperature`, qu'elle n'a pas. On refait la résolution à l'arrivée du hub.
      if (this.app.hub.connected) {
        this.provisionalSources.delete(key);
      } else {
        this.provisionalSources.add(key);
      }
      this.app.trace(
        `[vtherm] ${this.deviceId()} : source « ${key} » — aucune capability attendue sur `
        + `l'appareil ${deviceId}, liaison tentée sur ${resolved}`
        + (this.app.hub.connected ? '' : ' (hub absent, résolution à refaire)'),
      );
    } else {
      this.provisionalSources.delete(key);
    }

    // La liaison précédente est détruite ICI et pas seulement dans `attachSource` : la
    // re-résolution à l'arrivée du hub passe directement par cette méthode, et remplacer la
    // référence sans détruire laisserait un abonnement websocket orphelin à vie. `destroy()` est
    // idempotent, donc le double appel du chemin normal ne coûte rien.
    this.sources[slot]?.destroy();
    this.sources[slot] = this.app.hub.bind(
      deviceId,
      resolved,
      () => this.app.requestTick(`${this.deviceId()}:${key}`),
    );
    this.app.requestTick(`${this.deviceId()}:${key}:bound`);
  }

  private sourceId(key: SourceKey): string | null {
    const value: unknown = this.getStoreValue(SOURCE_STORE_KEYS[key]);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * Les têtes de ce thermostat, dans l'ordre d'appairage. Une seule sur un thermostat d'avant les
   * groupes — c'est `readEmitterIds` qui absorbe la différence, et rien d'autre ici ne la voit.
   */
  emitterIds(): string[] {
    return readEmitterIds({
      [SOURCE_STORE_KEYS.emitter]: this.getStoreValue(SOURCE_STORE_KEYS.emitter) as unknown,
      [EMITTER_LIST_STORE_KEY]: this.getStoreValue(EMITTER_LIST_STORE_KEY) as unknown,
    });
  }

  /**
   * Réécrit le groupe, puis recharge l'appareil.
   *
   * Les adaptateurs tiennent leurs propres liaisons et ne sont pas remplaçables à chaud : c'est la
   * même raison qui fait recharger sur une re-liaison d'émetteur seul. Le rechargement passe par
   * `teardown`, qui remet AVANT tout les anciennes têtes en état sûr — sans quoi une tête retirée
   * du groupe resterait figée sur sa dernière ouverture, chauffée par personne.
   */
  async setEmitterIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) throw new Error(this.homey.__('pair.error.incomplete'));
    if (ids.length > MAX_EMITTERS) throw new Error(this.homey.__('pair.error.too_many_emitters'));

    for (const [key, value] of Object.entries(emitterStorePatch(ids))) {
      await this.setStoreValue(key, value);
    }
    await this.grantEmitterCapabilities(ids);
    void this.refreshLinkedLabels();
    await this.reload();
  }

  /**
   * Ajoute les tuiles que le nouveau groupe rend utiles. N'en RETIRE jamais aucune.
   *
   * L'asymétrie est le fond du sujet. `removeCapability` détruit l'historique Insights de la
   * capability retirée : une tête débranchée coûterait la courbe d'ouverture de tout l'hiver, pour
   * gagner une tuile en moins. `addCapability` sur une capability ABSENTE ne détruit rien — il n'y a
   * pas d'historique à perdre —, et c'est la seule façon qu'a un thermostat créé sur un relais de
   * secteur d'afficher la pile de la vanne qu'on vient de lui ajouter. Sans ça, la tuile serait
   * perdue pour toujours et la seule issue serait de refaire le thermostat.
   *
   * Une tuile devenue vide après un retrait de tête est le prix, et il est bien plus petit.
   */
  private async grantEmitterCapabilities(ids: readonly string[]): Promise<void> {
    const probes = await Promise.all(ids.map(async (id) => {
      try {
        return await this.app.hub.getDeviceSummary(id);
      } catch {
        return null;
      }
    }));

    for (const capabilityId of emitterExtraCapabilities(probes)) {
      if (this.hasCapability(capabilityId)) continue;
      try {
        await this.addCapability(capabilityId);
      } catch (err) {
        this.error(`Ajout de la capability ${capabilityId} :`, err);
      }
    }
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
      minActivationSec: num(s, 'min_activation_sec', DEFAULT_MIN_ACTIVATION_SEC),
      minDeactivationSec: num(s, 'min_deactivation_sec', DEFAULT_MIN_DEACTIVATION_SEC),
      safety: {
        enabled: bool(s, 'safety_enabled', DEFAULT_SAFETY.enabled),
        // Saisis en %, attendus en fraction sur l'échelle de `on_percent`.
        minOnPercent: num(s, 'safety_min_on_percent', DEFAULT_SAFETY.minOnPercent * 100) / 100,
        defaultOnPercent: num(s, 'safety_default_on_percent', DEFAULT_SAFETY.defaultOnPercent * 100) / 100,
        // Consigne de repli du mode consigne. Défaut : la température du preset confort de CET
        // appareil, et non la constante — c'est celle que l'utilisateur a choisie pour être bien.
        fallbackSetpoint: num(s, 'safety_setpoint', num(s, 'temp_comfort', DEFAULT_PRESET_TEMPS.comfort)),
        // Saisi en heures : une durée de sécurité se pense en « le temps de changer une pile »,
        // pas en millisecondes. Zéro passe tel quel et supprime la borne.
        maxDurationMs: num(s, 'safety_max_duration_h', DEFAULT_SAFETY.maxDurationMs / 3_600_000) * 3_600_000,
      },
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
