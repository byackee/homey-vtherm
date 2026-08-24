/**
 * `app.mts` — l'ordre du cycle, les transitions de la dorsale, et l'arrêt.
 *
 * PANNES EMPÊCHÉES :
 *  - la dorsale Zigbee2MQTT qui tombe en cours de journée sans que personne ne s'en aperçoive :
 *    `setValveBackend()` ne part que sur un changement de RÉGLAGES, seule `backend.available`
 *    bascule. Les émetteurs retombaient bien en régulation par consigne, mais leurs vannes
 *    restaient figées sur leur dernière ouverture — ramenée à 12 % par le TPI, une pièce à 16 °C
 *    ne remontait plus jamais ;
 *  - `onUninit` qui rendrait la main avant la fin du pas en vol : la remise en état sûr est alors
 *    doublée par une écriture déjà lancée, et le convecteur qu'on vient d'éteindre se rallume.
 *
 * Le paquet npm `homey` est le CLI d'Athom : il faut le substituer AVANT d'importer l'app.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { CentralParticipant, VThermParticipant } from '../runtime/participants.mjs';
import { CONFIG, DEFAULTS } from './fixtures.mjs';
import { FakeBinding } from './fakes/binding.mjs';
import { FakeDeviceHost } from './fakes/deviceHost.mjs';
import { FakeEmitter } from './fakes/emitter.mjs';
import { FakeHomey } from './fakes/homey.mjs';
import { FakeValveBackend } from './fakes/valveBackend.mjs';

mock.module('homey', {
  defaultExport: {
    App: class { log(): void { /* rien */ } error(): void { /* rien */ } },
    Driver: class {},
    Device: class {},
  },
});

// L'API Homey ne doit jamais être jointe : le hub monte contre un client inerte.
mock.module('homey-api', {
  namedExports: {
    HomeyAPI: {
      createAppAPI: async (): Promise<unknown> => ({
        devices: {
          async connect(): Promise<void> { /* rien */ },
          async disconnect(): Promise<void> { /* rien */ },
          isConnected(): boolean { return false; },
          async getDevices(): Promise<Record<string, unknown>> { return {}; },
          async getDevice(): Promise<never> { throw new Error('aucun appareil'); },
        },
        zones: {
          async connect(): Promise<void> { /* rien */ },
          async disconnect(): Promise<void> { /* rien */ },
          async getZones(): Promise<Record<string, unknown>> { return {}; },
        },
        on(): void { /* rien */ },
        destroy(): void { /* rien */ },
      }),
    },
  },
});

const { default: VThermApp } = await import('../app.mjs');

type AppInstance = InstanceType<typeof VThermApp>;

/** Battement de base de l'ordonnanceur et fenêtre de coalescence, tels que l'app les laisse. */
const BASE_MS = 10_000;

interface World {
  homey: FakeHomey;
  app: AppInstance;
  host: FakeDeviceHost;
  emitter: FakeEmitter;
  room: FakeBinding;
  participant: VThermParticipant;
}

async function boot(mode: 'valve' | 'switch'): Promise<World> {
  const homey = new FakeHomey();
  const app = new (VThermApp as unknown as new () => AppInstance)();
  Object.defineProperty(app, 'homey', { value: homey, configurable: true });

  await app.onInit();
  await FakeHomey.settle();

  const host = new FakeDeviceHost('salon');
  const emitter = new FakeEmitter('emetteur-salon');
  emitter.mode = mode;
  const room = new FakeBinding();

  const participant = new VThermParticipant({
    host,
    emitter,
    sources: {
      room, outdoor: null, windowContact: null, motion: null, presence: null,
    },
    config: CONFIG,
    syncMode: 'off',
    controlsBoiler: true,
    centralMode: () => app.centralMode(),
    requestTick: (reason) => app.requestTick(reason),
    defaults: DEFAULTS,
    nowMs: 0,
  });
  app.registerVTherm(participant);

  return {
    homey, app, host, emitter, room, participant,
  };
}

/**
 * Fait passer un cycle complet.
 *
 * L'ordonnanceur de l'app lit l'horloge RÉELLE — elle ne lui est pas injectable — mais ses
 * minuteries sont celles de `FakeHomey` : c'est `advance()` qui déclenche le battement, et
 * `settle()` qui laisse le cycle aller jusqu'au bout. Les lectures des capteurs sont donc datées
 * de `Date.now()`, faute de quoi elles paraîtraient vieilles de cinquante ans.
 */
async function cycle(homey: FakeHomey): Promise<void> {
  homey.advance(BASE_MS);
  await FakeHomey.settle();
}

// --- Transitions de la dorsale ------------------------------------------------

test('la dorsale qui TOMBE fait rendre la vanne, et une seule fois', async () => {
  const { homey, app, emitter } = await boot('valve');

  const backend = new FakeValveBackend();
  app.setValveBackend(backend);
  await cycle(homey);
  assert.equal(emitter.valveReleases.length, 0, 'une dorsale disponible ne fait rien rendre');

  // La connexion au broker tombe en pleine journée. Aucun réglage n'a changé.
  backend.available = false;
  await cycle(homey);

  assert.equal(emitter.valveReleases.length, 1, 'la vanne a été rendue');
  assert.equal(emitter.lastValve, 100, 'elle est GRANDE OUVERTE, pas figée sur son ouverture de nuit');

  // Les cycles suivants ne la rendent pas en boucle : on n'agit que sur les TRANSITIONS.
  await cycle(homey);
  await cycle(homey);
  assert.equal(emitter.valveReleases.length, 1);

  await app.onUninit();
});

