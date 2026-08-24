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

/** Compteur de tentatives, et nombre d'échecs à servir avant de rendre l'API. Zéro par défaut :
 *  tous les essais existants voient exactement le comportement d'avant. */
let createAttempts = 0;
let failNextCreates = 0;

mock.module('homey-api', {
  namedExports: {
    HomeyAPI: {
      createAppAPI: async (): Promise<unknown> => {
        createAttempts += 1;
        if (failNextCreates > 0) {
          failNextCreates -= 1;
          throw new Error('cloud indisponible');
        }
        return fakeApi;
      },
    },
  },
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

// --- Un échec de démarrage n'est pas une condamnation --------------------------

test('démarrage échoué : le hub réessaie tout seul, au lieu de rester mort en silence', async () => {
  // Sans reprise, `this.api` restait `null` À VIE : les écouteurs `connect`/`reconnect` ne sont
  // câblés qu'APRÈS le succès de `createAppAPI()`, donc rien ne rattrapait. L'app continuait de
  // battre, l'ordonnanceur de tiquer, aucune erreur ne se répétait — et plus une seule source
  // n'était lue ni une seule vanne pilotée, pour tout le logement, jusqu'à un redémarrage manuel.
  // Le déclencheur est ordinaire : `createAppAPI()` attend `homey.cloud.getHomeyId()`, donc une
  // Homey qui redémarre avant sa box échoue ici.
  mock.timers.enable({ apis: ['setTimeout'] });
  const hub = newHub();
  try {
    const before = createAttempts;
    failNextCreates = 1;

    await assert.rejects(hub.start(), /cloud indisponible/, 'le premier essai remonte bien l\'échec');
    assert.equal(createAttempts, before + 1, 'une seule tentative pour l\'instant');

    mock.timers.tick(5_000);
    // Laisser la chaîne de promesses du nouvel essai se dérouler.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    assert.equal(
      createAttempts, before + 2,
      'le hub a réessayé de lui-même : c\'est toute la différence entre une panne passagère et '
      + 'un logement sans chauffage jusqu\'au prochain redémarrage',
    );
  } finally {
    await hub.stop();
    mock.timers.reset();
    failNextCreates = 0;
  }
});

test('`stop()` annule la reprise : rien ne redémarre après un arrêt', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const hub = newHub();
  try {
    failNextCreates = 1;
    await assert.rejects(hub.start(), /cloud indisponible/);
    await hub.stop();

    const after = createAttempts;
    mock.timers.tick(60_000);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    assert.equal(createAttempts, after, 'un hub arrêté ne se relance pas dans le dos de l\'app');
  } finally {
    mock.timers.reset();
    failNextCreates = 0;
  }
});
