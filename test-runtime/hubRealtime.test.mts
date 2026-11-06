/**
 * `runtime/hub.mts` — l'abonnement temps réel d'une source survit à ses ré-abonnements.
 *
 * PANNE EMPÊCHÉE (forum, novembre 2026) : un contact de fenêtre vu avec jusqu'à cinq minutes de
 * retard, et une ouverture de deux minutes jamais vue. Remplacer la DERNIÈRE instance de capability
 * d'un appareil, en détruisant l'ancienne d'abord, désabonne l'appareil pour de bon, sans erreur :
 * sa valeur n'arrivait plus que par le recalcul périodique du thermostat.
 *
 * La classe `Device` est la VRAIE, chargée par son chemin profond, que `mock.module('homey-api')`
 * n'intercepte pas. C'est le point de ce fichier : la panne vit dans l'enchaînement de ses promesses
 * internes, et le faux appareil de `hub.test.mts` passait aussi bien avant qu'après le correctif.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import type Homey from 'homey';
import { FakeHomey } from './fakes/homey.mjs';

type HomeyInstance = Homey.App['homey'];

type Handlers = { onEvent(event: string, data: unknown): void };

interface RealDevice {
  capabilitiesObj: Record<string, { value: unknown; lastUpdated: string }>;
}

const require = createRequire(import.meta.url);
const Device = require('homey-api/lib/HomeyAPI/HomeyAPIV3/ManagerDevices/Device.js') as new (opts: {
  id: string; homey: unknown; manager: unknown; properties: Record<string, unknown>;
}) => RealDevice;

// --- Un Homey qui tient un contact, et compte ses abonnements --------------------

const live = new Set<Handlers>();
let contact: RealDevice;
const socketHandlers = new Map<string, () => void>();

/** Le registre réel se désabonne d'un coup ; un aller-retour réseau élargit la fenêtre de la course. */
let slowUnsubscribe = true;
/** Au-delà du délai de relâche de `Binding.destroy`. */
const RELEASE_ELAPSED_MS = 1_100;

const fakeHomeyApi = {
  async subscribe(_uri: string, handlers: Handlers): Promise<{ unsubscribe(): Promise<void> }> {
    live.add(handlers);
    return {
      async unsubscribe(): Promise<void> {
        if (slowUnsubscribe) await new Promise((resolve) => setTimeout(resolve, 1));
        live.delete(handlers);
      },
    };
  },
};

const fakeManager = { __debug(): void { /* muet */ }, scheduleRefresh(): void { /* muet */ } };

function newContact(): RealDevice {
  return new Device({
    id: 'contact-1',
    homey: fakeHomeyApi,
    manager: fakeManager,
    properties: {
      available: true,
      capabilitiesObj: {
        alarm_contact: { value: false, lastUpdated: new Date().toISOString() },
      },
    },
  });
}

const fakeApi = {
  devices: {
    async connect(): Promise<void> { /* déjà « abonné ». */ },
    async disconnect(): Promise<void> { /* rien à fermer. */ },
    isConnected(): boolean { return true; },
    async getDevices(): Promise<Record<string, RealDevice>> { return { 'contact-1': contact }; },
    async getDevice(): Promise<RealDevice> { return contact; },
  },
  zones: {
    async connect(): Promise<void> { /* rien. */ },
    async disconnect(): Promise<void> { /* rien. */ },
    async getZones(): Promise<Record<string, never>> { return {}; },
  },
  users: { async getUsers(): Promise<unknown> { return {}; } },
  weather: { async getWeather(): Promise<unknown> { return {}; } },
  on(event: string, handler: () => void): void { socketHandlers.set(event, handler); },
  destroy(): void { /* rien à relâcher. */ },
};

mock.module('homey-api', {
  namedExports: { HomeyAPI: { createAppAPI: async (): Promise<unknown> => fakeApi } },
});

const { HomeyApiHub } = await import('../runtime/hub.mjs');

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let transaction = 0;
/** Ce que Homey pousse quand le contact bouge. Rien n'arrive à qui n'est plus abonné. */
function contactMoves(value: boolean): void {
  transaction += 1;
  for (const handlers of live) {
    handlers.onEvent('capability', {
      capabilityId: 'alarm_contact',
      value,
      transactionId: `t-${transaction}`,
      transactionTime: Date.now() + transaction,
    });
  }
}

async function startedHub(): Promise<InstanceType<typeof HomeyApiHub>> {
  live.clear();
  socketHandlers.clear();
  contact = newContact();
  const hub = new HomeyApiHub(new FakeHomey() as unknown as HomeyInstance);
  await hub.start();
  return hub;
}

test('une reconnexion à Homey laisse le contact abonné : le prochain mouvement arrive', async () => {
  const hub = await startedHub();
  const seen: unknown[] = [];
  const binding = hub.bind('contact-1', 'alarm_contact', (reading) => seen.push(reading.value));
  await settle();
  assert.equal(live.size, 1, 'abonné une première fois');

  socketHandlers.get('reconnect')?.();
  await settle();

  assert.equal(live.size, 1, 'toujours abonné après la reconnexion');
  contactMoves(true);
  assert.deepEqual(seen, [true], 'l\'ouverture a prévenu le thermostat sans attendre son cycle');
  assert.equal(binding.read(Date.now(), 60_000)?.value, true);

  await hub.stop();
});

test('plusieurs reconnexions de suite ne perdent ni n\'empilent d\'abonnement', async () => {
  const hub = await startedHub();
  const seen: unknown[] = [];
  hub.bind('contact-1', 'alarm_contact', (reading) => seen.push(reading.value));
  await settle();

  socketHandlers.get('reconnect')?.();
  socketHandlers.get('connect')?.();
  socketHandlers.get('reconnect')?.();
  await settle();

  assert.equal(live.size, 1);
  contactMoves(true);
  assert.deepEqual(seen, [true], 'un seul avis : un abonné de trop recalculerait pour rien');

  await hub.stop();
});

for (const unsubscribe of ['synchrone', 'avec un aller-retour'] as const) {
  test(`re-désigner le même contact le laisse abonné (désabonnement ${unsubscribe})`, async () => {
    slowUnsubscribe = unsubscribe !== 'synchrone';
    const hub = await startedHub();
    // Source réparée : l'ancienne liaison est détruite, puis la nouvelle créée dans la foulée, et
    // aucune des deux ne connaît l'autre.
    const staleSeen: unknown[] = [];
    const first = hub.bind('contact-1', 'alarm_contact', (reading) => staleSeen.push(reading.value));
    await settle();
    const seen: unknown[] = [];
    first.destroy();
    hub.bind('contact-1', 'alarm_contact', (reading) => seen.push(reading.value));
    await settle(RELEASE_ELAPSED_MS);

    assert.equal(live.size, 1, 'toujours abonné, une fois l\'ancienne instance relâchée');
    contactMoves(true);
    assert.deepEqual(seen, [true]);
    assert.deepEqual(staleSeen, [], 'la liaison détruite ne prévient plus personne');

    await hub.stop();
  });
}

test('la dernière liaison détruite finit par désabonner l\'appareil : aucun abonnement ne fuit', async () => {
  const hub = await startedHub();
  const seen: unknown[] = [];
  const binding = hub.bind('contact-1', 'alarm_contact', (reading) => seen.push(reading.value));
  await settle();

  binding.destroy();
  contactMoves(true);
  assert.deepEqual(seen, [], 'plus d\'avis dès la destruction, même si l\'instance survit un instant');

  await settle(RELEASE_ELAPSED_MS);
  assert.equal(live.size, 0);

  await hub.stop();
});
