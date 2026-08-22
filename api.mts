/**
 * `api.mts` — les endpoints consommés par la page de réglages de l'app.
 *
 * Trois responsabilités, pas une de plus :
 *  - dire où en est la dorsale Zigbee2MQTT (`GET /broker/status`) ;
 *  - tenter une connexion réelle et rendre un diagnostic exploitable (`POST /broker/test`) ;
 *  - montrer et re-désigner les sources des thermostats (`/thermostats`, `/candidates`).
 *
 * Cette dernière voie double la réparation Homey, elle ne la remplace pas. La réparation est
 * enfouie dans l'interface et son intitulé ne dit pas « changer mes capteurs » : l'utilisateur ne
 * la trouve pas. La page de réglages, elle, est toujours à un clic de l'app.
 *
 * Aucune logique n'est réécrite ici : la résolution des candidats vient de `VThermDriver`, la
 * liaison de `VThermDevice`. Ce fichier ne fait que les exposer en HTTP.
 *
 * Le mot de passe entre ici et n'en ressort jamais : aucune réponse ne le contient, aucun journal
 * ne l'écrit, même tronqué. La page de réglages peut en poser un nouveau, jamais relire l'ancien.
 */

import type Homey from 'homey';

import { DEFAULT_BASE_TOPIC, DEFAULT_BROKER_PORT } from './lib/mqttPayload.mjs';
import type { BrokerConfig } from './lib/mqttPayload.mjs';
import { BROKER_TEST_TIMEOUT_MS, testBrokerConnection } from './runtime/mqttBackend.mjs';
import type { BrokerTestOutcome } from './runtime/mqttBackend.mjs';
import type { HomeyApiHub } from './runtime/hub.mjs';
import { SOURCE_STORE_KEYS } from './drivers/vtherm/device.mjs';
import type VThermDevice from './drivers/vtherm/device.mjs';
import type { SourceKey } from './drivers/vtherm/device.mjs';
import type VThermDriver from './drivers/vtherm/driver.mjs';
import type { CandidateSummary } from './drivers/vtherm/driver.mjs';

/** `Homey.Homey` n'existe pas dans `@types/homey` : l'instance se lit depuis `App`. */
type HomeyInstance = Homey.App['homey'];

