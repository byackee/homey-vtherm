/**
 * Le groupe d'émetteurs, côté pur : ce qu'on lit d'un `store` et ce qu'on y écrit.
 *
 * Deux choses se jouent ici, et une seule est visible.
 *
 * La première est la compatibilité descendante. Un thermostat créé avant les groupes n'a que
 * `emitterId` ; s'il rendait une liste vide, l'appareil deviendrait indisponible à la première mise
 * à jour — c'est-à-dire que la mise à jour éteindrait le chauffage de la maison. La seconde est la
 * compatibilité ASCENDANTE, moins évidente : `emitterId` continue d'être écrit pour qu'un
 * rétrogradage vers une version antérieure retrouve une tête et chauffe encore, en dégradé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMITTER_LIST_STORE_KEY, MAX_EMITTERS, SOURCE_STORE_KEYS,
  emitterExtraCapabilities, emitterStorePatch, hasBattery, hasWritableSetpoint, isHomogeneous,
  type EmitterProbe,
} from '../lib/sources.mjs';
import { readEmitterIds } from '../lib/sources.mjs';

const PRIMARY = SOURCE_STORE_KEYS.emitter;

// --- Lecture -----------------------------------------------------------------

test('un `store` d\'avant les groupes rend exactement sa tête', () => {
  assert.deepEqual(readEmitterIds({ [PRIMARY]: 'vanne-1' }), ['vanne-1']);
});

test('un `store` vide ne rend aucune tête, et surtout pas une tête vide', () => {
  assert.deepEqual(readEmitterIds({}), []);
  assert.deepEqual(
    readEmitterIds({ [PRIMARY]: '' }),
    [],
    'une chaîne vide lierait un adaptateur à un appareil qui n\'existe pas, sans le dire',
  );
});

test('la liste l\'emporte sur la tête seule, et garde son ordre', () => {
  const ids = readEmitterIds({
    [PRIMARY]: 'vanne-1',
    [EMITTER_LIST_STORE_KEY]: ['vanne-1', 'vanne-2', 'vanne-3'],
  });

  assert.deepEqual(ids, ['vanne-1', 'vanne-2', 'vanne-3']);
});

test('une liste illisible retombe sur la tête seule plutôt que sur rien', () => {
  for (const raw of [null, 'vanne-2', 42, {}, []]) {
    assert.deepEqual(
      readEmitterIds({ [PRIMARY]: 'vanne-1', [EMITTER_LIST_STORE_KEY]: raw }),
      ['vanne-1'],
      `entrée ${JSON.stringify(raw)} : le repli doit chauffer, pas se taire`,
    );
  }
});

test('les entrées non exploitables sont écartées, les valides gardées', () => {
  const ids = readEmitterIds({
    [EMITTER_LIST_STORE_KEY]: ['vanne-1', '', null, 7, 'vanne-2', undefined],
  });

  assert.deepEqual(ids, ['vanne-1', 'vanne-2']);
});

test('un doublon ne fait pas deux têtes : ce serait deux écritures par pas sur la même vanne', () => {
  const ids = readEmitterIds({
    [EMITTER_LIST_STORE_KEY]: ['vanne-1', 'vanne-2', 'vanne-1'],
  });

  assert.deepEqual(ids, ['vanne-1', 'vanne-2']);
});

test('la liste est bornée : le quota d\'écriture de l\'API Athom est réel', () => {
  const many = Array.from({ length: MAX_EMITTERS + 4 }, (_, i) => `vanne-${i}`);

  assert.equal(readEmitterIds({ [EMITTER_LIST_STORE_KEY]: many }).length, MAX_EMITTERS);
});

// --- Écriture ----------------------------------------------------------------

test('`emitterId` est TOUJOURS la tête n°1 de la liste', () => {
  const patch = emitterStorePatch(['vanne-1', 'vanne-2']);

  assert.equal(
    patch[PRIMARY],
    'vanne-1',
    'sans ça, une version antérieure de l\'app piloterait une autre vanne que celle-ci',
  );
  assert.deepEqual(patch[EMITTER_LIST_STORE_KEY], ['vanne-1', 'vanne-2']);
});

test('les deux champs se vident ensemble, jamais l\'un sans l\'autre', () => {
  assert.deepEqual(emitterStorePatch([]), { [PRIMARY]: null, [EMITTER_LIST_STORE_KEY]: null });
});

test('ce qui est écrit se relit à l\'identique', () => {
  const ids = ['vanne-1', 'vanne-2', 'vanne-3'];

  assert.deepEqual(readEmitterIds(emitterStorePatch(ids)), ids);
});

test('le patch nettoie ce qu\'on lui donne au lieu de le stocker tel quel', () => {
  const patch = emitterStorePatch(['vanne-1', 'vanne-1', '', 'vanne-2']);

  assert.equal(patch[PRIMARY], 'vanne-1');
  assert.deepEqual(patch[EMITTER_LIST_STORE_KEY], ['vanne-1', 'vanne-2']);
});

// --- Tuiles dérivées du groupe -----------------------------------------------

const VANNE: EmitterProbe = {
  capabilities: ['target_temperature', 'measure_battery', 'measure_temperature'],
  setable: { target_temperature: true },
};

const PRISE: EmitterProbe = {
  capabilities: ['onoff'],
  setable: { onoff: true },
};

/** Une vanne dont la consigne est en LECTURE seule : elle porte l'identifiant, sans le pouvoir. */
const VANNE_FIGEE: EmitterProbe = {
  capabilities: ['target_temperature'],
  setable: { target_temperature: false },
};

