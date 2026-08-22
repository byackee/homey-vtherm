import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegulationState, resolveRegulationParams, computeOffset } from '../lib/selfRegulation.mjs';
import { REGULATION_PRESETS } from '../lib/constants.mjs';
import type { RegulationInput, RegulationMode, RegulationParams, RegulationState } from '../lib/types.mjs';

const expertPreset: RegulationParams = REGULATION_PRESETS.medium; // valeur bidon, non utilisée par les modes préréglés

/** Un pas de durée exactement une période de régulation, cas nominal. */
function input(overrides: Partial<RegulationInput>): RegulationInput {
  return {
    setpoint: 20, roomTemp: 20, outdoorTemp: 0, dtPeriods: 1, nowMs: 0, ...overrides,
  };
}

/** Un état dont la boucle a DÉJÀ intégré : sans ça, la porte laisse passer avec `dt = 1`. */
function stateAt(accumulatedError: number, lastRegulationAtMs: number | null = 0): RegulationState {
  return { accumulatedError, lastRegulationAtMs };
}

test('createRegulationState renvoie un état vierge', () => {
  assert.deepStrictEqual(createRegulationState(), { accumulatedError: 0, lastRegulationAtMs: null });
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
  assert.deepStrictEqual(result.nextState, stateAt(1));
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
  const state: RegulationState = stateAt(4);
  const result = computeOffset(input({ setpoint: 23, roomTemp: 20 }), params, state); // erreur = 3
  assert.equal(result.nextState.accumulatedError, 5);
  assert.equal(result.offset, 5);
});

test('saturation négative de erreur_cumulée', () => {
  const params: RegulationParams = {
    kp: 0, ki: 1, kExt: 0, offsetMax: 100, accumulatedErrorThreshold: 5, overheatProtection: false,
  };
  const state: RegulationState = stateAt(-4);
  const result = computeOffset(input({ setpoint: 17, roomTemp: 20 }), params, state); // erreur = -3
  assert.equal(result.nextState.accumulatedError, -5);
  assert.equal(result.offset, -5);
});

// --- Pondération temporelle de l'accumulation --------------------------------

const INTEGRAL_ONLY: RegulationParams = {
  kp: 0, ki: 1, kExt: 0, offsetMax: 1000, accumulatedErrorThreshold: 1000, overheatProtection: false,
};

test('sous une période, la boucle N\'INTÈGRE PAS : la porte la retient', () => {
  // Ce test disait autrefois « un demi-cycle pèse la moitié ». La pondération existe toujours pour
  // un pas d'une période ou plus, mais SOUS une période la boucle n'intègre pas du tout : c'est
  // `check_auto_regulation_period_min` de l'amont, dont l'absence rendait la protection surchauffe
  // inerte dans 98 % des pas dès trois thermostats.
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtPeriods: 0.5 }), // erreur = 3
    INTEGRAL_ONLY,
    stateAt(0),
  );
  assert.equal(result.nextState.accumulatedError, 0, 'rien n\'a été accumulé');
});

test('la toute PREMIÈRE intégration part d\'une période pleine', () => {
  // `lastRegulationAtMs` est nul au démarrage : sans référence, prendre `dt` au pied de la lettre
  // ferait démarrer la boucle sur une fraction arbitraire selon l'instant du premier pas.
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtPeriods: 0.1 }),
    INTEGRAL_ONLY,
    createRegulationState(),
  );
  assert.equal(result.nextState.accumulatedError, 3);
});

test('un intervalle de plus de 2 cycles est ramené à 1 cycle', () => {
  // Comportement VT : un long trou (app arrêtée, capteur muet) ne doit pas produire un à-coup
  // d'intégrale proportionnel au trou.
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtPeriods: 5 }), // erreur = 3
    INTEGRAL_ONLY,
    createRegulationState(),
  );
  assert.equal(result.nextState.accumulatedError, 3); // et non 15
});

test('un intervalle de 2 cycles exactement n\'est pas encore plafonné', () => {
  const result = computeOffset(
    input({ setpoint: 23, roomTemp: 20, dtPeriods: 2 }), // erreur = 3
    INTEGRAL_ONLY,
    stateAt(0),
  );
  assert.equal(result.nextState.accumulatedError, 6);
});

test('sans pondération, une rafale de pas hors cycle emballerait l\'intégrale', () => {
  // Dix recalculs hors cycle valant chacun un dixième de cycle : au total un seul cycle d'erreur.
  let state = createRegulationState();
  for (let i = 0; i < 10; i += 1) {
    ({ nextState: state } = computeOffset(
      input({ setpoint: 21, roomTemp: 20, dtPeriods: 0.1 }), // erreur = 1
      INTEGRAL_ONLY,
      state,
    ));
  }
  assert.ok(Math.abs(state.accumulatedError - 1) < 1e-9, `attendu ~1, obtenu ${state.accumulatedError}`);
});

