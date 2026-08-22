/**
 * `drivers/central/device.mts` — la vue de la configuration centrale et du relais de chaudière.
 *
 * Un seul appareil central peut exister. L'unicité est imposée au pairing ET ici : une restauration
 * de sauvegarde peut produire deux appareils, et deux appareils qui se disputent le même relais de
 * chaudière sont exactement la panne que le garde-fou anti-pulsation existe pour empêcher.
 */

import Homey from 'homey';

import { BOILER_MIN_DWELL_FLOOR_SEC, DEFAULT_BOILER } from '../../lib/constants.mjs';
import {
  CENTRAL_EXPLAIN_IDS, changedSettings, explainSettings,
} from '../../lib/settingsExplain.mjs';
import type { BoilerParams, CentralMode } from '../../lib/types.mjs';
import type { CapValue } from '../../runtime/hub.mjs';
import { CentralParticipant, type DeviceHost, type ParticipantEvent } from '../../runtime/participants.mjs';
import type VThermApp from '../../app.mjs';

/** Clé de `store` portant le relais de chaudière désigné au pairing. */
export const BOILER_STORE_KEY = 'boilerId';

const CENTRAL_MODES: readonly CentralMode[] = ['auto', 'stopped', 'heat_only', 'frost'];

export default class CentralDevice extends Homey.Device {

  private participant: CentralParticipant | null = null;
  private registered = false;
  private listenersRegistered = false;

  override async onInit(): Promise<void> {
    const app = this.app;

    // Le mode survit au redémarrage par la capability, qui est inscriptible et donc déjà persistée
    // par Homey. Un second stockage en ferait une seconde vérité.
    const mode = this.currentMode();
    await this.setCapabilityValue('vtherm_central_mode', mode);
    void this.refreshLinkedLabels();
    void this.refreshExplanations();

    const participant = new CentralParticipant({
      host: this.deviceHost(),
      // La liaison n'est posée qu'après un enregistrement accepté : un appareil en double ne doit
      // jamais pouvoir écrire sur le relais, pas même à sa suppression.
      boiler: null,
      params: this.readParams(),
      mode,
      requestTick: (reason) => app.requestTick(`central:${reason}`),
      nowMs: Date.now(),
    });
    this.participant = participant;

    this.registered = app.registerCentral(participant);
    if (!this.registered) {
      await this.setUnavailable(this.homey.__('device.central_duplicate'));
      return;
    }

    const boilerId = this.boilerId();
    if (boilerId !== null) {
      participant.setBoilerBinding(this.bindBoiler(app, boilerId));
    }

    this.registerListeners();
    await this.setAvailable();
  }

  // --- Contrat avec le participant -------------------------------------------

  /**
   * Recopie le nom du relais de chaudière dans les réglages, en lecture seule.
   *
   * Même raison que pour le thermostat : les réglages ne savent pas afficher un sélecteur
   * d'appareil, alors ils montrent ce qui est lié et disent où le changer.
   */
  private async refreshLinkedLabels(): Promise<void> {
    const deviceId: unknown = this.getStoreValue(BOILER_STORE_KEY);
    let value = this.homey.__('settings.linked.none');
    if (typeof deviceId === 'string' && deviceId.length > 0) {
      let name: string | null = null;
      try {
        name = (await this.app.hub.getDeviceSummary(deviceId))?.name ?? null;
      } catch {
        name = null;
      }
      value = name ?? this.homey.__('settings.linked.missing');
    }
    try {
      await this.setSettings({ linked_devices: `${this.homey.__('settings.linked.boiler')} : ${value}` });
    } catch (err) {
      this.error('Mise à jour de l\'appareil lié :', err);
    }
  }

  /**
   * Remplit l'explication du groupe de réglages.
   *
   * Homey affiche la VALEUR d'un réglage `label`, jamais son `hint` — qui ne sort qu'en infobulle.
   * Sans cette écriture, le groupe montre un cadre gris vide.
   */
  private async refreshExplanations(): Promise<void> {
    const desired = explainSettings(CENTRAL_EXPLAIN_IDS, (key) => this.homey.__(key));
    const pending = changedSettings(desired, (key) => this.getSetting(key));
    if (Object.keys(pending).length === 0) return;

    try {
      await this.setSettings(pending);
    } catch (err) {
      this.error('Mise à jour de l\'explication de réglages :', err);
    }
  }

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

  /** Les deux seules cartes déclenchées par le noyau côté central. Le reste est ignoré. */
  private async triggerFlowCard(event: ParticipantEvent): Promise<void> {
    switch (event.kind) {
      case 'boiler_started':
        await this.homey.flow.getDeviceTriggerCard('boiler_started')
          .trigger(this, { emitters: event.nbActive }, {});
        return;
      case 'boiler_stopped':
        await this.homey.flow.getDeviceTriggerCard('boiler_stopped').trigger(this, {}, {});
        return;
      default:
        return;
    }
  }

  // --- Interface utilisateur --------------------------------------------------

