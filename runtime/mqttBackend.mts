/**
 * `runtime/mqttBackend.mts` — la dorsale Zigbee2MQTT optionnelle (SPEC §1.1).
 *
 * SEUL module du projet qui importe `mqtt`.
 *
 * Pourquoi elle existe : l'app Homey Zigbee2MQTT (`com.gruijter.zigbee2mqtt`) ne mappe AUCUNE des
 * quatre propriétés dont on a besoin pour piloter finement une TRVZB — `valve_opening_degree`,
 * `valve_closing_degree`, `external_temperature_input`, `temperature_sensor_select`. Vérifié dans
 * son code et sur l'appareil réel (SPEC §1.1). Sa carte Flow `custom_payload_set` publie pourtant
 * littéralement un JSON sur `<base_topic>/<friendly_name>/set` ; on fait la même chose, mais en
 * parlant nous-mêmes au broker.
 *
 * Trois règles tenues par ce fichier :
 *
 *  1. **Aucune exception ne remonte.** Broker absent, mauvais identifiants, nom introuvable : les
 *     écritures échouent proprement et `available` le dit. Le thermostat retombe alors sur la
 *     dorsale Homey (consigne décalée), qui chauffe quand même. Une exception ici ferait tomber
 *     un pas de régulation, donc toutes les pièces, pour une dorsale qui est un supplément.
 *  2. **Aucun appariement approximatif.** Voir `lib/mqttPayload.mts` : écrire sur la vanne d'une
 *     autre pièce est la pire panne possible de ce lot.
 *  3. **Aucune déduplication ici.** Elle appartient à l'émetteur, qui seul connaît
 *     `regulation_threshold` et le rappel périodique de la SPEC §5.5 (règle 3). Une seconde couche
 *     de déduplication, non configurable, avalerait précisément ce rappel — et
 *     `external_temperature_input` retomberait sur sa dernière valeur connue au bout d'une heure.
 */

import mqtt from 'mqtt';
import type { ErrorWithReasonCode, IClientOptions, MqttClient } from 'mqtt';

import {
  buildBridgeDevicesTopic,
  buildBrokerUrl,
  buildCalibrationPayload,
  buildExternalTemperaturePayload,
  buildSensorSelectPayload,
  buildSetTopic,
  buildValvePayload,
  parseBridgeDevices,
  resolveFriendlyName,
  validateBrokerConfig,
} from '../lib/mqttPayload.mjs';
import type {
  BridgeDevice, BrokerConfig, TemperatureSensorSource, Z2mDeviceHint, Z2mPayload,
} from '../lib/mqttPayload.mjs';

import type { ValveBackend } from './valveBackend.mjs';

export type { BrokerConfig } from '../lib/mqttPayload.mjs';

type Logger = (...args: unknown[]) => void;

/**
 * Fournit les indices d'appariement d'un device Homey — en pratique ses `settings`, où l'app Z2M
 * range `friendly_name` et `ieee_address`. Injecté plutôt que lu ici : `runtime/hub.mts` est le
 * seul module autorisé à parler à `homey-api`.
 */
export type DeviceHintProvider = (deviceId: string) => Promise<Z2mDeviceHint> | Z2mDeviceHint;

export interface MqttBackendOptions {
  config: BrokerConfig;
  hintFor: DeviceHintProvider;
  log?: Logger;
  error?: Logger;
}

// --- Réglages de comportement ---------------------------------------------

/** Back-off de reconnexion. Un broker éteint pour la nuit ne doit pas nous faire boucler à 1 Hz. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 2 * 60_000;

/** Délai d'établissement TCP+CONNACK. Au-delà, `mqtt` relance le cycle de reconnexion. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Plafond par défaut du test de connexion depuis la page de réglages. */
export const BROKER_TEST_TIMEOUT_MS = 10_000;

/** QoS 1 : une commande de vanne perdue laisse la pièce dans un état qu'on croit avoir corrigé. */
const PUBLISH_QOS = 1;

// --- Diagnostic de connexion (page de réglages) ----------------------------

export type BrokerTestOutcome =
  /** Connecté, `bridge/devices` reçu : le `base_topic` est bon et voici ce qu'on y voit. */
  | { status: 'ok'; deviceCount: number }
  /** Connecté, mais rien sur `<base_topic>/bridge/devices` : le `base_topic` est faux. */
  | { status: 'no_devices' }
  /** Le broker a explicitement refusé les identifiants. */
  | { status: 'auth_failed'; detail: string }
  /** Connexion refusée, hôte inconnu, port fermé. */
  | { status: 'refused'; detail: string }
  /** Rien n'a abouti dans le délai imparti. */
  | { status: 'timeout' }
  /** La saisie est invalide : inutile d'aller sur le réseau. */
  | { status: 'invalid_config'; detail: string };

