/**
 * `runtime/hub.mts` — les trois issues d'une écriture, vues par l'appelant.
 *
 * PANNE EMPÊCHÉE : l'écriture avalée. Une liaison non résolue rendait `false`, l'appelant y lisait
 * « l'appareil porte déjà la valeur », notait sa commande comme partie, et le relais de chaudière
 * n'était plus jamais recommandé. `false` ne doit signifier QUE la déduplication ; tout le reste
 * lève.
 *
 * Les assertions portent sur l'état du relais, jamais sur ce que la méthode a rendu : c'est
 * précisément parce qu'un test regardait la valeur de retour que la panne est passée.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import type Homey from 'homey';
import { FakeHomey } from './fakes/homey.mjs';

type HomeyInstance = Homey.App['homey'];
type CapValue = boolean | number | string;

// --- Faux `homey-api` -------------------------------------------------------
//
// Le vrai paquet parle à un websocket. On lui substitue un client qui tient UN appareil : un relais
// de chaudière dont l'état est observable, c'est-à-dire la seule chose qui compte ici.

class FakeRelay {
  readonly id = 'relay-1';
  readonly name = 'Relais chaudière';
  readonly zone = 'z1';
  readonly class = 'socket';
  readonly capabilities = ['onoff'];
  readonly capabilitiesObj: Record<string, { value?: unknown; lastUpdated?: unknown; setable?: boolean }> = {
    onoff: { value: false, lastUpdated: new Date(0).toISOString(), setable: true },
  };

  available = true;
  /** Chaque commutation réellement reçue par le relais. */
  readonly commutations: CapValue[] = [];

  makeCapabilityInstance(capabilityId: string, _listener: (value: CapValue | null) => void): unknown {
    const relay = this;
    return {
      get value(): CapValue | null {
        const raw = relay.capabilitiesObj[capabilityId]?.value;
        return typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string' ? raw : null;
      },
      lastChanged: new Date(0),
      async setValue(value: CapValue): Promise<void> {
        relay.apply(capabilityId, value);
      },
      on(): void { /* aucun `destroy` provoqué dans ces essais. */ },
      destroy(): void { /* rien à relâcher. */ },
    };
  }

  async setCapabilityValue(opts: { capabilityId: string; value: CapValue }): Promise<void> {
    this.apply(opts.capabilityId, opts.value);
  }

  private apply(capabilityId: string, value: CapValue): void {
    this.capabilitiesObj[capabilityId] = { value, lastUpdated: new Date(0).toISOString(), setable: true };
    this.commutations.push(value);
  }

  /** L'état PHYSIQUE du relais : allumé, coupé. Ce que l'app a cru commander n'entre pas ici. */
  get on(): boolean {
    return this.capabilitiesObj.onoff?.value === true;
  }
}

const relay = new FakeRelay();

const fakeApi = {
  devices: {
    async connect(): Promise<void> { /* déjà « abonné ». */ },
    async disconnect(): Promise<void> { /* rien à fermer. */ },
    isConnected(): boolean { return true; },
    async getDevices(): Promise<Record<string, FakeRelay>> { return { [relay.id]: relay }; },
    async getDevice(opts: { id: string }): Promise<FakeRelay> {
      if (opts.id !== relay.id) throw new Error(`appareil inconnu : ${opts.id}`);
      return relay;
    },
  },
  zones: {
    async connect(): Promise<void> { /* rien. */ },
    async disconnect(): Promise<void> { /* rien. */ },
    async getZones(): Promise<Record<string, { id: string; name: string }>> {
      return { z1: { id: 'z1', name: 'Chaufferie' } };
    },
  },
  on(): void { /* aucun événement websocket dans ces essais. */ },
  destroy(): void { /* rien à relâcher. */ },
};

mock.module('homey-api', {
  namedExports: { HomeyAPI: { createAppAPI: async (): Promise<unknown> => fakeApi } },
});

const { HomeyApiHub, UnresolvedBindingError } = await import('../runtime/hub.mjs');

function newHub(): InstanceType<typeof HomeyApiHub> {
  return new HomeyApiHub(new FakeHomey() as unknown as HomeyInstance);
}

// --- Les trois issues -------------------------------------------------------

test('une liaison pas encore résolue LÈVE, et le relais n\'a pas bougé', async () => {
  relay.commutations.length = 0;
  const hub = newHub();

  // Hub jamais démarré : c'est l'état des premières secondes de l'app, pendant que la connexion
  // à l'API Homey monte en tâche de fond et que le premier tick part déjà.
  const binding = hub.bind(relay.id, 'onoff');

  await assert.rejects(
    () => binding.write(true, { nowMs: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof UnresolvedBindingError, 'ce n\'est pas une déduplication');
      return true;
    },
  );

  assert.equal(relay.on, false, 'le relais est resté coupé');
  assert.equal(relay.commutations.length, 0, 'aucune commutation n\'est partie');
});

test('une liaison détruite LÈVE aussi : plus personne ne doit écrire par ce canal', async () => {
  relay.commutations.length = 0;
  const hub = newHub();
  const binding = hub.bind(relay.id, 'onoff');
  await hub.start();

  binding.destroy();

  await assert.rejects(
    () => binding.write(true, { nowMs: 0 }),
    (err: unknown) => err instanceof UnresolvedBindingError,
  );
  assert.equal(relay.on, false, 'le relais est resté coupé');

  await hub.stop();
});

test('`false` signifie déduplication, et rien d\'autre : le relais porte DÉJÀ la valeur', async () => {
  relay.commutations.length = 0;
  relay.capabilitiesObj.onoff = { value: false, lastUpdated: new Date(0).toISOString(), setable: true };

  const hub = newHub();
  const binding = hub.bind(relay.id, 'onoff');
  await hub.start();

  // Première écriture : elle part, le relais s'allume pour de bon.
  assert.equal(await binding.write(true, { nowMs: 0 }), true);
  assert.equal(relay.on, true, 'la chaudière est ALLUMÉE');
  assert.equal(relay.commutations.length, 1);

  // Seconde écriture identique : dédupliquée. Le relais est allumé, il le reste — c'est la seule
  // lecture honnête de `false`, et elle est vérifiable sur l'appareil.
  assert.equal(await binding.write(true, { nowMs: 1_000 }), false);
  assert.equal(relay.on, true, 'la chaudière est toujours ALLUMÉE');
  assert.equal(relay.commutations.length, 1, 'aucune seconde commutation : le contacteur n\'a pas servi');

  // Et le rappel périodique force bien la réaffirmation, sinon la déduplication deviendrait un
  // moyen de ne plus jamais écrire.
  assert.equal(await binding.write(true, { nowMs: 2_000, maxIntervalMs: 1 }), true);
  assert.equal(relay.commutations.length, 2);

  await hub.stop();
});

test('l\'extinction part vraiment quand la valeur change', async () => {
  relay.commutations.length = 0;
  relay.capabilitiesObj.onoff = { value: true, lastUpdated: new Date(0).toISOString(), setable: true };

  const hub = newHub();
  const binding = hub.bind(relay.id, 'onoff');
  await hub.start();

  assert.equal(await binding.write(false, { nowMs: 0 }), true);
  assert.equal(relay.on, false, 'la chaudière est ÉTEINTE');

  await hub.stop();
});
