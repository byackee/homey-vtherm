/**
 * `runtime/mqttBackend.mts` — la dorsale Zigbee2MQTT, exercée contre un faux client `mqtt`.
 *
 * POURQUOI CE FICHIER EXISTE : jusqu'ici aucun test n'exerçait ce module. Les autres bancs se
 * contentent d'un `FakeValveBackend`, si bien qu'une régression sur le back-off, sur l'idempotence
 * de `stop()` ou sur le ré-abonnement après reconnexion laissait toute la suite au vert. Les
 * comportements vérifiés ici sont corrects aujourd'hui ; ce fichier est là pour qu'ils le restent.
 *
 * PANNES EMPÊCHÉES :
 *  - un broker éteint pour la nuit qu'on rappellerait à 1 Hz jusqu'au matin ;
 *  - une reconnexion qui perdrait l'abonnement à `bridge/devices` : plus aucun `friendly_name`
 *    résoluble, donc plus aucune écriture de vanne, en silence ;
 *  - deux clients vivants en même temps après un changement de réglages, écrivant tous deux sur
 *    les mêmes vannes ;
 *  - une écriture comptée comme partie alors que le broker est absent : l'émetteur la déduplique
 *    ensuite pendant une heure et la vanne reste sur sa position de nuit.
 *
 * Le paquet `mqtt` est substitué AVANT d'importer le module sous test.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { BrokerConfig } from '../lib/mqttPayload.mjs';

type Handler = (...args: unknown[]) => void;

interface ConnectOptions { reconnectPeriod: number; [key: string]: unknown }

/** Le strict nécessaire de la surface `mqtt` réellement utilisée par la dorsale. */
class FakeMqttClient {
  connected = false;
  readonly subscriptions: string[] = [];
  readonly published: { topic: string; body: string }[] = [];
  endCalls = 0;
  forcedEnd: boolean | null = null;

  private readonly handlers = new Map<string, Handler[]>();

  constructor(readonly options: ConnectOptions) {}

  on(event: string, fn: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  /** Déclenche un événement comme le ferait la bibliothèque. */
  fire(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }

  subscribe(topic: string, _opts: unknown, cb?: (err: Error | null) => void): void {
    this.subscriptions.push(topic);
    cb?.(null);
  }

  publish(topic: string, body: string, _opts: unknown, cb?: (err?: Error) => void): void {
    this.published.push({ topic, body });
    cb?.(undefined);
  }

  async endAsync(force?: boolean): Promise<void> {
    this.endCalls += 1;
    this.forcedEnd = force ?? null;
  }
}

const clients: FakeMqttClient[] = [];

mock.module('mqtt', {
  defaultExport: {
    connect(_url: string, options: ConnectOptions): FakeMqttClient {
      const client = new FakeMqttClient(options);
      clients.push(client);
      return client;
    },
  },
});

const { MqttValveBackend, BROKER_TEST_TIMEOUT_MS } = await import('../runtime/mqttBackend.mjs');

const CONFIG: BrokerConfig = {
  host: '192.168.1.10', port: 1883, baseTopic: 'zigbee2mqtt',
};

function backend(hint: { friendlyName?: string } = {}) {
  clients.length = 0;
  const instance = new MqttValveBackend({
    config: CONFIG,
    hintFor: () => hint,
    log: () => undefined,
    error: () => undefined,
  });
  instance.start();
  const client = clients[0];
  assert.ok(client, 'la dorsale a bien ouvert une connexion');
  return { instance, client };
}

/** Amène la dorsale à l'état « disponible » : connectée ET `bridge/devices` reçu. */
function bringUp(client: FakeMqttClient, friendlyName: string): void {
  client.connected = true;
  client.fire('connect');
  client.fire(
    'message',
    'zigbee2mqtt/bridge/devices',
    Buffer.from(JSON.stringify([{ friendly_name: friendlyName, ieee_address: '0x00124b0029336ed4' }])),
  );
}

// --- Back-off : un broker éteint ne doit pas être rappelé en boucle serrée ------

test('le pas de reconnexion DOUBLE à chaque coupure, et il est PLAFONNÉ', () => {
  const { client } = backend();

  client.fire('connect');
  assert.equal(client.options.reconnectPeriod, 2_000, 'au départ, 2 s');

  const steps: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    client.fire('close');
    steps.push(client.options.reconnectPeriod);
  }

  assert.deepEqual(
    steps.slice(0, 4), [4_000, 8_000, 16_000, 32_000],
    'chaque coupure double le pas',
  );
  assert.equal(
    steps.at(-1), 120_000,
    'et il plafonne à 2 min : sans ce plafond, un broker éteint pour la nuit serait rappelé '
    + 'des milliers de fois avant le matin',
  );
});

test('une reconnexion réussie REMET le pas au minimum', () => {
  const { client } = backend();

  client.fire('close');
  client.fire('close');
  assert.equal(client.options.reconnectPeriod, 8_000, 'le pas s\'est allongé');

  client.fire('connect');
  assert.equal(
    client.options.reconnectPeriod, 2_000,
    'sans cette remise à zéro, une coupure du matin punirait toute la journée',
  );
});

// --- Ré-abonnement : la liste des appareils appartient à la session -------------