test('une consigne en lecture seule n\'est pas une consigne', () => {
  assert.equal(hasWritableSetpoint(VANNE), true);
  assert.equal(hasWritableSetpoint(VANNE_FIGEE), false);
  assert.equal(hasWritableSetpoint(PRISE), false);
});

test('la sous-capability compte autant que l\'identifiant nu', () => {
  assert.equal(
    hasWritableSetpoint({
      capabilities: ['target_temperature.local'],
      setable: { 'target_temperature.local': true },
    }),
    true,
  );
  assert.equal(hasBattery({ capabilities: ['measure_battery.valve'], setable: {} }), true);
});

test('une seule tête à pile suffit à rendre la tuile utile', () => {
  assert.deepEqual(
    emitterExtraCapabilities([PRISE, VANNE]).sort(),
    ['vtherm_emitter_battery', 'vtherm_valve_open'],
  );
});

test('un groupe de prises n\'a ni pile ni ouverture', () => {
  assert.deepEqual(emitterExtraCapabilities([PRISE, PRISE]), []);
});

test('le hub muet compte comme une tête à consigne SANS pile', () => {
  assert.deepEqual(
    emitterExtraCapabilities([null]),
    ['vtherm_valve_open'],
    'supposer une pile afficherait une tuile vide sur un radiateur branché au secteur ; '
    + 'supposer l\'absence de consigne priverait d\'ouverture une vanne pilotable',
  );
});

// --- Homogénéité du groupe ----------------------------------------------------
//
// PANNE EMPÊCHÉE : un groupe de deux vannes dont on change l'émetteur pour une prise commutée.
// Le groupe bascule tout entier en tout-ou-rien ; la seconde vanne, restée en mode consigne, est
// écartée des écritures et reste figée sur sa dernière ouverture — sans un mot. Trois chemins y
// mènent (création, réparation, page de réglages de l'app), d'où une règle unique, ici.

test('deux vannes vont ensemble, deux prises aussi', () => {
  assert.equal(isHomogeneous([VANNE, VANNE]), true);
  assert.equal(isHomogeneous([PRISE, PRISE]), true);
});

test('une vanne et une prise ne se pilotent PAS de la même façon', () => {
  assert.equal(
    isHomogeneous([VANNE, PRISE]),
    false,
    '`lib/step.mts` choisit une branche entière sur `emitterMode` : un groupe mixte en aurait '
    + 'une par tête, et le noyau n\'en connaît qu\'une',
  );
});

test('une consigne en lecture seule range l\'appareil avec les interrupteurs', () => {
  // C'est le même prédicat que la détection de mode : porter l'identifiant ne suffit pas, il faut
  // pouvoir écrire dedans. Une vanne figée est un interrupteur du point de vue du pilotage.
  assert.equal(isHomogeneous([VANNE_FIGEE, PRISE]), true);
  assert.equal(isHomogeneous([VANNE_FIGEE, VANNE]), false);
});

test('une tête seule est toujours homogène avec elle-même', () => {
  assert.equal(isHomogeneous([VANNE]), true);
  assert.equal(isHomogeneous([]), true);
});

test('le hub muet ne bloque rien : il est compatible avec tout', () => {
  assert.equal(
    isHomogeneous([null, VANNE]),
    true,
    'refuser sur une ignorance rendrait le groupe immodifiable pendant la minute qui suit le '
    + 'démarrage de l\'app, alors que l\'appareil visé est peut-être parfaitement conforme',
  );
  assert.equal(isHomogeneous([null, null]), true);
  assert.equal(isHomogeneous([null, VANNE, PRISE]), false, 'ce qu\'on SAIT continue de trancher');
});
