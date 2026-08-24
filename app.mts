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

/**
 * Bornes du tampon de diagnostic. Trois cents lignes de 500 caractères font au pire 150 ko — une
 * réponse HTTP que Homey sait servir, contrairement aux mégaoctets qu'une vue de pairing pouvait
 * y pousser en une seule ligne.
 */
const TRACE_MAX_LINES = 300;
const TRACE_MAX_CHARS = 500;

/**
 * Échéance d'un participant, débarrassée d'un `NaN`.
 *
 * `Math.min(x, NaN)` vaut `NaN` : un SEUL participant empoisonné — un argument de carte Flow non
 * validé suffisait — rendait illisible l'échéance du Tickable unique, et l'ordonnanceur ne le
 * jugeait plus jamais dû. Plus aucune régulation périodique dans tout le logement, uniquement sur
 * événement, en silence. On préfère tiquer une fois de trop, comme l'ordonnanceur le fait déjà
 * devant un `dueAtMs()` qui lève. `±Infinity` sont des réponses légitimes et passent telles quelles.
 */
function usableDue(due: number): number {
  return Number.isNaN(due) ? Number.NEGATIVE_INFINITY : due;
}

export default class VThermApp extends Homey.App {

  /**
   * Tampon circulaire de traces.
   *
   * Une app installée par CLI n'a pas de log lisible : quand une vue de pairing s'affiche vide,
   * il n'y a rien à consulter. Ce tampon, servi par `GET /diagnostics`, est le seul moyen de
   * savoir après coup ce que l'app a réellement fait.
   */
  private readonly traces: string[] = [];

  private hubImpl: HomeyApiHub | null = null;
  private schedulerImpl: Scheduler | null = null;