/**
 * Codes CONNACK signifiant « identifiants refusés ».
 *
 * MQTT 3.1.1 : 4 = mauvais nom/mot de passe, 5 = non autorisé.
 * MQTT 5 : 0x85 (133) identifiant client refusé, 0x86 (134) nom/mot de passe invalides,
 * 0x87 (135) non autorisé.
 *
 * Les distinguer d'un refus de connexion est tout l'intérêt du bouton de test : « ça ne marche
 * pas » n'aide personne à savoir s'il doit corriger l'adresse ou le mot de passe.
 */
const AUTH_REASON_CODES = new Set([4, 5, 133, 134, 135]);

/** Codes système d'un socket qui n'a jamais abouti. */
const REFUSED_SYSTEM_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN', 'EPROTO',
]);

function reasonCodeOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as Partial<ErrorWithReasonCode>).code;
  return typeof code === 'number' ? code : null;
}

function systemCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Traduit une erreur de `mqtt` en diagnostic exploitable par la page de réglages. */
function classifyConnectionError(err: unknown): BrokerTestOutcome {
  const reasonCode = reasonCodeOf(err);
  if (reasonCode !== null && AUTH_REASON_CODES.has(reasonCode)) {
    return { status: 'auth_failed', detail: messageOf(err) };
  }

  const systemCode = systemCodeOf(err);
  if (systemCode !== null && REFUSED_SYSTEM_CODES.has(systemCode)) {
    return { status: 'refused', detail: systemCode };
  }

  // Certains brokers (Mosquitto avec `allow_anonymous false`) coupent le socket sans CONNACK :
  // le message est alors la seule trace exploitable.
  if (/not authoriz|bad user|unauthorized|credential/i.test(messageOf(err))) {
    return { status: 'auth_failed', detail: messageOf(err) };
  }

  return { status: 'refused', detail: messageOf(err) };
}

/**
 * Tente une connexion réelle et rend un diagnostic. Utilisé par `POST /broker/test`.
 *
 * Ne relance jamais : `reconnectPeriod: 0`. Un test qui reconnecterait en boucle laisserait un
 * client vivant derrière lui à chaque clic sur le bouton.
 *
 * Ne journalise ni ne retourne jamais le mot de passe.
 */
