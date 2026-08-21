/**
 * `app.mts` — hub, ordonnanceur, registre.
 *
 * L'app ne régule rien elle-même : elle tient le seul accès aux appareils tiers, le seul timer, et
 * la liste des participants. Son unique décision est l'ORDRE dans lequel un tick se déroule, et
 * cet ordre est la garantie centrale du projet :
 *
 *   1. `hub.refresh(now)`                    au plus UN aller-retour réseau
 *   2. `Promise.allSettled(vtherms.tick)`    isolation par appareil, timeout par pas
 *   3. `collectDemands(...)`                 toutes les demandes lues APRÈS tous les pas
 *   4. `central.applyBoiler(demands, now)`   UNE seule commande chaudière
 *
 * L'étape 3 ne peut pas être remplacée par une notification par appareil. Avec cinq VTherm qui
 * annoncent leur demande chacun de son côté, le comptage porterait sur cinq instants différents et
 * le garde-fou anti-pulsation de 60 s servirait en fonctionnement NOMINAL — un filet de sécurité
 * utilisé comme mécanisme de conception.
 *
 * Les appareils s'enregistrent auprès de l'app, jamais l'inverse : l'ordre d'initialisation des
 * drivers n'est pas garanti.
 */

import sourceMapSupport from 'source-map-support';
import Homey from 'homey';

import type { CentralMode, Demand } from './lib/types.mjs';
import { HomeyApiHub } from './runtime/hub.mjs';
import { Scheduler, type Tickable } from './runtime/scheduler.mjs';
import type { CentralParticipant, VThermParticipant } from './runtime/participants.mjs';
import type { ValveBackend } from './runtime/valveBackend.mjs';
import { MqttValveBackend } from './runtime/mqttBackend.mjs';
import { extractDeviceHint, validateBrokerConfig, type BrokerConfig } from './lib/mqttPayload.mjs';
import { BROKER_SETTINGS } from './api.mjs';

sourceMapSupport.install();

/**
 * Au-delà, le pas d'un appareil est abandonné pour ce tick. Il ne l'annule pas — rien ne peut
 * annuler une écriture Zigbee déjà partie — il rend la main à l'ordonnanceur pour que l'émetteur
 * d'une pièce ne fige pas la régulation de tout le logement. La demande du participant reste alors
 * `unknown`, donc la chaudière ne s'allume pas sur son compte.
 */
const TICK_TIMEOUT_MS = 20_000;

/** Les clés dont un changement doit reconstruire la dorsale. */
const BROKER_KEYS = new Set<string>(Object.values(BROKER_SETTINGS));

export default class VThermApp extends Homey.App {

  private hubImpl: HomeyApiHub | null = null;
  private schedulerImpl: Scheduler | null = null;

  private readonly vtherms = new Map<string, VThermParticipant>();
  private central: CentralParticipant | null = null;
  private valveBackendImpl: ValveBackend | null = null;

  /**
   * L'unique participant enregistré auprès de l'ordonnanceur : le cycle complet.
   *
   * Ce n'est pas un détour. Enregistrer les VTherm un par un rendrait l'ordre des quatre étapes
   * dépendant de l'ordre d'itération d'une `Map`, et le comptage des demandes ne porterait plus
   * sur le même instant pour tout le monde.
   */
  private readonly cycle: Tickable = {
    tickId: 'app-cycle',
    dueAtMs: () => this.cycleDueAtMs(),
    tick: (nowMs: number) => this.runCycle(nowMs),
  };

  get hub(): HomeyApiHub {
    const hub = this.hubImpl;
    if (hub === null) throw new Error('Le hub n\'existe qu\'après onInit.');
    return hub;
  }

  get scheduler(): Scheduler {
    const scheduler = this.schedulerImpl;
    if (scheduler === null) throw new Error('L\'ordonnanceur n\'existe qu\'après onInit.');
    return scheduler;
  }

