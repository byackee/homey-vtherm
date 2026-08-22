import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlopeState, updateSlope } from '../lib/slope.mjs';
import { DEFAULT_SLOPE } from '../lib/constants.mjs';
import type { SlopeParams, SlopeState } from '../lib/types.mjs';

const PARAMS: SlopeParams = {
  alpha: 0.8, precision: 2, minSamples: 4, maxAbsSlopePerHour: 120, staleAfterSec: 30 * 60,
};

const QUARTER_HOUR_MS = 900_000;

/**
 * Série de référence : un point tous les quarts d'heure, température constante puis chute
 * régulière de 0,25 °C par pas (soit −1 °C/h de pente instantanée, exactement représentable).
 *
 *   p1 t=0        20      ancrage, aucune pente
 *   p2 t=15 min   20      instantanée 0     -> lissée 0
 *   p3 t=30 min   19,75   instantanée −1    -> 0,2×0 + 0,8×(−1) = −0,8
 *   p4 t=45 min   19,5    instantanée −1    -> 0,2×(−0,8) + 0,8×(−1) = −0,96
 */
const SERIES: ReadonlyArray<readonly [number, number]> = [
  [0, 20], [QUARTER_HOUR_MS, 20], [2 * QUARTER_HOUR_MS, 19.75], [3 * QUARTER_HOUR_MS, 19.5],
];

function feed(count: number): SlopeState {
  let state = createSlopeState();
  for (let i = 0; i < count; i += 1) {
    const point = SERIES[i];
    assert.ok(point !== undefined);
    ({ nextState: state } = updateSlope(state, point[1], point[0], PARAMS));
  }
  return state;
}

// --- Constantes ---------------------------------------------------------------

test('les défauts sont bien ceux de VT', () => {
  assert.deepStrictEqual(DEFAULT_SLOPE, {
    alpha: 0.8, precision: 2, minSamples: 4, maxAbsSlopePerHour: 120, staleAfterSec: 1800,
  });
});

// --- Garde n°1 : au moins 4 points --------------------------------------------

test('première mesure : pas de pente, série ancrée', () => {
  const result = updateSlope(createSlopeState(), 20, 0, PARAMS);
  assert.equal(result.slopePerHour, null);
  assert.deepStrictEqual(result.nextState, {
    slope: null, lastMs: 0, lastTemp: 20, sampleCount: 1,
  });
});

test('moins de 4 points : rien n\'est publié, même si la pente est déjà calculée', () => {
  let state = createSlopeState();
  for (let i = 0; i < 3; i += 1) {
    const point = SERIES[i];
    assert.ok(point !== undefined);
    const result = updateSlope(state, point[1], point[0], PARAMS);
    assert.equal(result.slopePerHour, null, `point ${i + 1}`);
    state = result.nextState;
  }
  // La pente existe en interne dès le deuxième point : c'est la publication qui attend.
  assert.equal(state.slope, -0.8);
  assert.equal(state.sampleCount, 3);
});

test('la pente est publiée au quatrième point', () => {
  const point = SERIES[3];
  assert.ok(point !== undefined);
  const result = updateSlope(feed(3), point[1], point[0], PARAMS);
  assert.equal(result.slopePerHour, -0.96);
  assert.equal(result.nextState.sampleCount, 4);
});

test('sampleCount est plafonné à minSamples', () => {
  let state = feed(4);
  for (let i = 1; i <= 5; i += 1) {
    ({ nextState: state } = updateSlope(state, 19.5, (3 + i) * QUARTER_HOUR_MS, PARAMS));
  }
  assert.equal(state.sampleCount, 4);
});

// --- Lissage 0,2 / 0,8 ---------------------------------------------------------

test('lissage : 0,2 × précédente + 0,8 × instantanée, arrondi à 2 décimales', () => {
  const result = updateSlope(feed(4), 19.25, 4 * QUARTER_HOUR_MS, PARAMS);
  // instantanée = −1 ; 0,2 × (−0,96) + 0,8 × (−1) = −0,992 -> arrondi −0,99
  assert.equal(result.slopePerHour, -0.99);
});

test('température constante : pente nulle', () => {
  let state = createSlopeState();
  let slope: number | null = null;
  for (let i = 0; i < 4; i += 1) {
    ({ slopePerHour: slope, nextState: state } = updateSlope(state, 20, i * QUARTER_HOUR_MS, PARAMS));
  }
  assert.equal(slope, 0);
});

test('arrondi à la précision demandée', () => {
  const params: SlopeParams = { ...PARAMS, precision: 1, minSamples: 2 };
  let state = createSlopeState();
  ({ nextState: state } = updateSlope(state, 20, 0, params));
  // (19.9 − 20) / 0,25 h = −0,4 °C/h ; première pente, pas de lissage -> arrondi −0,4
  const result = updateSlope(state, 19.9, QUARTER_HOUR_MS, params);
  assert.equal(result.slopePerHour, -0.4);
});

// --- Garde n°2 : pente aberrante ------------------------------------------------