// --- Protection surchauffe ---------------------------------------------------

test('protection surchauffe : divise par 2 × max(dt, 0.5) — dt = 1 cycle', () => {
  const params: RegulationParams = { ...INTEGRAL_ONLY, overheatProtection: true };
  const state: RegulationState = stateAt(10);
  const result = computeOffset(input({ setpoint: 15, roomTemp: 20, dtPeriods: 1 }), params, state); // erreur = -5
  // (10 / 2) + (-5 * 1) = 0
  assert.equal(result.nextState.accumulatedError, 0);
});

test('protection surchauffe : un pas long décharge davantage', () => {
  const params: RegulationParams = { ...INTEGRAL_ONLY, overheatProtection: true };
  const state: RegulationState = stateAt(10);
  const result = computeOffset(input({ setpoint: 15, roomTemp: 20, dtPeriods: 2 }), params, state);
  // diviseur = 2 * 2 = 4 -> (10 / 4) + (-5 * 2) = -7.5
  assert.equal(result.nextState.accumulatedError, -7.5);
});

test("protection surchauffe : ne s'applique pas quand overheatProtection est faux", () => {
  const state: RegulationState = stateAt(10);
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
  const state: RegulationState = stateAt(7);
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
  const state: RegulationState = stateAt(1);
  const inputCopy = { ...one };
  const stateCopy = { ...state };
  const result = computeOffset(one, params, state);
  assert.deepStrictEqual(one, inputCopy);
  assert.deepStrictEqual(state, stateCopy);
  assert.notStrictEqual(result.nextState, state);
});

test("l'entrée n'est pas mutée non plus quand la régulation est suspendue", () => {
  const state: RegulationState = stateAt(1);
  const result = computeOffset(input({ outdoorTemp: null }), INTEGRAL_ONLY, state);
  assert.notStrictEqual(result.nextState, state);
});

test('une erreur EXACTEMENT nulle ne perturbe rien : l\'intégrale est sa propre mémoire', () => {
  // Les consignes sont alignées sur 0,5 °C et les mesures arrivent au dixième : l'erreur nulle est
  // banale. Elle demandait un cas particulier tant qu'on mémorisait le signe de l'erreur ; la
  // condition portant sur l'intégrale n'en a plus besoin.
  const params = REGULATION_PRESETS.medium;
  const charged: RegulationState = stateAt(20);

  const zero = computeOffset(input({ roomTemp: 20, setpoint: 20, nowMs: 0 }), params, charged);
  assert.equal(zero.nextState.accumulatedError, 20, 'erreur nulle : ni charge ni décharge');

  const crossed = computeOffset(
    input({ roomTemp: 20.5, setpoint: 20, nowMs: 300_000 }), params, zero.nextState,
  );
  assert.ok(
    crossed.nextState.accumulatedError < zero.nextState.accumulatedError,
    `la décharge a bien eu lieu : ${zero.nextState.accumulatedError} -> ${crossed.nextState.accumulatedError}`,
  );
});

// --- Fidélité à l'amont : condition portant sur l'INTÉGRALE -------------------

test('la décharge SE REJOUE tant que l\'erreur et l\'intégrale se contredisent', () => {
  // L'amont compare `erreur × erreur_cumulée < 0`, pas l'erreur à l'erreur précédente. La nuance
  // décide de tout : comparée au pas précédent, la décharge ne survenait qu'UNE fois, à la
  // traversée, et l'intégrale mettait ensuite des heures à se résorber au lieu de quelques pas.
  const params = REGULATION_PRESETS.medium;
  let state = stateAt(20);
  const seen: number[] = [];

  for (let i = 1; i <= 4; i += 1) {
    const res = computeOffset(
      input({ setpoint: 20, roomTemp: 20.5, nowMs: i * 300_000 }), params, state,
    );
    state = res.nextState;
    seen.push(state.accumulatedError);
  }

  // Halvings successifs, pas une simple décroissance linéaire.
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(
      (seen[i] as number) < (seen[i - 1] as number) / 1.5,
      `pas ${i + 1} : ${seen[i - 1]} -> ${seen[i]} n'est pas une nouvelle décharge`,
    );
  }
});

test('aucune décharge quand l\'erreur et l\'intégrale sont DÉJÀ du même signe', () => {
  // Le faux positif de l'ancienne condition : intégrale négative, erreur qui bascule de + à −.
  // On coupait en deux une intégrale pourtant correctement signée.
  const params = REGULATION_PRESETS.medium;
  const res = computeOffset(
    input({ setpoint: 20, roomTemp: 20.5, nowMs: 300_000 }), params, stateAt(-20),
  );

  // −20 + (−0,5 × 1) = −20,5, ramené à −20 par le seuil de saturation. Rien n'a été DIVISÉ :
  // avec l'ancienne condition on serait parti de −10, donc loin de la saturation.
  assert.equal(res.nextState.accumulatedError, -20);
});