  private readonly vtherms = new Map<string, VThermParticipant>();
  private central: CentralParticipant | null = null;
  private valveBackendImpl: ValveBackend | null = null;
  /** Dernière disponibilité connue de la dorsale : on n'agit que sur les TRANSITIONS. */
  private brokerWasAvailable = false;

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
    tick: (nowMs: number, reasons?: readonly string[]) => this.runCycle(nowMs, reasons),
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
      this.trace('hub: connecté à l\'API Homey');
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
      // Sans le hub, aucune source ne peut être lue NI listée : les vues de pairing seraient vides
      // sans autre explication. C'est la première chose à regarder dans `GET /diagnostics`.
      this.trace(`hub: ÉCHEC de démarrage — ${err instanceof Error ? err.message : String(err)}`);
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
      due = Math.min(due, usableDue(participant.dueAtMs()));
    }
    if (this.central !== null) {
      due = Math.min(due, usableDue(this.central.dueAtMs()));
    }
    return due;
  }

  /**
   * Ne fait tiquer que les thermostats CONCERNÉS quand le tick est demandé.
   *
   * `requestTick` est branché sur le `onChange` de chaque liaison de source : une seule sonde qui
   * remonte une mesure faisait recalculer tout le logement. Avec un thermostat par pièce, la charge
   * croissait comme le carré du nombre de pièces jusqu'à saturer la fenêtre de coalescence.
   *
   * Le resserrement est DÉLIBÉRÉMENT conservateur : il n'a lieu que si TOUTES les raisons désignent
   * un thermostat connu. Une raison globale — `hub-connected`, `register:…` — continue de réveiller
   * tout le monde, ce qui est bien ce qu'elle veut dire. Et les thermostats dus tiquent de toute
   * façon : c'est leur échéance, pas un événement, qui les y amène.
   *
   * L'instantané de l'étape 3 reste cohérent : `participant.demand` porte la demande du dernier pas
   * abouti, et un thermostat ni dû ni concerné n'a reçu aucune entrée nouvelle — sa demande est donc
   * inchangée, pas périmée.
   */
  private targetsFor(nowMs: number, reasons: readonly string[]): VThermParticipant[] {
    const all = [...this.vtherms.values()];
    if (reasons.length === 0) return all;

    const named = new Set<VThermParticipant>();
    for (const reason of reasons) {
      const separator = reason.indexOf(':');
      // Une raison sans préfixe, ou dont le préfixe ne nomme aucun thermostat connu, est globale :
      // on ne resserre pas. C'est le cas de `hub-connected`, `register:…` et `register-central`.
      if (separator < 0) return all;
      const participant = this.vtherms.get(reason.slice(0, separator));
      if (participant === undefined) return all;
      named.add(participant);
    }

    for (const participant of all) {
      if (participant.dueAtMs() <= nowMs) named.add(participant);
    }
    return all.filter((participant) => named.has(participant));
  }

  private async runCycle(nowMs: number, reasons: readonly string[] = []): Promise<void> {
    const hub = this.hubImpl;
    if (hub === null) return;

    // 0. La dorsale a-t-elle changé d'état ? AVANT les pas, pour qu'ils voient une vanne rendue et
    //    non une vanne figée à 12 % sur laquelle la consigne de repli n'aura aucun effet.
    await this.syncValveBackendAvailability(nowMs);

    // 1. Au plus un appel réseau, pour tout le monde. Le hub y ajoute son propre plancher.
    await hub.refresh(nowMs);

    // 2. Isolation par appareil : un émetteur muet ne doit pas emporter la régulation des autres.
    const vtherms = this.targetsFor(nowMs, reasons);
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

    // TOUS les thermostats, pas seulement ceux qui viennent de tiquer. `demand` porte la demande du
    // dernier pas abouti : n'agréger que les tiqués retirerait de la chaudière une pièce qui a
    // encore froid mais dont rien n'a bougé, et la chaudière s'éteindrait sous elle.
    const demands: Demand[] = [...this.vtherms.values()]
      .filter((participant) => participant.controlsBoiler)
      .map((participant) => participant.demand);

    // 4. UNE seule commande chaudière.
    try {
      await central.applyBoiler(demands, nowMs);
    } catch (err) {
      this.error('Agrégation de la demande de chaleur :', err);
    }
  }

  /**
   * Propage les TRANSITIONS de disponibilité de la dorsale Zigbee2MQTT.
   *
   * `setValveBackend()` ne part que sur un changement de réglages : une chute de connexion en
   * cours de journée n'y passe jamais, seul `backend.available` bascule. Les émetteurs
   * retombaient bien en régulation par consigne, mais leurs vannes restaient figées sur la
   * dernière ouverture commandée — une vanne ramenée à 12 % par le TPI ne s'ouvre plus quelle que
   * soit la consigne écrite ensuite, et la pièce ne remonte jamais.
   */
  private async syncValveBackendAvailability(nowMs: number): Promise<void> {
    const available = this.isBrokerAvailable();
    if (available === this.brokerWasAvailable) return;
    this.brokerWasAvailable = available;

    this.trace(available
      ? 'dorsale Zigbee2MQTT disponible : les vannes sont reprises en main'
      : 'dorsale Zigbee2MQTT perdue : les vannes sont rendues, régulation par consigne');

    // `allSettled` : une vanne qu'on n'arrive pas à rendre ne doit pas empêcher les autres de
    // l'être. Le participant en tire lui-même l'avertissement affiché sur son appareil.
    await Promise.allSettled(
      [...this.vtherms.values()].map((p) => p.onValveBackendAvailability(available, nowMs)),
    );
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

  /**
   * Ajoute une ligne au tampon de diagnostic, et au log au cas où quelqu'un puisse le lire.
   *
   * La ligne est bornée en LONGUEUR autant qu'en nombre : une vue de pairing pousse ici ce qu'elle
   * veut, et `GET /diagnostics` resert le tampon entier. Plafonner seulement le nombre de lignes
   * laissait passer des mégaoctets sur trois cents lignes. Les retours à la ligne sont neutralisés
   * pour la même raison : sans ça, un message forgé fabrique de fausses entrées de journal.
   */
  trace(message: string): void {
    const flattened = message.replace(/[\r\n]+/g, ' ⏎ ');
    const bounded = flattened.length > TRACE_MAX_CHARS
      ? `${flattened.slice(0, TRACE_MAX_CHARS)}…`
      : flattened;

    this.traces.push(`${new Date().toISOString()} ${bounded}`);
    if (this.traces.length > TRACE_MAX_LINES) this.traces.splice(0, this.traces.length - TRACE_MAX_LINES);
    this.log(bounded);
  }

  /** Servi par `GET /diagnostics`. Ne contient rien de secret : ni mot de passe, ni jeton. */
  getDiagnostics(): {
    hubConnected: boolean;
    brokerAvailable: boolean;
    vtherms: string[];
    hasCentral: boolean;
    traces: string[];
  } {
    return {
      hubConnected: this.hubImpl?.connected === true,
      brokerAvailable: this.isBrokerAvailable(),
      vtherms: [...this.vtherms.keys()],
      hasCentral: this.central !== null,
      traces: [...this.traces],
    };
  }

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
    // ATTENDU, pas seulement demandé : `stop()` rend la promesse du tick en vol. Sans cette
    // attente, les écritures restantes de ce tick atterrissent APRÈS la remise en état sûr, et un
    // convecteur qu'on vient d'éteindre est rallumé par un pas déjà lancé.
    await this.schedulerImpl?.stop();

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