interface Request {
  homey: HomeyInstance;
  query: Record<string, string>;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/** Clés de `homey.settings`. Partagées avec `settings/index.html` et avec `app.mts`. */
export const BROKER_SETTINGS = {
  enabled: 'broker.enabled',
  host: 'broker.host',
  port: 'broker.port',
  username: 'broker.username',
  password: 'broker.password',
  baseTopic: 'broker.baseTopic',
} as const;

/**
 * Ce que `app.mts` peut exposer pour que la page reflète l'état réel de la dorsale.
 *
 * Optionnel à dessein : la page de réglages doit rester utilisable — et le bouton de test doit
 * rester cliquable — même quand l'app n'a pas encore démarré sa dorsale, ou pas du tout.
 */
interface BrokerAwareApp {
  isBrokerAvailable?: () => boolean;
}

export interface BrokerStatus {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  baseTopic: string;
  /** Le mot de passe lui-même n'est jamais renvoyé — seulement le fait qu'il y en ait un. */
  hasPassword: boolean;
  /** `null` quand l'app n'expose pas encore son état : « inconnu » n'est pas « déconnecté ». */
  available: boolean | null;
}

function readString(homey: HomeyInstance, key: string): string {
  const value = homey.settings.get(key);
  return typeof value === 'string' ? value : '';
}

function readPort(homey: HomeyInstance): number {
  const value = homey.settings.get(BROKER_SETTINGS.port);
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_BROKER_PORT;
}

function storedConfig(homey: HomeyInstance): BrokerConfig {
  const baseTopic = readString(homey, BROKER_SETTINGS.baseTopic).trim();
  return {
    host: readString(homey, BROKER_SETTINGS.host).trim(),
    port: readPort(homey),
    username: readString(homey, BROKER_SETTINGS.username).trim(),
    password: readString(homey, BROKER_SETTINGS.password),
    baseTopic: baseTopic === '' ? DEFAULT_BASE_TOPIC : baseTopic,
  };
}

function brokerStatus(homey: HomeyInstance): BrokerStatus {
  const config = storedConfig(homey);
  const app = homey.app as unknown as BrokerAwareApp | undefined;

  let available: boolean | null = null;
  try {
    if (typeof app?.isBrokerAvailable === 'function') available = app.isBrokerAvailable() === true;
  } catch {
    // Une app qui répond mal à cette question ne doit pas casser la page de réglages.
    available = null;
  }

  return {
    enabled: homey.settings.get(BROKER_SETTINGS.enabled) === true,
    host: config.host,
    port: config.port,
    username: config.username ?? '',
    baseTopic: config.baseTopic,
    hasPassword: (config.password ?? '') !== '',
    available,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Assemble la configuration à tester : ce que la page envoie, complété par ce qui est stocké.
 *
 * Le mot de passe suit cette règle et pas une autre : un champ vide signifie « garde celui que tu
 * as », parce que la page ne peut pas le relire pour le renvoyer. Sans ça, tester une connexion
 * sans retaper son mot de passe échouerait toujours.
 */
function configFromBody(homey: HomeyInstance, body: Record<string, unknown>): BrokerConfig {
  const stored = storedConfig(homey);

  const host = optionalString(body['host'])?.trim();
  const username = optionalString(body['username'])?.trim();
  const password = optionalString(body['password']);
  const baseTopic = optionalString(body['baseTopic'])?.trim();

  const rawPort = body['port'];
  const port = typeof rawPort === 'number'
    ? rawPort
    : Number.parseInt(String(rawPort ?? ''), 10);

  return {
    host: host !== undefined && host !== '' ? host : stored.host,
    port: Number.isInteger(port) ? port : stored.port,
    username: username ?? stored.username,
    password: password !== undefined && password !== '' ? password : stored.password,
    baseTopic: baseTopic !== undefined && baseTopic !== '' ? baseTopic : stored.baseTopic,
  };
}

// --- Sources des thermostats ------------------------------------------------

/** Le seul driver qui possède des sources. Le même identifiant que le dossier `drivers/vtherm`. */
const VTHERM_DRIVER_ID = 'vtherm';

/**
 * Ordre d'affichage des six sources : celui de `SOURCE_STORE_KEYS`, donc celui de la page de
 * réparation. Deux écrans qui listent les mêmes choses dans deux ordres différents se lisent
 * comme deux fonctions différentes.
 */
const SOURCE_KEYS = Object.keys(SOURCE_STORE_KEYS) as SourceKey[];

/** Ce que l'app expose de son hub. Optionnel : le getter lève tant que `onInit` n'a pas fini. */
interface HubAwareApp {
  hub?: HomeyApiHub;
}

export interface SourceView {
  source: SourceKey;
  deviceId: string | null;
  /** `null` quand l'appareil est introuvable, ou quand le hub n'a pas encore pu répondre. */
  deviceName: string | null;
  zoneName: string | null;
  /**
   * Identifiant lié auquel plus aucun appareil ne répond. C'est le cas de réparation le plus
   * fréquent — un appareil Zigbee2MQTT ré-appairé change d'identifiant — et il est parfaitement
   * silencieux : la pièce cesse d'être régulée sans que rien ne l'annonce. Il doit se voir.
   */
  missing: boolean;
}

export interface ThermostatView {
  /** `data.id`, tiré au pairing et immuable : c'est par lui que `PUT` retrouve l'appareil. */
  id: string;
  name: string;
  sources: SourceView[];
}

export interface ThermostatsResponse {
  /**
   * Sans hub, aucun nom ne peut être résolu. La page doit le dire plutôt que de déclarer orphelines
   * les six sources de chaque thermostat : ce serait une fausse alerte, et la pire qui soit.
   */
  hubConnected: boolean;
  thermostats: ThermostatView[];
}

function hubOf(homey: HomeyInstance): HomeyApiHub | null {
  const app = homey.app as unknown as HubAwareApp | undefined;
  try {
    return app?.hub ?? null;
  } catch {
    // `app.hub` lève tant que l'app n'a pas fini son `onInit` : « pas encore » n'est pas une erreur.
    return null;
  }
}

function vthermDriver(homey: HomeyInstance): VThermDriver | null {
  try {
    return homey.drivers.getDriver(VTHERM_DRIVER_ID) as VThermDriver;
  } catch {
    // Driver pas encore initialisé : la page affichera « aucun thermostat », pas une erreur brute.
    return null;
  }
}

function vthermDevices(homey: HomeyInstance): VThermDevice[] {
  const driver = vthermDriver(homey);
  if (driver === null) return [];
  return driver.getDevices() as VThermDevice[];
}

function thermostatKey(device: VThermDevice): string | null {
  const data = device.getData() as { id?: unknown } | null;
  return typeof data?.id === 'string' && data.id.length > 0 ? data.id : null;
}

function asSourceKey(value: unknown): SourceKey | null {
  return typeof value === 'string' && value in SOURCE_STORE_KEYS ? value as SourceKey : null;
}

/**
 * Résolution nom + zone, mémorisée le temps d'une requête.
 *
 * Plusieurs thermostats partagent volontiers la même sonde extérieure et le même détecteur de
 * présence : sans ce cache, une installation de dix pièces interrogerait l'API Homey soixante
 * fois pour une seule ouverture de page, et le quota d'Athom n'est pas une vue de l'esprit.
 */
type SourceResolver = (source: SourceKey, deviceId: string) => Promise<SourceView>;

function nameResolver(hub: HomeyApiHub | null): SourceResolver {
  const cache = new Map<string, { name: string; zoneName: string | null } | null>();

  return async (source: SourceKey, deviceId: string): Promise<SourceView> => {
    let summary = cache.get(deviceId);
    if (summary === undefined) {
      summary = null;
      try {
        const found = hub === null ? null : await hub.getDeviceSummary(deviceId);
        if (found !== null) summary = { name: found.name, zoneName: found.zoneName };
      } catch {
        // API muette : indistinguable d'un appareil disparu du point de vue de cette page.
        summary = null;
      }
      cache.set(deviceId, summary);
    }

    return {
      source,
      deviceId,
      deviceName: summary?.name ?? null,
      zoneName: summary?.zoneName ?? null,
      // On ne crie à l'orphelin que quand on a réellement pu chercher.
      missing: hub !== null && summary === null,
    };
  };
}

async function describeSources(
  device: VThermDevice,
  resolve: SourceResolver,
): Promise<SourceView[]> {
  const current = device.currentSources();
  const views: SourceView[] = [];

  for (const source of SOURCE_KEYS) {
    const deviceId = current[source];
    views.push(deviceId === null
      ? { source, deviceId: null, deviceName: null, zoneName: null, missing: false }
      : await resolve(source, deviceId));
  }

  return views;
}

export default {

  /**
   * Tout ce que l'app sait d'elle-même, en lecture seule.
   *
   * `homey api raw get /api/app/com.dataweavelabs.adaptivethermostat/diagnostics` depuis un poste de dev.
   */
  async getDiagnostics({ homey }: Request): Promise<unknown> {
    const app = homey.app as { getDiagnostics?: () => unknown } | undefined;
    return app?.getDiagnostics?.() ?? { error: 'app indisponible' };
  },

  async getBrokerStatus({ homey }: Request): Promise<BrokerStatus> {
    return brokerStatus(homey);
  },

  /**
   * Tente une vraie connexion, dix secondes au plus, et rend le diagnostic tel quel.
   *
   * Distinguer « connexion refusée », « identifiants refusés », « connecté mais aucun
   * `bridge/devices` » et « connecté, N appareils » est tout l'intérêt de ce bouton : un broker mal
   * renseigné doit se voir ici, pas se découvrir au premier jour de chauffe.
   */
  async testBroker({ homey, body }: Request): Promise<BrokerTestOutcome> {
    return testBrokerConnection(configFromBody(homey, body), BROKER_TEST_TIMEOUT_MS);
  },

  /**
   * Les thermostats et, pour chacun, les six sources avec le NOM de l'appareil lié.
   *
   * Le nom, pas seulement l'identifiant : un `store` ne contient que des identifiants opaques, et
   * une page qui les afficherait tels quels n'apprendrait rien à personne. Un identifiant que plus
   * aucun appareil ne porte revient avec `missing: true` — c'est précisément ce que l'utilisateur
   * vient chercher ici.
   */
  async getThermostats({ homey }: Request): Promise<ThermostatsResponse> {
    const hub = hubOf(homey);
    const hubConnected = hub?.connected === true;
    const resolve = nameResolver(hubConnected ? hub : null);

    const thermostats: ThermostatView[] = [];
    for (const device of vthermDevices(homey)) {
      const id = thermostatKey(device);
      // Un appareil sans `data.id` ne serait pas re-trouvable au `PUT` : mieux vaut ne pas le
      // proposer que d'offrir un réglage qui échouerait au clic.
      if (id === null) continue;
      thermostats.push({ id, name: device.getName(), sources: await describeSources(device, resolve) });
    }

    thermostats.sort((a, b) => a.name.localeCompare(b.name));
    return { hubConnected, thermostats };
  },

  /**
   * Les appareils éligibles à une source donnée, résolus exactement comme au pairing.
   *
   * L'appel est délégué au driver : la correspondance source → capabilities vit dans
   * `SOURCE_CAPABILITIES`, et la recopier ici créerait une seconde vérité. C'est déjà ce qui avait
   * rendu les détecteurs de présence introuvables.
   */
  async getSourceCandidates({ homey, query }: Request): Promise<CandidateSummary[]> {
    const source = asSourceKey(query['source']);
    if (source === null) throw new Error(homey.__('settings.sources.unknown_source'));

    const driver = vthermDriver(homey);
    if (driver === null) throw new Error(homey.__('pair.error.no_api'));

    return driver.listCandidates({ source });
  },

  /**
   * Re-désigne une source. Appliqué au choix, comme dans la page de réparation.
   *
   * `rebindSource` porte toute la logique : elle refuse de vider `room` et `emitter` avec le
   * message traduit `pair.error.incomplete`, recharge l'appareil quand l'émetteur change, et
   * redemande un pas de régulation. Rien de tout cela n'est répété ici.
   *
   * L'identifiant demandé est en revanche VALIDÉ ici, et pas seulement affiché par la page.
   * `rebindSource` ne vérifie ni l'existence, ni la classe, ni les capabilities de l'appareil :
   * le filtre vivait uniquement dans la liste, donc côté client. Un appel direct pouvait donc
   * désigner une lampe comme émetteur — elle serait pilotée en découpage temporel — ou, pire, un
   * thermostat de cette app comme émetteur d'un autre, ce qui referme exactement la boucle de
   * régulation que `isOwnDevice` existe pour empêcher.
   */
  async setThermostatSource({ homey, body }: Request): Promise<SourceView> {
    const source = asSourceKey(body['source']);
    if (source === null) throw new Error(homey.__('settings.sources.unknown_source'));

    const thermostatId = optionalString(body['deviceId']) ?? '';
    const device = vthermDevices(homey).find((candidate) => thermostatKey(candidate) === thermostatId);
    if (device === undefined) throw new Error(homey.__('settings.sources.unknown_thermostat'));

    const raw = optionalString(body['sourceDeviceId']);
    const sourceDeviceId = raw !== undefined && raw !== '' ? raw : null;

    if (sourceDeviceId !== null) {
      const driver = vthermDriver(homey);
      if (driver === null) throw new Error(homey.__('pair.error.no_api'));

      // La MÊME fonction que la page, jamais une réécriture « presque » identique : deux filtres
      // de sécurité qui dérivent l'un de l'autre, c'est un filtre de moins au premier oubli.
      const candidates = await driver.listCandidates({ source });
      if (!candidates.some((candidate) => candidate.id === sourceDeviceId)) {
        throw new Error(homey.__('settings.sources.invalid_device'));
      }
    }

    await device.rebindSource(source, sourceDeviceId);

    // La page se réaligne sur ce que l'appareil porte VRAIMENT, pas sur ce qu'elle a demandé.
    const hub = hubOf(homey);
    const resolve = nameResolver(hub?.connected === true ? hub : null);
    const current = device.currentSources()[source];
    if (current === null) {
      return { source, deviceId: null, deviceName: null, zoneName: null, missing: false };
    }
    return resolve(source, current);
  },
};
