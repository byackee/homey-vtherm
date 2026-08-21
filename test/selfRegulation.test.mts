import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegulationState, resolveRegulationParams, computeOffset } from '../lib/selfRegulation.mjs';
import { REGULATION_PRESETS } from '../lib/constants.mjs';
import type { RegulationInput, RegulationMode, RegulationParams, RegulationState } from '../lib/types.mjs';

const expertPreset: RegulationParams = REGULATION_PRESETS.medium; // valeur bidon, non utilisée par les modes préréglés

/** Un pas de durée exactement un cycle, cas nominal. */
function input(overrides: Partial<RegulationInput>): RegulationInput {
  return {
    setpoint: 20, roomTemp: 20, outdoorTemp: 0, dtCycles: 1, ...overrides,
  };
}

test('createRegulationState renvoie un état vierge', () => {
  assert.deepStrictEqual(createRegulationState(), { accumulatedError: 0, lastErrorSign: 0 });
});

for (const mode of ['none', 'slow', 'light', 'medium', 'strong'] as const) {
  test(`resolveRegulationParams renvoie les constantes exactes du mode ${mode}`, () => {
    assert.deepStrictEqual(resolveRegulationParams(mode, expertPreset), REGULATION_PRESETS[mode]);
  });
}

test("resolveRegulationParams renvoie l'objet expert fourni tel quel", () => {
  const expert: RegulationParams = {
    kp: 0.9, ki: 0.03, kExt: 0.02, offsetMax: 4, accumulatedErrorThreshold: 12, overheatProtection: true,
  };
  assert.strictEqual(resolveRegulationParams('expert', expert), expert);
});

test('les quatre modes actifs activent la protection surchauffe', () => {
  // Garde explicite : `const.py:575` de VT donne `overheat_protection = True` jusque pour `slow`.
  // Une première rédaction mettait `false` sur `slow` ; ce test est là pour que la régression
  // se voie immédiatement.
  for (const mode of ['slow', 'light', 'medium', 'strong'] as const) {
    assert.equal(REGULATION_PRESETS[mode].overheatProtection, true, mode);
  }
});

// --- Formule ----------------------------------------------------------------

test('formule nominale sans bornage', () => {
  const params: RegulationParams = {
    kp: 0.5, ki: 0.5, kExt: 0.5, offsetMax: 100, accumulatedErrorThreshold: 100, overheatProtection: false,
  };
  const result = computeOffset(input({ setpoint: 20, roomTemp: 19, outdoorTemp: 11 }), params, createRegulationState());
  // erreur=1, acc=1*1=1, offset = 0.5*1 + 0.5*1 + 0.5*(19-11) = 0.5 + 0.5 + 4 = 5
  assert.equal(result.offset, 5);
  assert.deepStrictEqual(result.nextState, { accumulatedError: 1, lastErrorSign: 1 });
});

test('le terme externe porte sur roomTemp − outdoorTemp, pas sur setpoint − outdoorTemp', () => {
  const params: RegulationParams = {
    kp: 0, ki: 0, kExt: 1, offsetMax: 100, accumulatedErrorThreshold: 100, overheatProtection: false,
  };
  const result = computeOffset(input({ setpoint: 20, roomTemp: 15, outdoorTemp: 5 }), params, createRegulationState());
  assert.equal(result.offset, 10); // 15 - 5
  assert.notEqual(result.offset, 15); // la formule fautive (20 - 5) donnerait 15
});

test('bornage haut par offsetMax', () => {
  const params: RegulationParams = {
    kp: 10, ki: 0, kExt: 0, offsetMax: 2, accumulatedErrorThreshold: 100, overheatProtection: false,
  };
  const result = computeOffset(input({ setpoint: 25, roomTemp: 15 }), params, createRegulationState());
  assert.equal(result.offset, 2);
});

test('bornage bas par offsetMax', () => {
  const params: RegulationParams = {
    kp: 10, ki: 0, kExt: 0, offsetMax: 2, accumulatedErrorThreshold: 100, overheatProtection: false,
  };
  const result = computeOffset(input({ setpoint: 25, roomTemp: 35 }), params, createRegulationState());
  assert.equal(result.offset, -2);
});

