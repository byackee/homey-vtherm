/**
 * `drivers/vtherm/driver.mts` et `drivers/central/driver.mts` — pairing et candidats.
 *
 * PANNES EMPÊCHÉES :
 *  - la liste des émetteurs devenue un annuaire de la maison : 38 appareils portent `onoff`, dont
 *    toutes les lampes, et l'appareil qui chauffe y devient introuvable ;
 *  - un thermostat de cette app proposé comme émetteur d'un autre — chacun écrirait la consigne
 *    que l'autre relit, et la vanne dériverait jusqu'à sa butée ;
 *  - une capability déclarée à tort à la création : `addCapability`/`removeCapability` détruisent
 *    l'historique Insights, donc une tuile perpétuellement vide l'est pour toujours ;
 *  - un second appareil central, c'est-à-dire deux écrivains sur le même relais de chaudière.
 *
 * Le paquet npm `homey` est le CLI d'Athom, pas la bibliothèque du SDK : l'importer tel quel
 * exécuterait l'outil. D'où la substitution de module, AVANT tout import des drivers.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { DeviceSummary } from '../runtime/hub.mjs';
import type { SourceKey } from '../drivers/vtherm/device.mjs';
import { summaryOf } from './fakes/hub.mjs';

mock.module('homey', {
  defaultExport: { App: class {}, Driver: class {}, Device: class {} },
});

const { default: VThermDriver } = await import('../drivers/vtherm/driver.mjs');
const { default: CentralDriver } = await import('../drivers/central/driver.mjs');

const APP_ID = 'com.dataweavelabs.adaptivethermostat';

// --- Faux voisinage -----------------------------------------------------------

/** Faux hub : il ne connaît qu'une liste d'appareils et sait la filtrer par capability. */
class FakeApp {
  readonly traces: string[] = [];
  devices: DeviceSummary[] = [];
  hubConnected = true;

  readonly hub = {
    get connected(): boolean {
      return owner.hubConnected;
    },
    listDevicesByCapability: async (capabilityId: string): Promise<DeviceSummary[]> =>
      owner.devices.filter((device) => device.capabilities.includes(capabilityId)),
    getDeviceSummary: async (deviceId: string): Promise<DeviceSummary | null> =>
      owner.devices.find((device) => device.id === deviceId) ?? null,
  };

  trace(message: string): void {
    this.traces.push(message);
  }
}

/* `hub` est un littéral : il lui faut une référence stable vers l'app qui le porte. */
let owner: FakeApp;

function newApp(devices: DeviceSummary[]): FakeApp {
  const app = new FakeApp();
  app.devices = devices;
  owner = app;
  return app;
}

interface FakeHomeyInstance {
  manifest: { id: string };
  app: unknown;
  __(key: string): string;
  setTimeout(fn: () => void, ms: number): number;
}

function withHomey<T extends object>(instance: T, app: FakeApp, extra: object = {}): T {
  const homey: FakeHomeyInstance = {
    manifest: { id: APP_ID },
    app,
    __: (key: string) => key,
    setTimeout: (fn: () => void) => { fn(); return 0; },
  };
  Object.defineProperty(instance, 'homey', { value: homey, configurable: true });
  Object.assign(instance, extra);
  return instance;
}

type Candidate = { id: string; name: string; zoneName: string | null };

interface VThermInternals {
  listCandidates(data: unknown): Promise<Candidate[]>;
  buildDevice(
    selection: ReadonlyMap<SourceKey, string | null>,
    emitterIds: readonly string[],
  ): Promise<{
    name: string;
    data: { id: string };
    store: Record<string, string | string[] | null>;
    capabilities: string[];
  }>;
}

function vthermDriver(app: FakeApp): VThermInternals {
  const driver = Object.create(VThermDriver.prototype) as object;
  return withHomey(driver, app) as unknown as VThermInternals;
}

/** Session de pairing réduite à sa mécanique : enregistrer des gestionnaires, puis les appeler. */
class FakePairSession {
  private readonly handlers = new Map<string, (data: unknown) => Promise<unknown>>();

  setHandler(event: string, fn: (data: unknown) => Promise<unknown>): void {
    this.handlers.set(event, fn);
  }

  async emit(event: string, data?: unknown): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (handler === undefined) throw new Error(`aucun gestionnaire pour ${event}`);
    return handler(data);
  }
}

type Pairable = { onPair(session: unknown): Promise<void> };

// --- Candidats émetteurs : le filtre par classe ---------------------------------

