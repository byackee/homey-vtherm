/**
 * `MultiEmitterAdapter` — plusieurs têtes derrière un seul thermostat.
 *
 * Ce que ces tests protègent tient en une phrase : une pièce à trois radiateurs ne doit jamais être
 * chauffée à un tiers de sa puissance sans que rien ne le dise. Trois façons d'y arriver, et une
 * seule est évidente.
 *
 * La première est le `Promise.all` nu, qui abandonne les têtes restantes au premier rejet. La
 * deuxième est la tête dont le mode a dérivé : elle échoue à chaque écriture, son doute rend la
 * demande `unknown`, et la chaudière reste éteinte pour toute la pièce à cause d'un seul appareil.
 * La troisième est la sortie propre, où une tête écartée est justement celle qu'on laisserait
 * ouverte pour toujours si on ne la remettait pas en état.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Reading, SyncMode } from '../lib/types.mjs';
import type { ValveBackend } from '../runtime/valveBackend.mjs';
import type {
  EmitterAdapter, EmitterCapabilities, EmitterWriteMode,
} from '../runtime/emitter.mjs';
import { MultiEmitterAdapter } from '../runtime/multiEmitter.mjs';

const NO_CAPS: EmitterCapabilities = {
  setpoint: false, valve: false, externalTemp: false, calibration: false,
  heatingState: false, switch: false,
};

interface FakeOptions {
  id: string;
  mode?: EmitterWriteMode;
  heating?: Reading<boolean> | null;
  battery?: Reading<number> | null;
  /** Le canal sur lequel cette tête refuse d'écrire, pour éprouver la diffusion. */
  failOn?: 'setpoint' | 'valve' | 'switch' | 'roomTemp' | 'detect' | 'restore' | null;
  released?: boolean;
}

/** Une tête réduite à ce que le groupe lui demande : mémoriser ce qu'elle a reçu, ou refuser. */
class FakeHead implements EmitterAdapter {
  readonly deviceId: string;
  readonly caps = NO_CAPS;
  mode: EmitterWriteMode;

  readonly calls: string[] = [];
  valveUnconfirmed = false;
  switchUnconfirmed = false;
  available = true;
  destroyed = false;
  backendSet = 0;
  invalidated = 0;
  detections = 0;

  readonly heating: Reading<boolean> | null;
  private readonly battery: Reading<number> | null;
  private readonly failOn: FakeOptions['failOn'];
  private readonly released: boolean;

  constructor(options: FakeOptions) {
    this.deviceId = options.id;
    this.mode = options.mode ?? 'setpoint';
    this.heating = options.heating ?? null;
    this.battery = options.battery ?? null;
    this.failOn = options.failOn ?? null;
    this.released = options.released ?? true;
  }

  private async record(channel: NonNullable<FakeOptions['failOn']>, detail: string): Promise<void> {
    this.calls.push(detail);
    if (this.failOn === channel) throw new Error(`${this.deviceId} refuse ${channel}`);
  }

  async applySetpoint(v: number): Promise<void> { await this.record('setpoint', `setpoint:${v}`); }
  async applyValve(p: number): Promise<void> { await this.record('valve', `valve:${p}`); }
  readonly headCount = 1;

  readHeatingHeads(): readonly (Reading<boolean> | null)[] { return [this.heating]; }

  async applySwitch(states: readonly (boolean | null)[]): Promise<void> {
    await this.record('switch', `switch:${states[0] ?? null}`);
  }

  async pushRoomTemperature(t: number, mode: SyncMode): Promise<void> {
    await this.record('roomTemp', `room:${t}:${mode}`);
  }

  readHeating(): Reading<boolean> | null { return this.heating; }
  readBattery(): Reading<number> | null { return this.battery; }

  async releaseValve(): Promise<boolean> {
    this.calls.push('release');
    return this.released;
  }

  async restoreSafeState(setpoint: number): Promise<void> {
    await this.record('restore', `restore:${setpoint}`);
  }

  async detect(): Promise<void> {
    this.detections += 1;
    await this.record('detect', 'detect');
  }

  invalidateDetection(): void { this.invalidated += 1; }
  detectionDue(): boolean { return false; }
  setBackend(_backend: ValveBackend | null): void { this.backendSet += 1; }
  destroy(): void { this.destroyed = true; }
}

function group(heads: FakeHead[]): MultiEmitterAdapter {
  return new MultiEmitterAdapter({ heads });
}

const fresh = (value: boolean, atMs: number): Reading<boolean> => ({ value, atMs, stale: false });
const stale = (value: boolean, atMs: number): Reading<boolean> => ({ value, atMs, stale: true });

// --- Diffusion des écritures --------------------------------------------------

