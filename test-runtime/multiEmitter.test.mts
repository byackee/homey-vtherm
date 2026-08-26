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
  readonly mismatchedHeadIds: readonly string[] = [];

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
  // Chacune doit recevoir ce qui a été calculé POUR ELLE — décaler les indices enverrait à la n°3
  // l'ordre de la n°2, c'est-à-dire l'inverse exact du déphasage.
  const heads = [
    new FakeHead({ id: 'a', mode: 'switch' }),
    new FakeHead({ id: 'b', mode: 'switch' }),
    new FakeHead({ id: 'c', mode: 'switch' }),
  ];

  await group(heads).applySwitch([true, null, false], 1_000);

  assert.deepEqual(heads[0]!.calls, ['switch:true']);
  assert.deepEqual(heads[1]!.calls, [], 'entrée nulle : on ne touche pas à cette tête');
  assert.deepEqual(heads[2]!.calls, ['switch:false'], 'la n°3 reçoit bien l\'ordre de la n°3');
});

test('une bascule est tentée MÊME sur une tête au mode divergent', async () => {
  // RÉGRESSION. L'écarter ici créait un mensonge : le noyau enregistre qu'il a commandé cette tête
  // alors que rien n'était parti. À son retour, « rien n'est jamais parti » est devenu faux,
  // l'état commandé n'a pas basculé entre-temps, et une tête qui ne rapporte pas son état ne peut
  // pas être vue en divergence — elle n'est alors JAMAIS commandée. À puissance saturée l'état ne
  // bascule plus jamais : le relais reste éteint pour toujours pendant que la tuile affiche une
  // pièce en chauffe. C'est exactement la panne que la réaffirmation sur divergence empêche.
  const divergente = new FakeHead({ id: 'b', mode: 'valve' });
  const heads = [new FakeHead({ id: 'a', mode: 'switch' }), divergente];

  await group(heads).applySwitch([true, true], 1_000);

  assert.deepEqual(
    divergente.calls,
    ['switch:true'],
    'tenter ne coûte rien — une tête sans liaison d\'interrupteur rend la main sans appeler Homey',
  );
});

test('la consigne et la vanne, elles, restent filtrées par mode', async () => {
  // L'asymétrie est voulue : une bascule sur une tête sans interrupteur est un non-événement,
  // alors qu'une consigne ou une ouverture envoyée au mauvais mode écrit vraiment quelque chose.
  const divergente = new FakeHead({ id: 'b', mode: 'switch' });
  const g = group([new FakeHead({ id: 'a', mode: 'valve' }), divergente]);

  await g.applyValve(40, 1_000);
  await g.applySetpoint(20, 1_000);

  assert.deepEqual(divergente.calls, []);
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

// --- Ce qu'une relecture indépendante a trouvé ----------------------------------
//
// Quatre défauts, tous de la même famille : l'agrégation avait l'air juste, et mentait dans un cas
// que les tests d'origine ne visitaient pas. Ils sont ici pour que ce cas soit visité.

test('une lecture PÉRIMÉE ne rend pas le groupe « en chauffe et frais »', async () => {
  // La vanne b est tombée du réseau alors qu'elle chauffait : sa dernière lecture dit `true` pour
  // toujours. La vanne a, saine, dit `false`. L'agrégat naïf rendait { true, frais } — le noyau
  // l'acceptait, la demande restait active, et la chaudière chauffait une pièce qui ne chauffe pas.
  const g = group([
    new FakeHead({ id: 'a', heating: fresh(false, 1_000) }),
    new FakeHead({ id: 'b', heating: stale(true, 100) }),
  ]);

  assert.deepEqual(
    g.readHeating(2_000),
    { value: false, atMs: 1_000, stale: false },
    'tant qu\'une lecture fraîche existe, elle seule décide',
  );
});

test('quand toutes les têtes se taisent, le groupe le DIT au lieu de trancher', async () => {
  const g = group([
    new FakeHead({ id: 'a', heating: stale(false, 100) }),
    new FakeHead({ id: 'b', heating: stale(true, 200) }),
  ]);

  const reading = g.readHeating(9_000);
  assert.equal(reading?.stale, true, 'c\'est au noyau de décider quoi faire d\'une ignorance');
  assert.equal(reading?.value, true);
});

test('la pire pile est la pire des CRÉDIBLES, pas la pire tout court', async () => {
  // Une pile qui s'épuise finit par ne plus rien émettre : c'est justement la plus faible qui
  // devient muette. La retenir périmée supprimait la tuile de tout le groupe, alors que les autres
  // têtes rapportaient parfaitement — la panne même que cette version corrigeait par ailleurs.
  const g = group([
    new FakeHead({ id: 'a', battery: { value: 60, atMs: 1_000, stale: false } }),
    new FakeHead({ id: 'b', battery: { value: 5, atMs: 10, stale: true } }),
  ]);

  assert.deepEqual(g.readBattery(2_000), { value: 60, atMs: 1_000, stale: false });
});

test('une tête de RÉFÉRENCE qui dérive ne gèle pas les têtes saines', async () => {
  // Le cas symétrique était traité, celui-ci ne l'était pas : suivre la tête n°1 donnait à un seul
  // appareil le pouvoir d'écarter tous les autres. Deux vannes saines seraient restées figées.
  const heads = [
    new FakeHead({ id: 'a', mode: 'switch' }),
    new FakeHead({ id: 'b', mode: 'setpoint' }),
    new FakeHead({ id: 'c', mode: 'setpoint' }),
  ];
  const g = group(heads);

  assert.equal(g.mode, 'setpoint', 'la majorité décide');
  assert.deepEqual(g.mismatchedHeadIds, ['a']);

  await g.applySetpoint(20, 1_000);
  assert.deepEqual(heads[1]!.calls, ['setpoint:20']);
  assert.deepEqual(heads[2]!.calls, ['setpoint:20']);
});

test('à égalité, la consigne l\'emporte sur le tout-ou-rien', async () => {
  // Une vanne ré-annoncée sans sa consigne est une panne observée et transitoire ; un relais qui
  // gagnerait une consigne n'existe pas. L'asymétrie penche donc du côté qui se répare tout seul.
  const g = group([
    new FakeHead({ id: 'a', mode: 'switch' }),
    new FakeHead({ id: 'b', mode: 'setpoint' }),
  ]);

  assert.equal(g.mode, 'setpoint');
  assert.deepEqual(g.mismatchedHeadIds, ['a']);
});

test('la libération de vanne couvre les têtes écartées, et le dit quand l\'une résiste', async () => {
  // Double peine du filtre : la tête divergente n'était pas libérée, ET son absence du décompte
  // faisait rendre « tout va bien » — donc aucun avertissement « vanne figée ».
  const divergente = new FakeHead({ id: 'b', mode: 'switch', released: false });
  const heads = [new FakeHead({ id: 'a', mode: 'valve' }), divergente];

  const released = await group(heads).releaseValve(1_000);

  assert.ok(divergente.calls.includes('release'), 'elle est justement celle qu\'on laisserait ouverte');
  assert.equal(released, false, 'sinon l\'avertissement « vanne figée » ne part jamais');
});

test('un émetteur seul n\'a aucune tête écartée à signaler', () => {
  assert.deepEqual(new FakeHead({ id: 'a' }).mismatchedHeadIds, []);
});
