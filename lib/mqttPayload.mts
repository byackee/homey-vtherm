/**
 * `lib/mqttPayload.mts` — tout ce que la dorsale MQTT (SPEC §1.1) sait décider sans réseau.
 *
 * Bornage des valeurs, construction des payloads Zigbee2MQTT, composition du topic, et surtout
 * **résolution du `friendly_name`** à partir d'un identifiant Homey. Cette dernière est ici, et
 * pas dans `runtime/`, parce que c'est la logique la plus dangereuse de tout le lot : un mauvais
 * appariement n'échoue pas, il ouvre la vanne d'une autre pièce. Ce qui peut être testé sans
 * broker doit l'être.
 *
 * La *politique* d'écriture (déduplication, `minDelta`, rappel périodique) n'est pas réécrite ici :
 * `lib/writePolicy.mts` la porte déjà et la dorsale MQTT s'en sert telle quelle.
 *
 * Pur : aucun import de `homey`, `mqtt` ni de module natif. Aucune lecture d'horloge.
 */

// --- Plages réelles du SONOFF TRVZB (SPEC §1) ------------------------------
//
// Hors plage, Z2M **rejette le message en silence** : pas d'erreur, pas d'écho, la vanne garde sa
// valeur précédente. D'où le bornage systématique plutôt qu'un refus — une valeur bornée chauffe,
// un message rejeté ne chauffe pas et ne le dit pas.

export const VALVE_OPENING_MIN = 0;
export const VALVE_OPENING_MAX = 100;
export const EXTERNAL_TEMPERATURE_MIN = 0;
export const EXTERNAL_TEMPERATURE_MAX = 99.9;
export const CALIBRATION_ABS_MAX = 12.7;

/** Sources de mesure acceptées par `temperature_sensor_select` et utiles à l'app (SPEC §5.3). */
export type TemperatureSensorSource = 'internal' | 'external';

/** Un payload Z2M tel qu'il part sur `<base_topic>/<friendly_name>/set`. */
export type Z2mPayload = Record<string, number | string>;

// --- Bornage ---------------------------------------------------------------

/**
 * Arrondi au dixième, sans le bruit binaire de `toFixed` reconverti.
 *
 * Symétrique autour de zéro : `Math.round` arrondit vers +∞, donc `−3,25` donnerait `−3,2` quand
 * `3,25` donne `3,3`. Le calibrage est une valeur signée dont un décalage positif et son opposé
 * doivent se compenser exactement ; une asymétrie d'un dixième s'accumulerait à chaque écriture
 * (SPEC §5.3, le calibrage est incrémental).
 */
function roundToTenth(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 10)) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Ouverture de vanne : entier 0-100. `null` sur une entrée non finie — mieux vaut ne rien
 * publier que publier un `NaN` qui, sérialisé en JSON, deviendrait `null` côté broker.
 */
export function clampValveOpening(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  // Arrondi AVANT bornage : le pas de la propriété est 1, et 100,4 doit valoir 100, pas être
  // refusé. Borner d'abord puis arrondir donnerait le même résultat ici, mais pas pour la
  // température, où la borne haute (99,9) n'est pas un multiple du pas.
  return clamp(Math.round(percent), VALVE_OPENING_MIN, VALVE_OPENING_MAX);
}

/**
 * Température injectée dans la vanne : 0-99,9 °C, un chiffre après la virgule.
 *
 * L'arrondi précède le bornage : 99,96 devient 100,0 puis retombe à 99,9. L'ordre inverse
 * rendrait 99,9 arrondi à… 99,9 aussi, mais laisserait passer 99,94 → 99,9 par accident plutôt
 * que par construction.
 */
export function clampExternalTemperature(celsius: number): number | null {
  if (!Number.isFinite(celsius)) return null;
  return clamp(roundToTenth(celsius), EXTERNAL_TEMPERATURE_MIN, EXTERNAL_TEMPERATURE_MAX);
}

/** Calibrage local : ±12,7 °C, un chiffre après la virgule (SPEC §5.3, mode `calibration`). */
export function clampCalibration(offsetC: number): number | null {
  if (!Number.isFinite(offsetC)) return null;
  return clamp(roundToTenth(offsetC), -CALIBRATION_ABS_MAX, CALIBRATION_ABS_MAX);
}

// --- Construction des payloads ---------------------------------------------