const LAMPE = summaryOf({
  id: 'lampe', name: 'Lampe salon', deviceClass: 'light', capabilities: ['onoff'], setable: ['onoff'],
});
const PRISE = summaryOf({
  id: 'prise', name: 'Prise convecteur', deviceClass: 'socket', capabilities: ['onoff'], setable: ['onoff'],
});
const VANNE = summaryOf({
  id: 'vanne',
  name: 'Vanne salon',
  deviceClass: 'thermostat',
  capabilities: ['target_temperature.local', 'target_temperature', 'measure_battery'],
  setable: ['target_temperature.local'],
});

test('une lampe n\'est pas un émetteur ; une prise commutée si', async () => {
  const driver = vthermDriver(newApp([LAMPE, PRISE, VANNE]));

  const candidates = await driver.listCandidates({ source: 'emitter' });
  const ids = candidates.map((c) => c.id).sort();

  assert.deepEqual(ids, ['prise', 'vanne']);
  assert.ok(!ids.includes('lampe'), 'sinon l\'appareil qui chauffe devient introuvable dans la liste');
});

test('un thermostat de cette app ne se propose jamais comme émetteur d\'un autre', async () => {
  const mien = summaryOf({
    id: 'vtherm-chambre',
    name: 'Thermostat chambre',
    deviceClass: 'thermostat',
    capabilities: ['target_temperature'],
    setable: ['target_temperature'],
    driverUri: `homey:app:${APP_ID}:vtherm`,
  });
  const driver = vthermDriver(newApp([mien, VANNE]));

  const ids = (await driver.listCandidates({ source: 'emitter' })).map((c) => c.id);

  assert.deepEqual(ids, ['vanne'], 'la boucle de régulation où chacun relit l\'autre est exclue');
});

test('un propriétaire inconnu ne fait pas disparaître l\'appareil de la liste', async () => {
  const anonyme = summaryOf({
    id: 'anonyme',
    name: 'Convecteur',
    deviceClass: 'heater',
    capabilities: ['onoff'],
    setable: ['onoff'],
    driverUri: null,
  });
  const driver = vthermDriver(newApp([anonyme]));

  const ids = (await driver.listCandidates({ source: 'emitter' })).map((c) => c.id);
  assert.deepEqual(ids, ['anonyme'], 'masquer par excès de prudence priverait l\'utilisateur du sien');
});

test('les autres sources ne subissent PAS le filtre par classe', async () => {
  const capteur = summaryOf({
    id: 'capteur', name: 'Capteur salon', deviceClass: 'sensor', capabilities: ['measure_temperature'],
  });
  const driver = vthermDriver(newApp([capteur, VANNE]));

  const ids = (await driver.listCandidates({ source: 'room' })).map((c) => c.id);
  assert.deepEqual(ids, ['capteur']);
});

test('un détecteur de présence qui ne publie que `alarm_presence` reste trouvable', async () => {
  const mmwave = summaryOf({
    id: 'mmwave', name: 'mmWave salon', deviceClass: 'sensor', capabilities: ['alarm_presence'],
  });
  const driver = vthermDriver(newApp([mmwave]));

  assert.deepEqual((await driver.listCandidates({ source: 'motion' })).map((c) => c.id), ['mmwave']);
  assert.deepEqual((await driver.listCandidates({ source: 'presence' })).map((c) => c.id), ['mmwave']);
});

test('sans hub, la liste ne se contente pas d\'être vide : elle le DIT', async () => {
  const app = newApp([VANNE]);
  app.hubConnected = false;
  const driver = vthermDriver(app);

  await assert.rejects(
    () => driver.listCandidates({ source: 'emitter' }),
    /pair\.error\.no_api/,
    'une liste vide sans explication est la première cause d\'abandon au pairing',
  );
});

// --- Capabilities dérivées à la création -----------------------------------------

function selection(entries: Partial<Record<SourceKey, string>>): ReadonlyMap<SourceKey, string | null> {
  return new Map(Object.entries(entries) as [SourceKey, string | null][]);
}

/**
 * Crée l'appareil comme le ferait la vue de pairing.
 *
 * Les têtes sont un paramètre à part parce qu'elles le sont dans le driver : `emitter` dans la
 * sélection n'est plus que le reflet de la tête n°1. Les appeler ensemble ici garde les tests
 * lisibles sans masquer cette séparation — `emitters` explicite reste possible pour un groupe.
 */
function build(
  driver: VThermInternals,
  entries: Partial<Record<SourceKey, string>>,
  emitters?: readonly string[],
): ReturnType<VThermInternals['buildDevice']> {
  const ids = emitters ?? (entries.emitter === undefined ? [] : [entries.emitter]);
  return driver.buildDevice(selection(entries), ids);
}

const PIECE = summaryOf({
  id: 'capteur', name: 'Capteur salon', deviceClass: 'sensor', capabilities: ['measure_temperature'],
});