test('saturation positive de erreur_cumulée', () => {
  const params: RegulationParams = {
    kp: 0, ki: 1, kExt: 0, offsetMax: 100, accumulatedErrorThreshold: 5, overheatProtection: false,
  };
  const state: RegulationState = { accumulatedError: 4, lastErrorSign: 1 };
  const result = computeOffset(input({ setpoint: 23, roomTemp: 20 }), params, state); // erreur = 3
  assert.equal(result.nextState.accumulatedError, 5);
  assert.equal(result.offset, 5);
});

test('saturation négative de erreur_cumulée', () => {
  const params: RegulationParams = {
    kp: 0, ki: 1, kExt: 0, offsetMax: 100, accumulatedErrorThreshold: 5, overheatProtection: false,
  };
  const state: RegulationState = { accumulatedError: -4, lastErrorSign: -1 };
  const result = computeOffset(input({ setpoint: 17, roomTemp: 20 }), params, state); // erreur = -3
  assert.equal(result.nextState.accumulatedError, -5);
  assert.equal(result.offset, -5);
});

// --- Pondération temporelle de l'accumulation --------------------------------

const INTEGRAL_ONLY: RegulationParams = {
  kp: 0, ki: 1, kExt: 0, offsetMax: 1000, accumulatedErrorThreshold: 1000, overheatProtection: false,
};

test('un demi-cycle ne pèse que la moitié dans l\'accumulation', () => {
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtCycles: 0.5 }), // erreur = 3
    INTEGRAL_ONLY,
    createRegulationState(),
  );
  assert.equal(result.nextState.accumulatedError, 1.5);
});

test('un intervalle de plus de 2 cycles est ramené à 1 cycle', () => {
  // Comportement VT : un long trou (app arrêtée, capteur muet) ne doit pas produire un à-coup
  // d'intégrale proportionnel au trou.
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtCycles: 5 }), // erreur = 3
    INTEGRAL_ONLY,
    createRegulationState(),
  );
  assert.equal(result.nextState.accumulatedError, 3); // et non 15
});

test('un intervalle de 2 cycles exactement n\'est pas encore plafonné', () => {
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtCycles: 2 }), // erreur = 3
    INTEGRAL_ONLY,
    createRegulationState(),
  );
  assert.equal(result.nextState.accumulatedError, 6);
});

test('sans pondération, une rafale de pas hors cycle emballerait l\'intégrale', () => {
  // Dix recalculs hors cycle valant chacun un dixième de cycle : au total un seul cycle d'erreur.
  let state = createRegulationState();
  for (let i = 0; i < 10; i += 1) {
    ({ nextState: state } = computeOffset(
      input({ setpoint: 21, roomTemp: 20, dtCycles: 0.1 }), // erreur = 1
      INTEGRAL_ONLY,
      state,
    ));
  }
  assert.ok(Math.abs(state.accumulatedError - 1) < 1e-9, `attendu ~1, obtenu ${state.accumulatedError}`);
});

// --- Protection surchauffe ---------------------------------------------------

test('protection surchauffe : divise par 2 × max(dt, 0.5) — dt = 1 cycle', () => {
  const params: RegulationParams = { ...INTEGRAL_ONLY, overheatProtection: true };
  const state: RegulationState = { accumulatedError: 10, lastErrorSign: 1 };
  const result = computeOffset(input({ setpoint: 15, roomTemp: 20, dtCycles: 1 }), params, state); // erreur = -5
  // (10 / 2) + (-5 * 1) = 0
  assert.equal(result.nextState.accumulatedError, 0);
  assert.equal(result.nextState.lastErrorSign, -1);
});

test('protection surchauffe : plancher à 0,5 pour les pas très courts', () => {
  const params: RegulationParams = { ...INTEGRAL_ONLY, overheatProtection: true };
  const state: RegulationState = { accumulatedError: 10, lastErrorSign: 1 };
  const result = computeOffset(input({ setpoint: 15, roomTemp: 20, dtCycles: 0.25 }), params, state);
  // diviseur = 2 * max(0.25, 0.5) = 1 -> 10 + (-5 * 0.25) = 8.75
  assert.equal(result.nextState.accumulatedError, 8.75);
});