test('une tête qui refuse n\'empêche pas les autres de recevoir la commande', async () => {
  const heads = [
    new FakeHead({ id: 'a', failOn: 'valve' }),
    new FakeHead({ id: 'b' }),
    new FakeHead({ id: 'c' }),
  ];

  await assert.rejects(
    () => group(heads).applyValve(60, 1_000),
    /a refuse valve/,
    'l\'erreur doit remonter : `participants.mts` est ce qui la journalise',
  );

  assert.deepEqual(heads[1]!.calls, ['valve:60'], 'la tête suivante a bien été commandée');
  assert.deepEqual(
    heads[2]!.calls,
    ['valve:60'],
    'un `Promise.all` nu se serait arrêté à la première : deux radiateurs sur trois seraient '
    + 'restés à leur ouverture précédente, sans rien pour le signaler',
  );
});

test('chaque tête reçoit SON état, et l\'indexation reste alignée sur la liste complète', async () => {
  // La tête du milieu diverge : elle ne reçoit rien. Les deux autres doivent recevoir ce qui a été
  // calculé POUR ELLES — décaler les indices ici enverrait à la n°3 l'ordre de la n°2, c'est-à-dire
  // l'inverse exact du déphasage.
  const heads = [
    new FakeHead({ id: 'a', mode: 'switch' }),
    new FakeHead({ id: 'b', mode: 'valve' }),
    new FakeHead({ id: 'c', mode: 'switch' }),
  ];

  await group(heads).applySwitch([true, true, false], 1_000);

  assert.deepEqual(heads[0]!.calls, ['switch:true']);
  assert.deepEqual(heads[1]!.calls, [], 'tête écartée : elle ne reçoit rien');
  assert.deepEqual(heads[2]!.calls, ['switch:false'], 'la n°3 reçoit bien l\'ordre de la n°3');
});

test('une entrée nulle ne touche pas à sa tête : les têtes ne basculent pas au même pas', async () => {
  const heads = [new FakeHead({ id: 'a' }), new FakeHead({ id: 'b' })];

  await group(heads).applySwitch([null, true], 1_000);

  assert.deepEqual(heads[0]!.calls, [], 'réécrire un relais déjà dans le bon état l\'use pour rien');
  assert.deepEqual(heads[1]!.calls, ['switch:true']);
});

test('l\'état par tête n\'est rapporté que pour les têtes qui participent', () => {
  const g = group([
    new FakeHead({ id: 'a', mode: 'valve', heating: fresh(true, 900) }),
    new FakeHead({ id: 'b', mode: 'switch', heating: fresh(true, 900) }),
  ]);

  assert.deepEqual(
    g.readHeatingHeads(1_000),
    [{ value: true, atMs: 900, stale: false }, null],
    'détecter une divergence sur une tête à laquelle on n\'envoie plus rien la rendrait perpétuelle',
  );
  assert.equal(g.headCount, 2, 'le noyau indexe sur la liste complète, écartées comprises');
});

test('toutes les têtes reçoivent la même consigne, la même bascule, la même température', async () => {
  const heads = [new FakeHead({ id: 'a' }), new FakeHead({ id: 'b' })];
  const g = group(heads);

  await g.applySetpoint(20.5, 1_000);
  await g.applySwitch([true, true], 1_000);
  await g.pushRoomTemperature(19.25, 'external', 1_000);

  for (const head of heads) {
    assert.deepEqual(head.calls, ['setpoint:20.5', 'switch:true', 'room:19.25:external']);
  }
});

// --- Lectures agrégées --------------------------------------------------------

test('une seule tête qui chauffe suffit à dire que la pièce chauffe', () => {
  const g = group([
    new FakeHead({ id: 'a', heating: fresh(false, 1_000) }),
    new FakeHead({ id: 'b', heating: fresh(true, 900) }),
  ]);

  assert.deepEqual(g.readHeating(2_000), { value: true, atMs: 1_000, stale: false });
});

test('la lecture n\'est périmée que si TOUTES le sont', () => {
  const partiel = group([
    new FakeHead({ id: 'a', heating: stale(false, 100) }),
    new FakeHead({ id: 'b', heating: fresh(false, 900) }),
  ]);
  assert.equal(
    partiel.readHeating(2_000)?.stale,
    false,
    'une information de première main ne devient pas douteuse parce qu\'une autre tête se tait',
  );

  const total = group([
    new FakeHead({ id: 'a', heating: stale(true, 100) }),
    new FakeHead({ id: 'b', heating: stale(false, 200) }),
  ]);
  assert.equal(total.readHeating(2_000)?.stale, true);
});

test('aucune tête ne rapporte son état : le groupe ne l\'invente pas', () => {
  assert.equal(group([new FakeHead({ id: 'a' }), new FakeHead({ id: 'b' })]).readHeating(1_000), null);
});