  override async onInit(): Promise<void> {
    const hub = new HomeyApiHub(this.homey, {
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });
    this.hubImpl = hub;

    const scheduler = new Scheduler(this.homey, {
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });
    this.schedulerImpl = scheduler;
    scheduler.register(this.cycle);

    hub.on('connected', () => {
      // Un ré-abonnement vient d'avoir lieu : un device Zigbee2MQTT ré-annoncé peut revenir avec
      // un jeu de capabilities différent, donc la détection du mode d'émetteur se rejoue.
      for (const participant of this.vtherms.values()) {
        participant.invalidateEmitterDetection();
      }
      scheduler.requestTick('hub-connected');
    });

    // Le hub monte en tâche de fond : les drivers s'initialisent après cet `onInit` et doivent
    // pouvoir s'enregistrer même si l'API Homey n'a pas encore répondu.
    hub.start().catch((err: unknown) => {
      this.error('Connexion à l\'API Homey impossible :', err);
    });

    // La dorsale Zigbee2MQTT est facultative : sans elle, l'app régule par consigne sur n'importe
    // quel appareil Homey. On la (re)construit à chaque changement de réglages plutôt qu'au seul
    // démarrage, sinon corriger une adresse de broker imposerait de redémarrer l'app.
    this.applyBrokerSettings();
    this.homey.settings.on('set', (key: string) => {
      if (!BROKER_KEYS.has(key)) return;
      this.applyBrokerSettings();
    });

    scheduler.start();
    this.log('Adaptive Thermostat initialisé.');
  }

  // --- Registre --------------------------------------------------------------

  registerVTherm(participant: VThermParticipant): void {
    this.vtherms.set(participant.tickId, participant);
    participant.setValveBackend(this.valveBackendImpl);
    this.schedulerImpl?.requestTick(`register:${participant.tickId}`);
  }

  unregisterVTherm(id: string): void {
    if (!this.vtherms.delete(id)) return;
    this.schedulerImpl?.requestTick(`unregister:${id}`);
  }

  /**
   * `false` au SECOND appareil central : il doit se mettre `setUnavailable()`.
   *
   * L'unicité est imposée deux fois, au pairing et à l'exécution. Une restauration de sauvegarde
   * peut produire deux appareils centraux, et deux appareils qui se disputent le même relais de
   * chaudière, c'est précisément la panne que le garde-fou anti-pulsation existe pour empêcher.
   */
  registerCentral(participant: CentralParticipant): boolean {
    if (this.central !== null && this.central !== participant) {
      this.error('Un second appareil de configuration centrale existe : il restera indisponible.');
      return false;
    }

    this.central = participant;
    this.schedulerImpl?.requestTick('register-central');
    return true;
  }

  unregisterCentral(participant: CentralParticipant): void {
    if (this.central !== participant) return;
    this.central = null;
    this.schedulerImpl?.requestTick('unregister-central');
  }

  /** `auto` en l'absence d'appareil central : c'est le défaut, pas un cas particulier. */
  centralMode(): CentralMode {
    return this.central?.mode ?? 'auto';
  }

  /** Recalcul hors cycle, coalescé par l'ordonnanceur. Point d'entrée des devices et des Flows. */
  requestTick(reason: string): void {
    this.schedulerImpl?.requestTick(reason);
  }

  // --- Dorsale MQTT ----------------------------------------------------------

  get valveBackend(): ValveBackend | null {
    return this.valveBackendImpl;
  }

  /**
   * Branche (ou débranche) la dorsale Zigbee2MQTT. Elle se connecte après le démarrage de l'app,
   * et peut disparaître en cours de route : les émetteurs basculent alors en régulation par
   * consigne décalée sans que rien d'autre ne change.
   */
  setValveBackend(backend: ValveBackend | null): void {
    this.valveBackendImpl = backend;
    for (const participant of this.vtherms.values()) {
      participant.setValveBackend(backend);
    }
  }

  // --- Le tick ---------------------------------------------------------------

  private cycleDueAtMs(): number {
    let due = Number.POSITIVE_INFINITY;

    for (const participant of this.vtherms.values()) {
      due = Math.min(due, participant.dueAtMs());
    }
    if (this.central !== null) {
      due = Math.min(due, this.central.dueAtMs());
    }
    return due;
  }