/**
 * Ouverture ET fermeture dans le MÊME payload (SPEC §5.5).
 *
 * `valve_closing_degree` reçoit `100 − ouverture`. Deux publications séparées feraient deux
 * écritures Zigbee au lieu d'une sur un appareil sur piles, et laisseraient la vanne dans un état
 * incohérent entre les deux — le firmware du TRVZB arbitre entre les deux degrés.
 */
export function buildValvePayload(percent: number): Z2mPayload | null {
  const opening = clampValveOpening(percent);
  if (opening === null) return null;
  return {
    valve_opening_degree: opening,
    valve_closing_degree: VALVE_OPENING_MAX - opening,
  };
}

export function buildExternalTemperaturePayload(celsius: number): Z2mPayload | null {
  const value = clampExternalTemperature(celsius);
  if (value === null) return null;
  return { external_temperature_input: value };
}

export function buildCalibrationPayload(offsetC: number): Z2mPayload | null {
  const value = clampCalibration(offsetC);
  if (value === null) return null;
  return { local_temperature_calibration: value };
}

export function buildSensorSelectPayload(source: TemperatureSensorSource): Z2mPayload {
  return { temperature_sensor_select: source };
}

// --- Topics ----------------------------------------------------------------

/** Retire les `/` de tête et de queue, sans toucher aux séparateurs internes. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * `<base_topic>/<friendly_name>/set` — exactement ce que publie la carte Flow `custom_payload_set`
 * de l'app Z2M (SPEC §1.1).
 *
 * `null` quand un des deux morceaux est vide, ou quand le `friendly_name` porte un joker MQTT
 * (`+`, `#`) : publier sur un topic à joker est refusé par le broker, et un `friendly_name` qui en
 * contient est de toute façon un appariement suspect.
 */
