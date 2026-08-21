import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOnPercent } from '../lib/tpi.mjs';
import type { TpiInput, TpiParams } from '../lib/types.mjs';

const noThresholds: Pick<TpiParams, 'thresholdHigh' | 'thresholdLow'> = { thresholdHigh: 0, thresholdLow: 0 };

/** Seuils actifs, volontairement dissymétriques pour distinguer lequel arbitre. */
const THRESHOLDS: TpiParams = {
  coefInt: 0.1, coefExt: 1, thresholdHigh: 2, thresholdLow: 1,
};

// --- Formule nominale --------------------------------------------------------

test('formule nominale sans bornage', () => {
  const params: TpiParams = { coefInt: 0.3, coefExt: 0.02, ...noThresholds };
  const input: TpiInput = {
    setpoint: 20, roomTemp: 19, outdoorTemp: 10, slopePerHour: null,
  };
  // 0.3 * (20-19) + 0.02 * (20-10) = 0.3 + 0.2 = 0.5
  assert.equal(computeOnPercent(input, params).onPercent, 0.5);
});

test('bornage haut à 1', () => {
  const params: TpiParams = { coefInt: 0.6, coefExt: 0.01, ...noThresholds };
  const input: TpiInput = {
    setpoint: 20, roomTemp: 10, outdoorTemp: 5, slopePerHour: 0,
  };
  // 0.6*10 + 0.01*15 = 6.15 -> clamp 1
  assert.equal(computeOnPercent(input, params).onPercent, 1);
});

test('bornage bas à 0', () => {
  const params: TpiParams = { coefInt: 0.6, coefExt: 0, ...noThresholds };
  const input: TpiInput = {
    setpoint: 15, roomTemp: 25, outdoorTemp: null, slopePerHour: 0,
  };
  assert.equal(computeOnPercent(input, params).onPercent, 0);
});

test('outdoorTemp null : terme externe nul', () => {
  const params: TpiParams = { coefInt: 0.5, coefExt: 0.5, ...noThresholds };
  const input: TpiInput = {
    setpoint: 20, roomTemp: 19, outdoorTemp: null, slopePerHour: null,
  };
  assert.equal(computeOnPercent(input, params).onPercent, 0.5);
});

// --- Seuils de dépassement (SPEC §4) -----------------------------------------
// Ce ne sont PAS des seuils d'hystérésis : ils portent tous les deux sur la même grandeur
// (roomTemp - setpoint) et c'est le signe de la pente qui décide lequel s'applique.

test('pente montante : coupe au-delà du seuil haut', () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 23, outdoorTemp: -50, slopePerHour: 0.5,
  }; // dépassement = 3 > 2
  assert.equal(computeOnPercent(input, THRESHOLDS).onPercent, 0);
});

test('pente montante : ne coupe pas en dessous du seuil haut', () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 21.5, outdoorTemp: -50, slopePerHour: 0.5,
  }; // dépassement = 1.5 < 2
  assert.equal(computeOnPercent(input, THRESHOLDS).onPercent, 1);
});

test('pente descendante : coupe au-delà du seuil bas', () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 21.5, outdoorTemp: -50, slopePerHour: -0.5,
  }; // dépassement = 1.5 > 1
  assert.equal(computeOnPercent(input, THRESHOLDS).onPercent, 0);
});

test('même dépassement, décision opposée selon le signe de la pente', () => {
  const base = { setpoint: 20, roomTemp: 21.5, outdoorTemp: -50 };
  // Le cœur de la règle VT : à dépassement identique (1,5 °C), on chauffe encore si ça monte
  // (tolérance thresholdHigh = 2) et on coupe si ça descend (tolérance thresholdLow = 1).
  assert.equal(computeOnPercent({ ...base, slopePerHour: 1 }, THRESHOLDS).onPercent, 1);
  assert.equal(computeOnPercent({ ...base, slopePerHour: -1 }, THRESHOLDS).onPercent, 0);
});

test('pas de dépassement : les seuils ne coupent jamais, quelle que soit la pente', () => {
  for (const slopePerHour of [-5, -0.01, 0, 0.01, 5]) {
    const input: TpiInput = {
      setpoint: 20, roomTemp: 19, outdoorTemp: -50, slopePerHour,
    }; // dépassement = -1
    assert.equal(computeOnPercent(input, THRESHOLDS).onPercent, 1, `pente ${slopePerHour}`);
  }
});

test('pente nulle : aucun effet, même très au-dessus des deux seuils', () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 30, outdoorTemp: -50, slopePerHour: 0,
  };
  assert.equal(computeOnPercent(input, THRESHOLDS).onPercent, 1);
});

test('pente inconnue : aucun effet', () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 30, outdoorTemp: -50, slopePerHour: null,
  };
  assert.equal(computeOnPercent(input, THRESHOLDS).onPercent, 1);
});

test('les deux seuils vont par paire : un seul renseigné désactive la fonction', () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 23, outdoorTemp: -50, slopePerHour: 1,
  };
  assert.equal(computeOnPercent(input, { ...THRESHOLDS, thresholdLow: 0 }).onPercent, 1);
  assert.equal(computeOnPercent(input, { ...THRESHOLDS, thresholdHigh: 0 }).onPercent, 1);
});

test('aucune mémoire entre deux appels : le calcul est sans état', () => {
  // Une hystérésis à verrou resterait coupée au deuxième appel ; VT recalcule tout à chaque pas.
  const chaud: TpiInput = {
    setpoint: 20, roomTemp: 23, outdoorTemp: -50, slopePerHour: 1,
  };
  const froid: TpiInput = {
    setpoint: 20, roomTemp: 21.5, outdoorTemp: -50, slopePerHour: 1,
  };
  assert.equal(computeOnPercent(chaud, THRESHOLDS).onPercent, 0);
  assert.equal(computeOnPercent(froid, THRESHOLDS).onPercent, 1);
  assert.equal(computeOnPercent(chaud, THRESHOLDS).onPercent, 0);
});

test("l'entrée n'est pas mutée", () => {
  const input: TpiInput = {
    setpoint: 20, roomTemp: 23, outdoorTemp: -50, slopePerHour: 1,
  };
  const inputCopy = { ...input };
  computeOnPercent(input, THRESHOLDS);
  assert.deepStrictEqual(input, inputCopy);
});