test('protection surchauffe : un pas long décharge davantage', () => {
  const params: RegulationParams = { ...INTEGRAL_ONLY, overheatProtection: true };
  const state: RegulationState = { accumulatedError: 10, lastErrorSign: 1 };
  const result = computeOffset(input({ setpoint: 15, roomTemp: 20, dtCycles: 2 }), params, state);
  // diviseur = 2 * 2 = 4 -> (10 / 4) + (-5 * 2) = -7.5
  assert.equal(result.nextState.accumulatedError, -7.5);
});

test("protection surchauffe : ne s'applique pas quand overheatProtection est faux", () => {
  const state: RegulationState = { accumulatedError: 10, lastErrorSign: 1 };
  const result = computeOffset(input({ setpoint: 15, roomTemp: 20 }), INTEGRAL_ONLY, state); // erreur = -5
  assert.equal(result.nextState.accumulatedError, 5); // pas de division : 10 + (-5)
});

// --- Cas particuliers ---------------------------------------------------------

test('mode none renvoie toujours un offset nul', () => {
  const params = REGULATION_PRESETS.none;
  const inputs: RegulationInput[] = [
    input({ setpoint: 25, roomTemp: 15, outdoorTemp: -10 }),
    input({ setpoint: 10, roomTemp: 25, outdoorTemp: 30 }),
  ];
  let state = createRegulationState();
  for (const one of inputs) {
    const result = computeOffset(one, params, state);
    assert.equal(result.offset + 0, 0); // +0 normalise un éventuel -0 (kp/ki/kExt tous nuls)
    state = result.nextState;
  }
});

test('mode expert utilise les paramètres fournis', () => {
  const expert: RegulationParams = {
    kp: 1, ki: 0, kExt: 0, offsetMax: 10, accumulatedErrorThreshold: 10, overheatProtection: false,
  };
  const mode: RegulationMode = 'expert';
  const params = resolveRegulationParams(mode, expert);
  const result = computeOffset(input({ setpoint: 20, roomTemp: 18 }), params, createRegulationState()); // erreur = 2
  assert.equal(result.offset, 2);
});

test('sans capteur extérieur : aucune régulation du tout, et non un demi-offset', () => {
  // VT saute entièrement l'auto-régulation quand la température extérieure manque. Appliquer kp
  // et ki en mettant seulement le terme externe à zéro reviendrait à inventer un offset.
  const params: RegulationParams = {
    kp: 10, ki: 10, kExt: 0.5, offsetMax: 100, accumulatedErrorThreshold: 100, overheatProtection: true,
  };
  const result = computeOffset(input({ setpoint: 25, roomTemp: 15, outdoorTemp: null }), params, createRegulationState());
  assert.equal(result.offset, 0);
});

test("sans capteur extérieur : l'intégrale n'accumule pas pendant la suspension", () => {
  const params: RegulationParams = { ...INTEGRAL_ONLY, overheatProtection: true };
  const state: RegulationState = { accumulatedError: 7, lastErrorSign: 1 };
  let current = state;
  for (let i = 0; i < 5; i += 1) {
    const result = computeOffset(input({ setpoint: 25, roomTemp: 15, outdoorTemp: null }), params, current);
    assert.equal(result.offset, 0);
    current = result.nextState;
  }
  assert.deepStrictEqual(current, state);
});

test("l'entrée n'est pas mutée", () => {
  const params: RegulationParams = {
    kp: 0.3, ki: 0.05, kExt: 0.1, offsetMax: 5, accumulatedErrorThreshold: 20, overheatProtection: true,
  };
  const one = input({ setpoint: 20, roomTemp: 19, outdoorTemp: 10 });
  const state: RegulationState = { accumulatedError: 1, lastErrorSign: 1 };
  const inputCopy = { ...one };
  const stateCopy = { ...state };
  const result = computeOffset(one, params, state);
  assert.deepStrictEqual(one, inputCopy);
  assert.deepStrictEqual(state, stateCopy);
  assert.notStrictEqual(result.nextState, state);
});

test("l'entrée n'est pas mutée non plus quand la régulation est suspendue", () => {
  const state: RegulationState = { accumulatedError: 1, lastErrorSign: 1 };
  const result = computeOffset(input({ outdoorTemp: null }), INTEGRAL_ONLY, state);
  assert.notStrictEqual(result.nextState, state);
});