export async function testBrokerConnection(
  config: BrokerConfig,
  timeoutMs: number = BROKER_TEST_TIMEOUT_MS,
): Promise<BrokerTestOutcome> {
  const problem = validateBrokerConfig(config);
  if (problem !== null) return { status: 'invalid_config', detail: problem };

  const topic = buildBridgeDevicesTopic(config.baseTopic);
  if (topic === null) return { status: 'invalid_config', detail: 'base_topic_invalid' };

  return new Promise<BrokerTestOutcome>((resolve) => {
    let client: MqttClient | null = null;
    let settled = false;
    let connected = false;
    let lastError: unknown = null;

    const timer = setTimeout(() => {
      // Connecté mais muet sur `bridge/devices` : le broker répond, le `base_topic` est faux.
      // C'est le diagnostic le plus utile du lot, et le seul que le délai permet d'établir.
      if (connected) return finish({ status: 'no_devices' });
      if (lastError !== null) return finish(classifyConnectionError(lastError));
      finish({ status: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    function finish(outcome: BrokerTestOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.end(true);
      } catch {
        // Client déjà fermé : c'est l'état voulu.
      }
      resolve(outcome);
    }

    try {
      client = mqtt.connect(buildBrokerUrl(config.host, config.port), {
        ...credentials(config),
        reconnectPeriod: 0,
        connectTimeout: timeoutMs,
        clientId: testClientId(),
        clean: true,
      });
    } catch (err) {
      finish(classifyConnectionError(err));
      return;
    }

    client.on('connect', () => {
      connected = true;
      client?.subscribe(topic, { qos: 0 }, (err) => {
        // Un broker qui refuse l'abonnement (ACL) est aussi un problème d'autorisation.
        if (err) finish({ status: 'auth_failed', detail: messageOf(err) });
      });
    });

    client.on('message', (received, payload) => {
      if (received !== topic) return;
      finish({ status: 'ok', deviceCount: parseDevicesPayload(payload).length });
    });

    client.on('error', (err) => {
      lastError = err;
      // Une erreur avant tout CONNACK est définitive ici : `reconnectPeriod` vaut 0, personne ne
      // réessaiera. Attendre l'échéance ne ferait que retarder un diagnostic déjà connu.
      if (!connected) finish(classifyConnectionError(err));
    });

    client.on('close', () => {
      if (lastError !== null) {
        finish(classifyConnectionError(lastError));
        return;
      }
      // Fermé après un CONNACK accepté et sans erreur : le broker nous a raccrochés au nez, en
      // général sur une ACL qui refuse l'abonnement. `reconnectPeriod` vaut 0, personne ne
      // réessaiera — attendre l'échéance pour annoncer « mauvais base_topic » serait un mensonge.
      if (connected) finish({ status: 'refused', detail: 'connection closed by broker' });
    });
  });
}

function credentials(config: BrokerConfig): Pick<IClientOptions, 'username' | 'password'> {
  const username = config.username?.trim() ?? '';
  const password = config.password ?? '';
  // Un `username: ''` envoyé à un broker anonyme est refusé par certaines configurations :
  // l'absence d'identifiant doit rester une absence.
  if (username === '') return {};
  return password === '' ? { username } : { username, password };
}

function testClientId(): string {
  return `homey-vtherm-test-${Math.random().toString(16).slice(2, 10)}`;
}

function parseDevicesPayload(payload: Uint8Array): BridgeDevice[] {
  try {
    return parseBridgeDevices(JSON.parse(Buffer.from(payload).toString('utf8')));
  } catch {
    // Charge utile tronquée ou non-JSON : un `bridge/devices` illisible vaut « aucun appareil ».
    return [];
  }
}

// --- La dorsale ------------------------------------------------------------

export class MqttValveBackend implements ValveBackend {

  private client: MqttClient | null = null;
  private stopped = false;

  /** Vidé et reconstruit à chaque `bridge/devices` : Z2M republie la liste entière, jamais un delta. */
  private bridgeDevices: BridgeDevice[] = [];
  private bridgeDevicesSeen = false;

  private readonly hints = new Map<string, Z2mDeviceHint>();
  private readonly resolved = new Map<string, string>();
  /** Devices dont l'échec de résolution a déjà été journalisé : une ligne, pas une par pas. */
  private readonly warned = new Set<string>();

  private reconnectDelayMs = RECONNECT_MIN_MS;

  private readonly config: BrokerConfig;
  private readonly hintFor: DeviceHintProvider;
  private readonly log: Logger;
  private readonly logError: Logger;

  constructor(options: MqttBackendOptions) {
    this.config = options.config;
    this.hintFor = options.hintFor;
    this.log = options.log ?? (() => undefined);
    this.logError = options.error ?? (() => undefined);
  }

  /**
   * Vrai seulement quand on est connecté ET que `bridge/devices` a été reçu.
   *
   * Sans cette liste on ne sait résoudre aucun `friendly_name` : se déclarer disponible ferait
   * croire à l'émetteur qu'il peut piloter la vanne, et il n'écrirait pas la consigne de repli.
   */
  get available(): boolean {
    return !this.stopped && this.client?.connected === true && this.bridgeDevicesSeen;
  }

  /** Adresse du broker, sans le mot de passe. Le seul texte de connexion qu'on journalise. */
  get describeTarget(): string {
    return `${buildBrokerUrl(this.config.host, this.config.port)} (base_topic « ${this.config.baseTopic} »)`;
  }

  /**
   * Ouvre la connexion. Ne lève pas et n'attend pas le CONNACK : la dorsale devient disponible
   * quand elle l'est, l'app démarre sans elle.
   */
  start(): void {
    if (this.client !== null || this.stopped) return;

    const problem = validateBrokerConfig(this.config);
    if (problem !== null) {
      this.logError(`Dorsale MQTT non démarrée, réglages invalides : ${problem}.`);
      return;
    }

    let client: MqttClient;
    try {
      client = mqtt.connect(buildBrokerUrl(this.config.host, this.config.port), {
        ...credentials(this.config),
        reconnectPeriod: this.reconnectDelayMs,
        connectTimeout: CONNECT_TIMEOUT_MS,
        clientId: `homey-vtherm-${Math.random().toString(16).slice(2, 10)}`,
        // Session non persistante : rien à rejouer côté broker après une coupure. Nos publications
        // sont des commandes datées de fait — rouvrir une vanne sur une décision vieille de vingt
        // minutes serait pire que ne rien faire. C'est aussi pourquoi `publish()` vérifie
        // `client.connected` avant d'écrire, plutôt que de laisser `mqtt` mettre en file d'attente.
        clean: true,
        resubscribe: true,
      });
    } catch (err) {
      this.logError('Dorsale MQTT : connexion impossible :', messageOf(err));
      return;
    }

    this.client = client;

    client.on('connect', () => {
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      client.options.reconnectPeriod = RECONNECT_MIN_MS;
      this.log(`Dorsale MQTT connectée à ${this.describeTarget}.`);
      this.subscribeBridgeDevices();
    });

    client.on('message', (topic, payload) => {
      this.onMessage(topic, payload);
    });

    client.on('error', (err) => {
      // `mqtt` relance de lui-même ; on ne fait qu'allonger le pas et tracer.
      this.logError('Dorsale MQTT :', describeError(err));
    });

    client.on('close', () => {
      if (this.stopped) return;
      // La liste des appareils appartient à la session : la garder ferait mentir `available`
      // pendant la coupure et laisserait résoudre des noms qu'on ne peut plus vérifier.
      this.bridgeDevicesSeen = false;
      this.bridgeDevices = [];
      this.resolved.clear();
      this.backOff(client);
    });
  }

  /** Allonge le pas de reconnexion. Un broker éteint pour la nuit ne doit pas boucler à 1 Hz. */
  private backOff(client: MqttClient): void {
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    client.options.reconnectPeriod = this.reconnectDelayMs;
  }

  private subscribeBridgeDevices(): void {
    const topic = buildBridgeDevicesTopic(this.config.baseTopic);
    const client = this.client;
    if (topic === null || client === null) return;

    // Z2M publie ce topic en RETENU : l'abonnement suffit, il n'y a rien à demander.
    client.subscribe(topic, { qos: 0 }, (err) => {
      if (err) this.logError(`Dorsale MQTT : abonnement à ${topic} refusé :`, describeError(err));
    });
  }

  private onMessage(topic: string, payload: Uint8Array): void {
    if (topic !== buildBridgeDevicesTopic(this.config.baseTopic)) return;

    const devices = parseDevicesPayload(payload);
    this.bridgeDevices = devices;
    this.bridgeDevicesSeen = true;
    // Les noms ont pu changer : tout réappariement doit repartir de la liste fraîche, et les
    // avertissements déjà émis redeviennent pertinents.
    this.resolved.clear();
    this.warned.clear();

    if (devices.length === 0) {
      this.logError(
        `Dorsale MQTT : ${topic} est vide ou illisible. Le base_topic est probablement faux — `
        + 'aucun contrôle direct de vanne ne sera possible.',
      );
      return;
    }
    this.log(`Dorsale MQTT : ${devices.length} appareils vus sur ${topic}.`);
  }

  // --- Contrat ValveBackend ------------------------------------------------

  async setValveOpening(deviceId: string, percent: number): Promise<void> {
    // Ouverture ET fermeture en un seul message (SPEC §5.5) : ces vannes sont sur piles.
    await this.publish(deviceId, buildValvePayload(percent), 'valve_opening_degree');
  }

  async setExternalTemperature(deviceId: string, celsius: number): Promise<void> {
    await this.publish(deviceId, buildExternalTemperaturePayload(celsius), 'external_temperature_input');
  }

  async setTemperatureSensorSelect(deviceId: string, source: TemperatureSensorSource): Promise<void> {
    await this.publish(deviceId, buildSensorSelectPayload(source), 'temperature_sensor_select');
  }

  async setLocalTemperatureCalibration(deviceId: string, offsetC: number): Promise<void> {
    await this.publish(deviceId, buildCalibrationPayload(offsetC), 'local_temperature_calibration');
  }

  /**
   * Publie, ou renonce en le disant. Ne lève jamais : voir l'en-tête, règle 1.
   */
  private async publish(deviceId: string, payload: Z2mPayload | null, what: string): Promise<void> {
    if (payload === null) {
      this.logError(`Dorsale MQTT : valeur inexploitable pour ${what} sur ${deviceId}, rien publié.`);
      return;
    }

    const client = this.client;
    if (this.stopped || client === null || !client.connected) return;

    const friendlyName = await this.friendlyNameOf(deviceId);
    if (friendlyName === null) return;

    const topic = buildSetTopic(this.config.baseTopic, friendlyName);
    if (topic === null) {
      this.logError(`Dorsale MQTT : topic impossible pour « ${friendlyName} », rien publié.`);
      return;
    }

    const body = JSON.stringify(payload);
    this.log(`Dorsale MQTT → ${topic} ${body}`);

    // Volontairement SANS attendre le PUBACK, malgré QoS 1.
    //
    // `publishAsync` ne résout qu'à l'acquittement, et rien ne borne cette attente : un broker
    // joignable mais qui n'acquitte pas — coupure réseau à mi-chemin, broker saturé — laisserait
    // ce `await` en suspens indéfiniment. L'émetteur attend cet appel, donc le pas de régulation
    // entier resterait bloqué, pour toutes les pièces. Une promesse qui ne se résout jamais est
    // pire qu'une erreur : au moins l'erreur laisse retomber sur la consigne.
    //
    // QoS 1 garde tout son sens : `mqtt` réémet de lui-même jusqu'à l'acquittement. Seule la
    // *nouvelle* de cet acquittement est asynchrone, et elle n'intéresse que le journal.
    client.publish(topic, body, { qos: PUBLISH_QOS, retain: false }, (err) => {
      if (err) this.logError(`Dorsale MQTT : publication sur ${topic} échouée :`, describeError(err));
    });
  }

  /**
   * Résout — et journalise. Explicitement, parce qu'un mauvais appariement écrirait sur la vanne
   * d'une autre pièce : c'est la panne la plus coûteuse de ce lot, et la seule trace que
   * l'utilisateur en aura est cette ligne de journal.
   */
  private async friendlyNameOf(deviceId: string): Promise<string | null> {
    const cached = this.resolved.get(deviceId);
    if (cached !== undefined) return cached;

    const hint = await this.hintOf(deviceId);
    const resolution = resolveFriendlyName(hint, this.bridgeDevices);

    if (!resolution.ok) {
      if (!this.warned.has(deviceId)) {
        this.warned.add(deviceId);
        this.logError(
          `Dorsale MQTT : aucun appareil Zigbee2MQTT associé au device Homey ${deviceId} `
          + `(${resolution.reason}, indices : friendly_name=${hint.friendlyName ?? '—'}, `
          + `ieee_address=${hint.ieeeAddress ?? '—'}). Aucune écriture ne partira pour ce device.`,
        );
      }
      return null;
    }

    this.resolved.set(deviceId, resolution.friendlyName);
    this.log(
      `Dorsale MQTT : device Homey ${deviceId} → « ${resolution.friendlyName} » (via ${resolution.via}).`,
    );
    return resolution.friendlyName;
  }

  private async hintOf(deviceId: string): Promise<Z2mDeviceHint> {
    const cached = this.hints.get(deviceId);
    if (cached !== undefined) return cached;

    let hint: Z2mDeviceHint = {};
    try {
      hint = await this.hintFor(deviceId);
    } catch (err) {
      this.logError(`Dorsale MQTT : lecture des réglages de ${deviceId} impossible :`, describeError(err));
    }
    this.hints.set(deviceId, hint);
    return hint;
  }

  /** Oublie ce qu'on sait d'un device : à appeler quand ses réglages changent. */
  forget(deviceId: string): void {
    this.hints.delete(deviceId);
    this.resolved.delete(deviceId);
    this.warned.delete(deviceId);
  }

  /** Appelé depuis `onUninit`. Ne lève pas : un arrêt qui échoue reste un arrêt. */
  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    this.bridgeDevices = [];
    this.bridgeDevicesSeen = false;
    this.resolved.clear();
    this.hints.clear();
    this.warned.clear();

    if (client === null) return;
    try {
      // Forcé : sans le drapeau, `end()` attend l'acquittement des publications en vol, et
      // `onUninit` ne dispose pas d'un temps illimité pour rendre la main à Homey.
      await client.endAsync(true);
    } catch (err) {
      this.logError('Dorsale MQTT : fermeture :', describeError(err));
    }
  }
}

/** Message d'erreur seul — jamais l'objet entier, qui porte les options de connexion. */
function describeError(err: unknown): string {
  const systemCode = systemCodeOf(err);
  const reasonCode = reasonCodeOf(err);
  const suffix = systemCode ?? (reasonCode !== null ? `code ${reasonCode}` : null);
  return suffix === null ? messageOf(err) : `${messageOf(err)} [${suffix}]`;
}