test('la pile affichée est la PIRE du groupe', () => {
  const g = group([
    new FakeHead({ id: 'a', battery: { value: 82, atMs: 1_000, stale: false } }),
    new FakeHead({ id: 'b', battery: { value: 11, atMs: 900, stale: false } }),
    new FakeHead({ id: 'c', battery: null }),
  ]);

  assert.deepEqual(
    g.readBattery(2_000),
    { value: 11, atMs: 900, stale: false },
    'une moyenne resterait rassurante jusqu\'au jour où la vanne à 11 % s\'arrête',
  );
});

// --- La tête dont le mode a dérivé --------------------------------------------

test('une tête d\'un autre mode est écartée des commandes, et nommée', async () => {
  const heads = [
    new FakeHead({ id: 'a', mode: 'valve' }),
    new FakeHead({ id: 'b', mode: 'switch' }),
  ];
  const g = group(heads);

  assert.equal(g.mode, 'valve', 'le mode du groupe est celui de la tête de référence');
  assert.deepEqual(g.mismatchedHeadIds, ['b']);

  await g.applyValve(40, 1_000);
  assert.deepEqual(heads[0]!.calls, ['valve:40']);
  assert.deepEqual(heads[1]!.calls, [], 'lui envoyer une ouverture échouerait à chaque pas');
});

test('le doute d\'une tête écartée ne condamne pas la pièce', () => {
  const divergente = new FakeHead({ id: 'b', mode: 'switch' });
  divergente.switchUnconfirmed = true;
  divergente.valveUnconfirmed = true;

  const g = group([new FakeHead({ id: 'a', mode: 'valve' }), divergente]);

  assert.equal(
    g.valveUnconfirmed,
    false,
    'sinon la demande resterait `unknown` pour toujours et la chaudière ne partirait jamais',
  );
});

test('le doute d\'une tête qui PARTICIPE, lui, est celui du groupe', () => {
  const head = new FakeHead({ id: 'b', mode: 'valve' });
  head.valveUnconfirmed = true;

  assert.equal(group([new FakeHead({ id: 'a', mode: 'valve' }), head]).valveUnconfirmed, true);
});

test('la détection touche AUSSI les têtes écartées : c\'est elle qui les fait revenir', async () => {
  const divergente = new FakeHead({ id: 'b', mode: 'switch' });
  const g = group([new FakeHead({ id: 'a', mode: 'valve' }), divergente]);

  await g.detect(1_000);
  assert.equal(divergente.detections, 1);

  // Elle revient : le groupe la reprend sans intervention.
  divergente.mode = 'valve';
  await g.detect(2_000);
  assert.deepEqual(g.mismatchedHeadIds, []);

  await g.applyValve(30, 3_000);
  assert.ok(divergente.calls.includes('valve:30'));
});

// --- Sortie propre ------------------------------------------------------------

test('la remise en état sûr couvre toutes les têtes, écartées comprises, et ne lève pas', async () => {
  const heads = [
    new FakeHead({ id: 'a', mode: 'valve', failOn: 'restore' }),
    new FakeHead({ id: 'b', mode: 'switch' }),
  ];

  await group(heads).restoreSafeState(19);

  assert.ok(heads[0]!.calls.includes('restore:19'));
  assert.ok(
    heads[1]!.calls.includes('restore:19'),
    'une tête écartée est justement celle qu\'on laisserait ouverte pour toujours',
  );
});

test('une seule vanne restée figée suffit à le dire', async () => {
  assert.equal(await group([
    new FakeHead({ id: 'a', released: true }),
    new FakeHead({ id: 'b', released: false }),
  ]).releaseValve(1_000), false);

  assert.equal(await group([
    new FakeHead({ id: 'a', released: true }),
    new FakeHead({ id: 'b', released: true }),
  ]).releaseValve(1_000), true);
});

test('destruction, dorsale et invalidation atteignent chaque tête', () => {
  const heads = [new FakeHead({ id: 'a', mode: 'valve' }), new FakeHead({ id: 'b', mode: 'switch' })];
  const g = group(heads);

  g.setBackend(null);
  g.invalidateDetection();
  g.destroy();

  for (const head of heads) {
    assert.equal(head.backendSet, 1);
    assert.equal(head.invalidated, 1);
    assert.equal(head.destroyed, true);
  }
});

// --- Garde-fou ----------------------------------------------------------------

test('un groupe vide est refusé plutôt que de rendre « je ne sais pas » sur tout', () => {
  assert.throws(() => new MultiEmitterAdapter({ heads: [] }), /au moins une tête/);
});

test('les identifiants gardent l\'ordre d\'appairage : la première est la tête de référence', () => {
  const g = group([new FakeHead({ id: 'a' }), new FakeHead({ id: 'b' })]);

  assert.deepEqual(g.headIds, ['a', 'b']);
  assert.equal(g.deviceId, 'a');
});