test('chaque reconnexion se RÉABONNE à `bridge/devices`', () => {
  const { client } = backend();

  client.fire('connect');
  client.fire('close');
  client.fire('connect');

  assert.deepEqual(
    client.subscriptions,
    ['zigbee2mqtt/bridge/devices', 'zigbee2mqtt/bridge/devices'],
    'sans le second abonnement, plus aucun `friendly_name` ne serait résoluble après une coupure '
    + 'et aucune vanne ne bougerait, sans le moindre message',
  );
});

test('une coupure rend la dorsale INDISPONIBLE, même reconnectée tant que la liste manque', () => {
  const { instance, client } = backend({ friendlyName: 'Valve salon' });

  bringUp(client, 'Valve salon');
  assert.equal(instance.available, true, 'connectée et liste reçue');

  client.fire('close');
  assert.equal(
    instance.available, false,
    'la liste appartient à la session : la garder ferait résoudre des noms invérifiables',
  );

  client.fire('connect');
  assert.equal(
    instance.available, false,
    'reconnectée mais la liste n\'est pas revenue : se déclarer disponible ferait croire à '
    + 'l\'émetteur qu\'il pilote la vanne, et il n\'écrirait pas la consigne de repli',
  );
});

// --- `stop()` : appelé sans être attendu, deux fois, ou sans démarrage ----------

test('`stop()` marque l\'arrêt SYNCHRONEMENT, avant son premier `await`', async () => {
  const { instance, client } = backend({ friendlyName: 'Valve salon' });
  bringUp(client, 'Valve salon');
  assert.equal(instance.available, true);

  // Volontairement NON attendu : c'est ainsi qu'`app.mts` l'appelle au changement de réglages.
  const pending = instance.stop();

  assert.equal(
    instance.available, false,
    'sans cette synchronicité, l\'ancien et le nouveau client seraient tous deux actifs le temps '
    + 'de la fermeture, et écriraient tous deux sur les mêmes vannes',
  );
  await pending;
});

test('`stop()` est idempotent, et sûr sur une dorsale JAMAIS démarrée', async () => {
  const never = new MqttValveBackend({
    config: CONFIG, hintFor: () => ({}), log: () => undefined, error: () => undefined,
  });
  await never.stop();
  await never.stop();

  const { instance, client } = backend();
  await instance.stop();
  await instance.stop();
  assert.equal(client.endCalls, 1, 'le client n\'est fermé qu\'une fois');
  assert.equal(client.forcedEnd, true, 'et de force : `onUninit` n\'a pas un temps illimité');
});

test('une dorsale arrêtée ne se RALLUME pas', () => {
  const { instance, client } = backend();
  void instance.stop();
  instance.start();

  assert.equal(clients.length, 1, 'aucune seconde connexion n\'est ouverte');
  assert.equal(client.endCalls, 1);
});

// --- Publication : ne jamais rendre `true` sur une écriture qui n'est pas partie -

test('broker absent : l\'écriture rend FAUX plutôt que de se faire oublier', async () => {
  const { instance } = backend({ friendlyName: 'Valve salon' });

  assert.equal(
    await instance.setValveOpening('device-1', 42), false,
    'tant que cette méthode rendait `void`, l\'émetteur mémorisait l\'écriture comme faite et la '
    + 'dédupliquait une heure : la vanne restait à sa position de nuit et le relais de chaudière '
    + 's\'enclenchait sur un circuit fermé',
  );
});

test('broker présent : l\'écriture part sur le bon topic, sans attendre le PUBACK', async () => {
  const { instance, client } = backend({ friendlyName: 'Valve salon' });
  bringUp(client, 'Valve salon');

  assert.equal(await instance.setValveOpening('device-1', 42), true);
  assert.equal(client.published.length, 1);
  assert.equal(client.published[0]?.topic, 'zigbee2mqtt/Valve salon/set');
  assert.deepEqual(
    JSON.parse(client.published[0]?.body ?? '{}'),
    { valve_opening_degree: 42, valve_closing_degree: 58 },
    'l\'ouverture ET la fermeture sont publiées : la TRVZB exige les deux',
  );
});

test('appareil introuvable dans `bridge/devices` : rien ne part, et l\'écriture rend FAUX', async () => {
  const { instance, client } = backend({ friendlyName: 'Valve cuisine' });
  bringUp(client, 'Valve salon');

  assert.equal(await instance.setValveOpening('device-1', 42), false);
  assert.deepEqual(client.published, [], 'écrire sur la vanne d\'une autre pièce est la pire panne du lot');
});

// --- Le budget du test de broker vit sous le couperet de l'API d'app ------------

test('`BROKER_TEST_TIMEOUT_MS` garde de la marge sous les 10 s de l\'API d\'app', () => {
  assert.ok(
    BROKER_TEST_TIMEOUT_MS <= 8_000,
    'un appel à l\'API d\'une app est coupé à 10 s par Homey. À 10 000 ms le diagnostic était prêt '
    + 'à l\'instant où la frontière expirait, et l\'utilisateur voyait une erreur HTTP générique '
    + `au lieu du diagnostic (valeur actuelle : ${BROKER_TEST_TIMEOUT_MS} ms)`,
  );
});