test('pente de plus de 120 °C/h : point ignoré, état strictement inchangé', () => {
  const state = feed(4);
  // +5 °C en une minute = +300 °C/h : un capteur qui ment, pas une pièce qui chauffe.
  const result = updateSlope(state, 24.5, 3 * QUARTER_HOUR_MS + 60_000, PARAMS);
  assert.equal(result.slopePerHour, -0.96); // la pente publiée ne bouge pas
  assert.deepStrictEqual(result.nextState, state); // ni l'ancre, ni le compteur
});

test("le point aberrant n'empoisonne pas la mesure suivante", () => {
  const state = feed(4);
  const poisoned = updateSlope(state, 24.5, 3 * QUARTER_HOUR_MS + 60_000, PARAMS).nextState;
  // Mesure légitime suivante : elle repart de l'ancre d'avant l'aberration (19,5 à t=45 min).
  const result = updateSlope(poisoned, 19.25, 4 * QUARTER_HOUR_MS, PARAMS);
  assert.equal(result.slopePerHour, -0.99);
});

test('juste sous le seuil : le point est accepté', () => {
  const state = feed(4);
  // −1 °C en une minute = −60 °C/h, sous les 120 : accepté malgré la brutalité.
  const result = updateSlope(state, 18.5, 3 * QUARTER_HOUR_MS + 60_000, PARAMS);
  assert.notDeepStrictEqual(result.nextState, state);
  assert.equal(result.nextState.lastTemp, 18.5);
});

// --- Garde n°3 : trou de mesure --------------------------------------------------

test('trou de plus de 30 minutes : point fictif au lieu d\'une dérivée sur le trou', () => {
  const state = feed(4); // pente −0,96, dernière mesure 19,5 à t=45 min
  const result = updateSlope(state, 10, 3 * QUARTER_HOUR_MS + 31 * 60_000, PARAMS);
  // La dérivée brute vaudrait (10 − 19,5) / 0,5167 h ≈ −18,4 °C/h : une pente délirante bâtie
  // sur une demi-heure de silence. Le point fictif rend une instantanée nulle.
  // 0,2 × (−0,96) + 0,8 × 0 = −0,192 -> −0,19
  assert.equal(result.slopePerHour, -0.19);
  // La mesure réelle sert malgré tout d'ancre au pas suivant.
  assert.equal(result.nextState.lastTemp, 10);
});

test('trou juste en dessous de 30 minutes : dérivée normale', () => {
  const state = feed(4);
  // −0,5 °C en 29 min = −1,0345 °C/h ; 0,2 × (−0,96) + 0,8 × (−1,0345) = −1,0196 -> −1,02
  const result = updateSlope(state, 19, 3 * QUARTER_HOUR_MS + 29 * 60_000, PARAMS);
  assert.equal(result.slopePerHour, -1.02);
});

// --- Robustesse ------------------------------------------------------------------

test('dtSec <= 0 : aucune pente inventée, mais la référence est REPRISE', () => {
  // La pente publiée ne bouge pas, et la confiance accumulée non plus.
  const state = feed(4);
  const result = updateSlope(state, 25, 3 * QUARTER_HOUR_MS, PARAMS);
  assert.equal(result.slopePerHour, -0.96);
  assert.equal(result.nextState.slope, state.slope);
  assert.equal(result.nextState.sampleCount, state.sampleCount);

  // Mais `lastMs` suit la lecture courante. Sans ça, un horodatage venu du capteur et posé dans
  // le futur gelait la pente pour la durée de vie du processus : toute lecture correctement datée
  // ensuite retombait dans cette même branche, indéfiniment.
  assert.equal(result.nextState.lastMs, 3 * QUARTER_HOUR_MS);
  assert.equal(result.nextState.lastTemp, 25);
});

test('un horodatage venu du futur ne gèle pas la pente : le pas suivant repart', () => {
  const state = feed(4);
  const future = 4 * QUARTER_HOUR_MS + 24 * 3_600_000; // la passerelle a hoqueté d'un jour
  const poisoned = updateSlope(state, 19.25, future, PARAMS);
  assert.equal(poisoned.nextState.lastMs, future, 'la lecture datée du futur est prise telle quelle');

  // Lecture suivante, correctement datée : elle répare la référence…
  const repaired = updateSlope(poisoned.nextState, 19.5, 5 * QUARTER_HOUR_MS, PARAMS);
  assert.equal(repaired.nextState.lastMs, 5 * QUARTER_HOUR_MS);

  // …et celle d'après produit à nouveau une vraie dérivée.
  const alive = updateSlope(repaired.nextState, 20, 6 * QUARTER_HOUR_MS, PARAMS);
  assert.notEqual(alive.nextState.lastMs, future);
  assert.ok(alive.slopePerHour !== null && alive.slopePerHour > 0, 'la pente est repartie');
});

test('état non muté : l\'état passé en entrée n\'est jamais modifié', () => {
  const state = Object.freeze(feed(4));
  assert.doesNotThrow(() => {
    updateSlope(state, 19.25, 4 * QUARTER_HOUR_MS, PARAMS);
  });
});