  private async runCycle(nowMs: number): Promise<void> {
    const hub = this.hubImpl;
    if (hub === null) return;

    // 1. Au plus un appel réseau, pour tout le monde. Le hub y ajoute son propre plancher.
    await hub.refresh(nowMs);

    // 2. Isolation par appareil : un émetteur muet ne doit pas emporter la régulation des autres.
    const vtherms = [...this.vtherms.values()];
    const results = await Promise.allSettled(
      vtherms.map((participant) => this.withTimeout(participant.tick(nowMs), participant.tickId)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.error(`Pas de ${vtherms[index]?.tickId ?? '?'} :`, result.reason);
      }
    });

    // 3. Instantané cohérent : les demandes sont lues une fois tous les pas terminés, donc au même
    //    instant pour tout le monde. Un pas qui a échoué a laissé la sienne à `unknown`.
    const central = this.central;
    if (central === null) return; // 4. sautée : aucun appareil central, c'est le défaut.

    const demands: Demand[] = vtherms
      .filter((participant) => participant.controlsBoiler)
      .map((participant) => participant.demand);

    // 4. UNE seule commande chaudière.
    try {
      await central.applyBoiler(demands, nowMs);
    } catch (err) {
      this.error('Agrégation de la demande de chaleur :', err);
    }
  }

  private withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.homey.setTimeout(() => {
        reject(new Error(`${label} : pas non terminé après ${TICK_TIMEOUT_MS} ms.`));
      }, TICK_TIMEOUT_MS);

      promise.then(resolve, reject).finally(() => {
        this.homey.clearTimeout(timer);
      });
    });
  }

  // --- Arrêt -----------------------------------------------------------------

  /** Vrai seulement si la dorsale est réellement connectée ET a vu la liste des appareils Z2M. */
  isBrokerAvailable(): boolean {
    return this.valveBackendImpl?.available === true;
  }

  /**
   * Construit ou démonte la dorsale MQTT d'après les réglages de l'app.
   *
   * Le point délicat est `hintFor` : la dorsale a besoin du `friendly_name` Zigbee2MQTT d'une
   * vanne, qui ne se déduit pas de son identifiant Homey. Il vit dans les réglages que l'app
   * Zigbee2MQTT pose sur l'appareil, et le hub est le seul module autorisé à les lire — d'où
   * cette injection plutôt qu'un accès direct depuis la dorsale.
   */
  private applyBrokerSettings(): void {
    const previous = this.valveBackendImpl;
    const settings = this.homey.settings;

    const enabled = settings.get(BROKER_SETTINGS.enabled) === true;
    const config: BrokerConfig = {
      host: String(settings.get(BROKER_SETTINGS.host) ?? '').trim(),
      port: Number(settings.get(BROKER_SETTINGS.port) ?? 1883),
      username: (settings.get(BROKER_SETTINGS.username) as string | undefined) || undefined,
      password: (settings.get(BROKER_SETTINGS.password) as string | undefined) || undefined,
      baseTopic: String(settings.get(BROKER_SETTINGS.baseTopic) ?? 'zigbee2mqtt').trim(),
    };

    const problem = enabled ? validateBrokerConfig(config) : null;
    if (!enabled || problem !== null) {
      if (problem !== null) {
        this.error(`Dorsale Zigbee2MQTT non démarrée, réglages incomplets : ${problem}.`);
      }
      this.setValveBackend(null);
      void previous?.stop();
      return;
    }

    const backend = new MqttValveBackend({
      config,
      hintFor: async (deviceId: string) =>
        extractDeviceHint(await (this.hubImpl?.getDeviceSettings(deviceId) ?? null)),
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this.setValveBackend(backend);
    void previous?.stop();
    backend.start();
    this.schedulerImpl?.requestTick('broker-settings');
  }

  override async onUninit(): Promise<void> {
    this.schedulerImpl?.stop();

    // SPEC §11.1 : remise en état sûr AVANT de fermer le hub — après, il n'y a plus de quoi
    // écrire, et les vannes resteraient figées sur la dernière consigne d'une app qui ne les
    // pilote plus.
    await Promise.allSettled([
      ...[...this.vtherms.values()].map((participant) => participant.restoreSafeState()),
      ...(this.central === null ? [] : [this.central.restoreSafeState()]),
    ]);

    await this.valveBackendImpl?.stop();
    await this.hubImpl?.stop();

    this.valveBackendImpl = null;
    this.vtherms.clear();
    this.central = null;
    this.hubImpl = null;
    this.schedulerImpl = null;
  }
}