  private registerListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    this.registerCapabilityListener('vtherm_central_mode', async (value: unknown) => {
      const mode = toCentralMode(value);
      if (mode === null) return;
      await this.applyCentralMode(mode);
    });
  }

  /** Point d'entrée de la carte Flow `set_central_mode` comme du sélecteur de l'interface. */
  async applyCentralMode(mode: CentralMode): Promise<void> {
    await this.setCapabilityValue('vtherm_central_mode', mode);
    this.participant?.setMode(mode);
  }

  /**
   * Lie le relais, ET demande un recalcul quand il change d'état de lui-même.
   *
   * Sans ce rappel, l'événement qui RÉVÈLE une divergence ne réveille personne : une fois la
   * chaudière commandée, le participant central n'a plus d'échéance propre, et l'écart n'était
   * constaté qu'au prochain pas d'un autre appareil — jusqu'à `cycle_min`, cinq minutes par
   * défaut, pendant lesquelles un relais resté allumé continue de chauffer. Les sources d'un
   * thermostat sont liées ainsi depuis toujours ; le relais avait été oublié.
   */
  private bindBoiler(app: VThermApp, deviceId: string) {
    return app.hub.bind(deviceId, 'onoff', () => app.requestTick('central:boiler-relay'));
  }

  isBoilerActive(): boolean {
    return this.getCapabilityValue('vtherm_boiler_active') === true;
  }

  currentMode(): CentralMode {
    return toCentralMode(this.getCapabilityValue('vtherm_central_mode')) ?? 'auto';
  }

  override async onSettings(event: {
    oldSettings: Record<string, boolean | string | number | undefined | null>;
    newSettings: Record<string, boolean | string | number | undefined | null>;
    changedKeys: string[];
  }): Promise<string | void> {
    this.participant?.updateParams(this.readParams(event.newSettings));
  }

  // --- Réparation -------------------------------------------------------------

  /** Re-désigne le relais de chaudière quand il a changé d'identifiant (risque n°12 du PLAN). */
  async rebindBoiler(deviceId: string | null): Promise<void> {
    await this.setStoreValue(BOILER_STORE_KEY, deviceId);

    const participant = this.participant;
    if (participant === null || !this.registered) return;

    participant.setBoilerBinding(deviceId === null ? null : this.bindBoiler(this.app, deviceId));
    this.app.requestTick('central:repair');
  }

  // --- Cycle de vie -----------------------------------------------------------

  override async onUninit(): Promise<void> {
    await this.teardown();
  }

  override async onDeleted(): Promise<void> {
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const participant = this.participant;
    this.participant = null;
    if (participant === null) return;

    // Un appareil en double n'a jamais commandé le relais : l'éteindre en partant couperait la
    // chaudière que l'appareil légitime vient peut-être d'allumer.
    if (!this.registered) return;

    this.app.unregisterCentral(participant);
    this.registered = false;

    try {
      await participant.restoreSafeState();
    } catch (err) {
      this.error('Extinction de la chaudière :', err);
    }

    participant.destroy();
  }

  // --- Réglages ---------------------------------------------------------------

  private readParams(raw?: Record<string, unknown>): BoilerParams {
    const s = raw ?? this.getSettings() as Record<string, unknown>;

    return {
      /*
       * Plancher à 1, réaffirmé ici. L'interface impose déjà `min: 1`, mais une valeur venue
       * d'ailleurs — import, restauration de sauvegarde — passerait sans être bornée. À zéro ou
       * moins, `nbActive >= threshold` est vrai en permanence : la chaudière est réputée demandée
       * même quand personne ne demande, et la coupure d'un relais resté allumé — la protection du
       * circuit fermé — ne peut plus jamais se déclencher.
       */
      threshold: Math.max(1, num(s, 'boiler_threshold', DEFAULT_BOILER.threshold)),
      activationDelaySec: num(s, 'boiler_activation_delay', DEFAULT_BOILER.activationDelaySec),
      // Plancher réaffirmé ici : le réglage ne descend pas sous 60 s dans l'interface, mais une
      // valeur venue d'ailleurs (import, restauration) ne doit pas pouvoir désarmer le garde-fou.
      minDwellSec: Math.max(
        BOILER_MIN_DWELL_FLOOR_SEC,
        num(s, 'boiler_min_dwell', DEFAULT_BOILER.minDwellSec),
      ),
      keepAliveSec: num(s, 'boiler_keepalive', DEFAULT_BOILER.keepAliveSec),
    };
  }

  // --- Outils -----------------------------------------------------------------

  private get app(): VThermApp {
    return this.homey.app as VThermApp;
  }

  private deviceId(): string {
    const data = this.getData() as { id?: unknown };
    return typeof data.id === 'string' ? data.id : this.getName();
  }

  private boilerId(): string | null {
    const value: unknown = this.getStoreValue(BOILER_STORE_KEY);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

function isCapValue(value: unknown): value is CapValue {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

export function toCentralMode(value: unknown): CentralMode | null {
  return typeof value === 'string' && (CENTRAL_MODES as readonly string[]).includes(value)
    ? value as CentralMode
    : null;
}

function num(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