export function buildSetTopic(baseTopic: string, friendlyName: string): string | null {
  const base = trimSlashes(baseTopic.trim());
  const name = trimSlashes(friendlyName.trim());
  if (base === '' || name === '') return null;
  if (/[+#]/.test(base) || /[+#]/.test(name)) return null;
  return `${base}/${name}/set`;
}

/** Le topic retenu que Z2M republie à chaque démarrage, et notre seule source de vérité. */
export function buildBridgeDevicesTopic(baseTopic: string): string | null {
  const base = trimSlashes(baseTopic.trim());
  if (base === '' || /[+#]/.test(base)) return null;
  return `${base}/bridge/devices`;
}

// --- Configuration du broker -----------------------------------------------

export const DEFAULT_BROKER_PORT = 1883;
export const DEFAULT_BASE_TOPIC = 'zigbee2mqtt';

export interface BrokerConfig {
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  baseTopic: string;
}

export type ConfigProblem =
  | 'host_missing'
  | 'port_invalid'
  | 'base_topic_invalid'
  /** L'adresse porte une `userinfo` (`user:motdepasse@…`). Refusée, voir plus bas. */
  | 'host_has_credentials';

/** Ce qui remplace la `userinfo` dans toute adresse journalisée ou affichée. */
const REDACTED_USERINFO = '***';

/** Découpe une adresse en `{schéma, autorité, reste}` sans rien valider : usage interne. */
function splitAuthority(url: string): { scheme: string; authority: string; rest: string } {
  const scheme = /^[a-z]+:\/\//i.exec(url)?.[0] ?? '';
  const afterScheme = url.slice(scheme.length);
  // L'autorité s'arrête au premier `/` : un mot de passe ne se cache pas dans un chemin, et
  // découper au-delà transformerait un `@` de chemin en fausse détection d'identifiants.
  const pathStart = afterScheme.indexOf('/');
  return pathStart === -1
    ? { scheme, authority: afterScheme, rest: '' }
    : { scheme, authority: afterScheme.slice(0, pathStart), rest: afterScheme.slice(pathStart) };
}

/**
 * Remplace la `userinfo` d'une adresse de broker par `***`.
 *
 * `locales/*.json` invite à saisir une adresse complète, schéma et port compris : rien n'empêche
 * d'y écrire `mqtt://user:motdepasse@192.168.1.50`. Cette adresse est journalisée à chaque
 * connexion, et `GET /diagnostics` resert le journal entier. Le mot de passe du broker n'a rien à
 * y faire.
 *
 * Le `@` retenu est le DERNIER de l'autorité : un mot de passe peut légitimement en contenir un.
 */
export function redactBrokerUrl(url: string): string {
  const { scheme, authority, rest } = splitAuthority(url);
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  return `${scheme}${REDACTED_USERINFO}@${authority.slice(at + 1)}${rest}`;
}

/** Vrai quand l'adresse saisie porte une `userinfo`, avec ou sans mot de passe. */
export function hostHasCredentials(host: string): boolean {
  return splitAuthority(host.trim()).authority.includes('@');
}

/**
 * Valide la saisie de la page de réglages avant toute tentative réseau.
 *
 * Un port hors plage ou un `base_topic` à joker doit se voir comme une erreur de saisie, pas se
 * déguiser en « broker injoignable » après dix secondes d'attente.
 *
 * Une adresse porteuse d'identifiants est refusée plutôt qu'expurgée : l'app a deux champs faits
 * pour ça, et eux seuls tiennent le mot de passe hors des réponses HTTP et du journal. L'accepter
 * ici reviendrait à laisser un secret voyager dans un champ qui, lui, est relu par la page.
 */
export function validateBrokerConfig(config: BrokerConfig): ConfigProblem | null {
  if (config.host.trim() === '') return 'host_missing';
  if (hostHasCredentials(config.host)) return 'host_has_credentials';
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) return 'port_invalid';
  if (buildBridgeDevicesTopic(config.baseTopic) === null) return 'base_topic_invalid';
  return null;
}

/**
 * URL de connexion. Le port saisi n'est appliqué que si l'adresse n'en porte pas déjà un :
 * quelqu'un qui écrit `mqtts://broker.local:8883` a déjà tout dit, et lui recoller le 1883 par
 * défaut le connecterait ailleurs. Un schéma déjà présent est respecté (`mqtts`, `ws`, `wss`).
 */
export function buildBrokerUrl(host: string, port: number): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `mqtt://${trimmed}`;
  const authority = withScheme.replace(/^[a-z]+:\/\//i, '');
  // Un `:port` final, en excluant les `::` d'une IPv6 nue : un seul `:` pour un nom ou une IPv4,
  // ou bien la forme entre crochets de l'IPv6.
  const hasPort = /^[^:[\]]+:\d+$/.test(authority) || /^\[[^\]]+\]:\d+$/.test(authority);
  return hasPort ? withScheme : `${withScheme}:${port}`;
}

// --- Résolution Homey → friendly_name --------------------------------------

/** Ce qu'on retient d'une entrée de `<base_topic>/bridge/devices`. */
export interface BridgeDevice {
  friendlyName: string;
  ieeeAddress: string;
}

/**
 * Ce que l'appelant sait du device côté Homey. L'app Z2M range ces informations dans les
 * `settings` de chaque device qu'elle crée ; les noms de clés varient selon sa version, d'où
 * `extractDeviceHint()` plutôt qu'une lecture en dur.
 */
export interface Z2mDeviceHint {
  friendlyName?: string | undefined;
  ieeeAddress?: string | undefined;
}

export type ResolutionFailure =
  /** Aucun indice exploitable dans les réglages du device Homey. */
  | 'no_hint'
  /** `bridge/devices` pas encore reçu : on ne sait rien, on n'invente rien. */
  | 'no_bridge_devices'
  /** Indices connus, mais aucun appareil Z2M correspondant. */
  | 'not_found'
  /** Plusieurs appareils correspondent : refus délibéré, voir plus bas. */
  | 'ambiguous';

export type Resolution =
  | { ok: true; friendlyName: string; via: 'ieee_address' | 'friendly_name' }
  | { ok: false; reason: ResolutionFailure };

/** Les clés vues sur les devices de `com.gruijter.zigbee2mqtt`, plus leurs variantes plausibles. */
const FRIENDLY_NAME_KEYS = ['friendly_name', 'friendlyName', 'zigbee2mqtt_name'] as const;
const IEEE_ADDRESS_KEYS = ['ieee_address', 'ieeeAddress', 'ieeeAddr', 'ieee'] as const;

function firstNonEmptyString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Extrait les indices d'appariement des `settings` d'un device Homey.
 *
 * Tolérant par construction : on ne contrôle pas le schéma de réglages d'une app tierce, et une
 * clé absente doit produire « je ne sais pas » — jamais une chaîne vide qui matcherait ensuite.
 */
export function extractDeviceHint(settings: unknown): Z2mDeviceHint {
  if (typeof settings !== 'object' || settings === null) return {};
  const record = settings as Record<string, unknown>;
  return {
    friendlyName: firstNonEmptyString(record, FRIENDLY_NAME_KEYS),
    ieeeAddress: firstNonEmptyString(record, IEEE_ADDRESS_KEYS),
  };
}

/** Adresses IEEE : Z2M les écrit `0x00124b00...`, la casse et le préfixe varient selon la source. */
function normalizeIeee(value: string): string {
  const lowered = value.trim().toLowerCase();
  return lowered.startsWith('0x') ? lowered.slice(2) : lowered;
}

/**
 * Analyse le JSON retenu de `<base_topic>/bridge/devices`.
 *
 * Le coordinateur y figure aussi ; il est conservé, filtrer par `type` ferait dépendre
 * l'appariement d'un champ qu'on n'utilise pas. Une entrée sans les deux identifiants est
 * ignorée : elle ne peut servir à rien ici.
 */
export function parseBridgeDevices(raw: unknown): BridgeDevice[] {
  if (!Array.isArray(raw)) return [];

  const devices: BridgeDevice[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const friendlyName = record['friendly_name'];
    const ieeeAddress = record['ieee_address'];
    if (typeof friendlyName !== 'string' || friendlyName.trim() === '') continue;
    if (typeof ieeeAddress !== 'string' || ieeeAddress.trim() === '') continue;
    devices.push({ friendlyName: friendlyName.trim(), ieeeAddress: ieeeAddress.trim() });
  }
  return devices;
}

/**
 * Appareille un device Homey à un `friendly_name` Zigbee2MQTT.
 *
 * **Aucune correspondance approximative, jamais.** Ni préfixe, ni distance d'édition, ni « un seul
 * candidat contient le mot cuisine ». Une erreur d'appariement ici ouvre la vanne d'une autre
 * pièce, en silence, et l'utilisateur ne le découvre qu'en ayant froid : c'est la pire panne
 * possible de ce lot. Un refus explicite est toujours préférable — la dorsale retombe alors sur la
 * consigne, ce qui chauffe quand même.
 *
 * Ordre : l'adresse IEEE d'abord (elle est immuable), le `friendly_name` ensuite (il est
 * renommable par l'utilisateur, donc moins sûr). `via` remonte le chemin emprunté pour que
 * l'appelant le journalise.
 */
export function resolveFriendlyName(
  hint: Z2mDeviceHint,
  devices: readonly BridgeDevice[],
): Resolution {
  const wantedIeee = hint.ieeeAddress !== undefined ? normalizeIeee(hint.ieeeAddress) : '';
  const wantedName = hint.friendlyName?.trim() ?? '';

  if (wantedIeee === '' && wantedName === '') return { ok: false, reason: 'no_hint' };
  if (devices.length === 0) return { ok: false, reason: 'no_bridge_devices' };

  if (wantedIeee !== '') {
    const matches = devices.filter((device) => normalizeIeee(device.ieeeAddress) === wantedIeee);
    if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
    const match = matches[0];
    if (match !== undefined) return { ok: true, friendlyName: match.friendlyName, via: 'ieee_address' };
    // Pas de correspondance IEEE : on laisse sa chance au nom. L'appareil a pu être ré-appairé
    // et changer d'adresse tout en gardant son nom — cas courant après un remplacement de pile.
  }

  if (wantedName !== '') {
    const exact = devices.filter((device) => device.friendlyName === wantedName);
    if (exact.length > 1) return { ok: false, reason: 'ambiguous' };
    const exactMatch = exact[0];
    if (exactMatch !== undefined) {
      return { ok: true, friendlyName: exactMatch.friendlyName, via: 'friendly_name' };
    }

    // Repli insensible à la casse, et seulement s'il désigne UN appareil. Z2M autorise deux noms
    // ne différant que par la casse ; dans ce cas on refuse plutôt que de tirer à pile ou face.
    const lowered = wantedName.toLowerCase();
    const loose = devices.filter((device) => device.friendlyName.toLowerCase() === lowered);
    if (loose.length > 1) return { ok: false, reason: 'ambiguous' };
    const looseMatch = loose[0];
    if (looseMatch !== undefined) {
      return { ok: true, friendlyName: looseMatch.friendlyName, via: 'friendly_name' };
    }
  }

  return { ok: false, reason: 'not_found' };
}
