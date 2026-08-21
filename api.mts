/**
 * `api.mts` — les endpoints consommés par la page de réglages de l'app.
 *
 * Deux responsabilités, pas une de plus :
 *  - dire où en est la dorsale Zigbee2MQTT (`GET /broker/status`) ;
 *  - tenter une connexion réelle et rendre un diagnostic exploitable (`POST /broker/test`).
 *
 * Le mot de passe entre ici et n'en ressort jamais : aucune réponse ne le contient, aucun journal
 * ne l'écrit, même tronqué. La page de réglages peut en poser un nouveau, jamais relire l'ancien.
 */

import type Homey from 'homey';

import { DEFAULT_BASE_TOPIC, DEFAULT_BROKER_PORT } from './lib/mqttPayload.mjs';
import type { BrokerConfig } from './lib/mqttPayload.mjs';
import { BROKER_TEST_TIMEOUT_MS, testBrokerConnection } from './runtime/mqttBackend.mjs';
import type { BrokerTestOutcome } from './runtime/mqttBackend.mjs';

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

export default {

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
};