test('un émetteur sans consigne inscriptible n\'a PAS de tuile d\'ouverture de vanne', async () => {
  const driver = vthermDriver(newApp([PIECE, PRISE]));

  const created = await build(driver, { room: 'capteur', emitter: 'prise' });

  assert.ok(
    !created.capabilities.includes('vtherm_valve_open'),
    'une prise commutée est un interrupteur définitivement : la tuile resterait vide pour toujours',
  );
  assert.ok(!created.capabilities.includes('vtherm_emitter_battery'), 'une prise n\'a pas de pile');
});

test('une vanne à consigne inscriptible reçoit l\'ouverture et la pile', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE]));

  const created = await build(driver, { room: 'capteur', emitter: 'vanne' });

  assert.ok(created.capabilities.includes('vtherm_valve_open'));
  assert.ok(created.capabilities.includes('vtherm_emitter_battery'));
});

test('`alarm_contact` seulement si une fenêtre est désignée', async () => {
  const fenetre = summaryOf({
    id: 'fenetre', name: 'Fenêtre salon', deviceClass: 'sensor', capabilities: ['alarm_contact'],
  });
  const driver = vthermDriver(newApp([PIECE, VANNE, fenetre]));

  const sans = await build(driver, { room: 'capteur', emitter: 'vanne' });
  assert.ok(
    !sans.capabilities.includes('alarm_contact'),
    'une tuile « Fenêtre » perpétuellement fausse est une promesse que l\'app ne tient pas',
  );

  const avec = await build(driver, { room: 'capteur', emitter: 'vanne', window: 'fenetre' });
  assert.ok(avec.capabilities.includes('alarm_contact'));
  assert.ok(!avec.capabilities.includes('alarm_motion'), 'aucun mouvement désigné');
});

test('sans capteur de pièce ou sans émetteur, il n\'y a pas de thermostat à créer', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE]));

  await assert.rejects(() => build(driver, { room: 'capteur' }), /pair\.error\.incomplete/);
  await assert.rejects(() => build(driver, { emitter: 'vanne' }), /pair\.error\.incomplete/);
});

test('les sources choisies sont rangées dans le `store`, les autres à `null`', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE]));

  const created = await build(driver, { room: 'capteur', emitter: 'vanne' });

  assert.equal(created.store.roomId, 'capteur');
  assert.equal(created.store.emitterId, 'vanne');
  assert.equal(created.store.windowId, null);
  assert.ok(created.data.id.length > 0, 'l\'identité est tirée une fois et survit aux réparations');
});

// --- Groupe d'émetteurs : plusieurs têtes pour une pièce ----------------------------

const VANNE_2 = summaryOf({
  id: 'vanne-2',
  name: 'Vanne fenêtre',
  deviceClass: 'thermostat',
  capabilities: ['target_temperature'],
  setable: ['target_temperature'],
});

const PRISE_2 = summaryOf({
  id: 'prise-2', name: 'Prise convecteur nord', deviceClass: 'socket',
  capabilities: ['onoff'], setable: ['onoff'],
});

test('toutes les têtes sont rangées, et `emitterId` reste la première', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE, VANNE_2]));

  const created = await build(driver, { room: 'capteur' }, ['vanne', 'vanne-2']);

  assert.deepEqual(created.store.emitterIds, ['vanne', 'vanne-2']);
  assert.equal(
    created.store.emitterId,
    'vanne',
    'une version antérieure de l\'app relit ce champ : il doit désigner la tête de référence',
  );
});

test('une tuile suffit qu\'UNE tête la justifie', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE, VANNE_2]));

  // `vanne-2` d'abord : c'est elle la tête de référence, et elle n'a PAS de pile. La tuile vient
  // donc entièrement de la seconde tête — c'est tout l'objet de ce test.
  const created = await build(driver, { room: 'capteur' }, ['vanne-2', 'vanne']);

  assert.ok(
    created.capabilities.includes('vtherm_emitter_battery'),
    'une intersection aurait masqué la pile de la seule tête qui en a une, donc la seule '
    + 'qui s\'arrêtera un jour faute d\'avoir été changée',
  );
  assert.ok(created.capabilities.includes('vtherm_valve_open'));
});

test('un groupe qui mélange une vanne et un relais est refusé AU CHOIX, pas en hiver', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE, PRISE]));

  await assert.rejects(
    () => build(driver, { room: 'capteur' }, ['vanne', 'prise']),
    /pair\.error\.mixed_emitters/,
    '`lib/step.mts` choisit une branche entière sur `emitterMode` : un groupe mixte n\'a pas '
    + 'de comportement correct à offrir, il en aurait un par tête',
  );
});