test('la dorsale qui REVIENT efface l\'avertissement de vanne figée', async () => {
  const {
    homey, app, host, emitter, room,
  } = await boot('valve');

  room.setReading(18, Date.now());
  const backend = new FakeValveBackend();
  app.setValveBackend(backend);
  await cycle(homey);

  // C'est la dorsale qui tombe : la publication de remise à 100 % ne part pas non plus.
  emitter.releaseSucceeds = false;
  backend.available = false;
  await cycle(homey);
  assert.equal(host.lastWarning, 'device.warning.valve_stuck');

  backend.available = true;
  await cycle(homey);
  assert.equal(host.lastWarning, null, 'la vanne est reprise en main dès le pas suivant');

  await app.onUninit();
});

// --- Arrêt de l'app -------------------------------------------------------------

test('`onUninit` attend le pas en vol AVANT de rendre l\'état sûr', async () => {
  const {
    homey, app, emitter, room,
  } = await boot('switch');

  // Pièce froide : le pas va commander l'allumage du convecteur, et rester bloqué dessus.
  room.setReading(10, Date.now());
  const reprendre = emitter.pause();

  app.requestTick('mesure');
  homey.advance(BASE_MS);
  await FakeHomey.settle();
  assert.equal(emitter.switches.length, 0, 'le pas est bien en vol, bloqué dans son écriture');

  let termine = false;
  const arret = app.onUninit().then(() => { termine = true; });
  await FakeHomey.settle();
  assert.equal(termine, false, '`onUninit` n\'a pas rendu la main pendant que le pas écrit encore');

  reprendre();
  await arret;

  assert.deepEqual(
    emitter.switches.map((s) => s.on), [true, false],
    'l\'allumage du pas en vol, PUIS la coupure — jamais l\'inverse',
  );
  assert.equal(emitter.lastSwitch, false, 'le convecteur est ÉTEINT quand l\'app se retire');
  assert.equal(homey.pending, 0, 'et aucune minuterie ne survit au rechargement');
});

test('un participant désenregistré ne reçoit plus de pas', async () => {
  const {
    homey, app, emitter, room, participant,
  } = await boot('switch');

  room.setReading(10, Date.now());
  await cycle(homey);
  const apresPremier = emitter.switches.length;
  assert.ok(apresPremier > 0, 'le convecteur a bien été commandé');

  app.unregisterVTherm(participant.tickId);
  room.setReading(25, Date.now());
  await cycle(homey);
  await cycle(homey);

  assert.equal(emitter.switches.length, apresPremier, 'plus rien ne part vers cet émetteur');

  await app.onUninit();
});

// --- Tick ciblé : la charge baisse, l'agrégat chaudière reste entier ------------

test('tick demandé par UNE pièce : la chaudière compte encore celles qui n\'ont pas recalculé', async () => {
  // `requestTick` est branché sur le `onChange` de chaque liaison de source : faire recalculer tout
  // le logement à chaque mesure d'un seul capteur faisait croître la charge comme le carré du
  // nombre de pièces. Mais le resserrement ne doit RIEN retirer à l'agrégat chaudière — une pièce
  // qui a encore froid et dont rien n'a bougé doit rester comptée, sinon la chaudière s'éteint
  // sous elle. C'est ce que ce test garde.
  const { homey, app, room, participant } = await boot('switch');

  const relay = new FakeBinding();
  const central = new CentralParticipant({
    host: new FakeDeviceHost('chaudiere'),
    boiler: relay,
    params: {
      threshold: 1, activationDelaySec: 0, minDwellSec: 0, keepAliveSec: 0,
    },
    mode: 'auto',
    requestTick: () => undefined,
    nowMs: 0,
  });
  app.registerCentral(central);

  const emitter2 = new FakeEmitter('emetteur-cuisine');
  emitter2.mode = 'switch';
  const room2 = new FakeBinding();
  const second = new VThermParticipant({
    host: new FakeDeviceHost('cuisine'),
    emitter: emitter2,
    sources: {
      room: room2, outdoor: null, windowContact: null, motion: null, presence: null,
    },
    config: CONFIG,
    syncMode: 'off',
    controlsBoiler: true,
    centralMode: () => app.centralMode(),
    requestTick: (reason) => app.requestTick(reason),
    defaults: DEFAULTS,
    nowMs: 0,
  });
  app.registerVTherm(second);

  // Seule la CUISINE a froid. Le salon est au chaud et ne demandera rien.
  room.setReading(30, Date.now());
  room2.setReading(12, Date.now());
  await cycle(homey);
  assert.equal(second.demand.kind, 'active', 'la cuisine demande de la chaleur');
  assert.equal(relay.lastWrite?.value, true, 'la chaudière est allumée pour elle');

  // Le SALON annonce du neuf — pas la cuisine. Il nomme son thermostat, comme le fait `device.mts`.
  room.setReading(29, Date.now());
  app.requestTick(`${participant.tickId}:room`);
  await cycle(homey);

  assert.equal(
    relay.lastWrite?.value, true,
    'la cuisine n\'a pas recalculé, mais elle a toujours froid : agréger seulement les thermostats '
    + 'tiqués éteindrait la chaudière sous une pièce qui la réclame encore',
  );

  await app.onUninit();
});