// --- La porte : une intégration par période de régulation ---------------------

test('sous une période, l\'intégrale n\'avance pas — mais l\'offset reste vivant', () => {
  // PANNE EMPÊCHÉE : l'ordonnanceur force un pas de tous les participants au moindre événement.
  // En prenant le pas pour référence, la boucle tournait jusqu'à deux cents fois par heure, `dt`
  // tombait sous 0,5, et le plancher de la protection surchauffe ramenait le diviseur à 1.
  const params = REGULATION_PRESETS.medium;
  let state = computeOffset(input({ setpoint: 20, roomTemp: 19, nowMs: 0 }), params, stateAt(0, null as never))
    .nextState;
  const afterFirst = state.accumulatedError;

  // Quatre pas d'une minute : aucun n'atteint la période de cinq minutes.
  for (let m = 1; m <= 4; m += 1) {
    const res = computeOffset(
      input({ setpoint: 20, roomTemp: 19, dtPeriods: m / 5, nowMs: m * 60_000 }), params, state,
    );
    assert.equal(res.nextState.accumulatedError, afterFirst, `pas à ${m} min : l'intégrale a bougé`);
    assert.ok(res.offset > 0, 'mais l\'offset répond toujours à la mesure courante');
    state = res.nextState;
  }

  // Le pas qui franchit la période intègre, une seule fois.
  const due = computeOffset(
    input({ setpoint: 20, roomTemp: 19, dtPeriods: 1, nowMs: 300_000 }), params, state,
  );
  assert.ok(due.nextState.accumulatedError > afterFirst, 'la période écoulée, la boucle intègre');
  assert.equal(due.nextState.lastRegulationAtMs, 300_000);
});

// --- Comparabilité avec l'amont ------------------------------------------------
//
// La boucle est un portage. Tant que la condition portait sur l'erreur précédente au lieu de
// l'intégrale, notre sortie s'écartait de celle de l'amont dès la première traversée — et rien ne
// le disait. Ce test rejoue une trajectoire complète et compare à une réimplémentation littérale
// de `pi_algorithm.py`, écrite ici en dix lignes. Si le portage dérive, il tombe.

/** `PITemperatureRegulator.calculate_regulated_temperature`, transcrit littéralement. */
function upstreamPi(acc: number, setpoint: number, room: number, ext: number, dt: number, p: RegulationParams) {
  const timeDelta = dt > 2.0 ? 1.0 : dt;
  const error = setpoint - room;
  if (p.overheatProtection && error * acc < 0) acc /= 2.0 * Math.max(timeDelta, 0.5);
  acc = Math.min(p.accumulatedErrorThreshold, Math.max(-p.accumulatedErrorThreshold, acc + error * timeDelta));
  const offset = Math.min(p.offsetMax, Math.max(-p.offsetMax,
    p.kp * error + p.ki * acc + p.kExt * (room - ext)));
  return { acc, offset };
}

test('une soirée complète : notre sortie est celle de l\'amont, pas à pas', () => {
  const params = REGULATION_PRESETS.medium;
  // Montée de 18 à 21 °C vers une consigne de 20, puis stabilisation au-dessus : la trajectoire
  // traverse la consigne, ce qui est exactement là où les deux conditions divergeaient.
  const rooms = [18, 18.4, 18.8, 19.2, 19.6, 20, 20.4, 20.6, 20.6, 20.5, 20.4, 20.3, 20.2, 20.1];

  let ours: RegulationState = createRegulationState();
  let upAcc = 0;

  rooms.forEach((room, i) => {
    const nowMs = i * 300_000;
    const o = computeOffset(
      input({ setpoint: 20, roomTemp: room, outdoorTemp: 5, dtPeriods: i === 0 ? 1 : 1, nowMs }),
      params, ours,
    );
    const u = upstreamPi(upAcc, 20, room, 5, 1, params);
    upAcc = u.acc;
    ours = o.nextState;

    assert.ok(
      Math.abs(o.offset - u.offset) < 1e-9,
      `pas ${i} (pièce ${room}) : offset ${o.offset.toFixed(4)} ≠ amont ${u.offset.toFixed(4)}`,
    );
    assert.ok(
      Math.abs(ours.accumulatedError - upAcc) < 1e-9,
      `pas ${i} : intégrale ${ours.accumulatedError.toFixed(4)} ≠ amont ${upAcc.toFixed(4)}`,
    );
  });
});