test('un groupe homogène passe, dans les deux natures', async () => {
  const vannes = vthermDriver(newApp([PIECE, VANNE, VANNE_2]));
  await assert.doesNotReject(() => build(vannes, { room: 'capteur' }, ['vanne', 'vanne-2']));

  const prises = vthermDriver(newApp([PIECE, PRISE, PRISE_2]));
  const created = await build(prises, { room: 'capteur' }, ['prise', 'prise-2']);
  assert.deepEqual(
    created.capabilities.filter((c) => c.startsWith('vtherm_valve') || c.endsWith('battery')),
    [],
    'deux prises restent deux interrupteurs : ni ouverture, ni pile',
  );
});

test('au-delà de la borne, le groupe est REFUSÉ et non tronqué en silence', async () => {
  const many = Array.from({ length: 9 }, (_, i) => summaryOf({
    id: `vanne-${i}`, name: `Vanne ${i}`, deviceClass: 'thermostat',
    capabilities: ['target_temperature'], setable: ['target_temperature'],
  }));
  const driver = vthermDriver(newApp([PIECE, ...many]));

  await assert.rejects(
    () => build(driver, { room: 'capteur' }, many.map((d) => d.id)),
    /pair\.error\.too_many_emitters/,
    'tronquer rendrait un groupe plus petit que celui qu\'on vient de choisir, sans un mot, '
    + 'pendant que l\'écran continue d\'afficher les têtes qui ne sont pas passées',
  );
});

test('un groupe vide reste un refus, comme l\'absence d\'émetteur avant lui', async () => {
  const driver = vthermDriver(newApp([PIECE, VANNE]));

  await assert.rejects(() => build(driver, { room: 'capteur' }, []), /pair\.error\.incomplete/);
});

test('le pairing accepte les deux formes : une tête seule, ou la liste', async () => {
  const app = newApp([PIECE, VANNE, VANNE_2]);
  const driver = vthermDriver(app) as unknown as Pairable;
  const session = new FakePairSession();
  await driver.onPair(session);

  await session.emit('select_room_sensor', 'capteur');
  await session.emit('select_emitter', 'vanne');
  const seule = await session.emit('build_device') as { store: Record<string, unknown> };
  assert.deepEqual(seule.store.emitterIds, ['vanne']);

  await session.emit('select_emitters', ['vanne', 'vanne-2']);
  const groupe = await session.emit('build_device') as { store: Record<string, unknown> };
  assert.deepEqual(
    groupe.store.emitterIds,
    ['vanne', 'vanne-2'],
    'une vue non rechargée émet encore `select_emitter` : elle doit continuer de marcher',
  );
});

test('un doublon envoyé par la vue ne devient pas deux têtes', async () => {
  const app = newApp([PIECE, VANNE, VANNE_2]);
  const driver = vthermDriver(app) as unknown as Pairable;
  const session = new FakePairSession();
  await driver.onPair(session);

  await session.emit('select_room_sensor', 'capteur');
  await session.emit('select_emitters', ['vanne', 'vanne', 'vanne-2']);
  const created = await session.emit('build_device') as { store: Record<string, unknown> };

  assert.deepEqual(created.store.emitterIds, ['vanne', 'vanne-2']);
});

// --- Appareil central : l'unicité --------------------------------------------------

test('le second appareil central est refusé dès le pairing', async () => {
  const app = newApp([]);
  const driver = withHomey(Object.create(CentralDriver.prototype) as object, app, {
    getDevices: () => [{ id: 'central-1' }],
  }) as unknown as Pairable;

  const session = new FakePairSession();
  await driver.onPair(session);

  await assert.rejects(
    () => session.emit('build_device'),
    /device\.central_duplicate/,
    'deux appareils qui se disputent le même relais sont la panne que le garde-fou existe pour empêcher',
  );
});

test('le premier appareil central est créé, avec le relais désigné', async () => {
  const relais = summaryOf({
    id: 'relais', name: 'Relais chaudière', deviceClass: 'socket', capabilities: ['onoff'], setable: ['onoff'],
  });
  const app = newApp([relais]);
  const driver = withHomey(Object.create(CentralDriver.prototype) as object, app, {
    getDevices: () => [],
  }) as unknown as Pairable;

  const session = new FakePairSession();
  await driver.onPair(session);

  const candidates = await session.emit('list_candidates', { capability: 'onoff' }) as Candidate[];
  assert.deepEqual(candidates.map((c) => c.id), ['relais']);

  await session.emit('select_boiler', 'relais');
  const created = await session.emit('build_device') as { store: Record<string, unknown> };

  assert.equal(created.store.boilerId, 'relais');
});
