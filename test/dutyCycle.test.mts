import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDutyCycleState, stepDutyCycle, type DutyCycleParams } from '../lib/dutyCycle.mjs';

/** Cycle de 10 minutes, gardes à 30 s — les valeurs recommandées par VT pour un convecteur. */
const P: DutyCycleParams = { cycleMin: 10, minActivationSec: 30, minDeactivationSec: 30 };
const CYCLE = 10 * 60_000;

test('50 % : allumé la première moitié du cycle, éteint la seconde', () => {
  let s = createDutyCycleState();
  const start = stepDutyCycle(s, 0.5, P, 0);
  assert.equal(start.commanded, true);
  assert.equal(start.changed, true);
  assert.equal(start.wakeUpAtMs, CYCLE / 2, 'réveil à la fin de la période de marche');
  s = start.nextState;

  const middle = stepDutyCycle(s, 0.5, P, CYCLE / 2 - 1);
  assert.equal(middle.commanded, true);

  const after = stepDutyCycle(middle.nextState, 0.5, P, CYCLE / 2);
  assert.equal(after.commanded, false);
  assert.equal(after.changed, true);
  assert.equal(after.wakeUpAtMs, CYCLE, 'réveil à la fin du cycle');
});

test('un nouveau cycle repart au bon moment', () => {
  let s = createDutyCycleState();
  s = stepDutyCycle(s, 0.5, P, 0).nextState;
  const next = stepDutyCycle(s, 0.5, P, CYCLE);
  assert.equal(next.commanded, true, 'le cycle suivant recommence par la marche');
  assert.equal(next.nextState.cycleStartMs, CYCLE);
});

test('puissance trop faible pour chauffer : on n\'allume pas du tout', () => {
  // 4 % de 10 minutes = 24 secondes. Allumer un convecteur pour ça ne chauffe rien et use le
  // relais ; VT ne l'allume pas, nous non plus.
  const r = stepDutyCycle(createDutyCycleState(), 0.04, P, 0);
  assert.equal(r.commanded, false);
  assert.equal(r.wakeUpAtMs, CYCLE);
});

test('juste au-dessus du seuil d\'activation : on allume', () => {
  // 6 % de 10 minutes = 36 secondes, au-dessus des 30 s.
  const r = stepDutyCycle(createDutyCycleState(), 0.06, P, 0);
  assert.equal(r.commanded, true);
  assert.equal(r.wakeUpAtMs, 36_000);
});

test('arrêt trop court : on laisse allumé plutôt que de faire clignoter', () => {
  // 97 % laisserait 18 secondes d'arrêt. Couper puis rallumer pour si peu use le contact sans
  // rien apporter.
  const r = stepDutyCycle(createDutyCycleState(), 0.97, P, 0);
  assert.equal(r.commanded, true);
  assert.equal(r.wakeUpAtMs, CYCLE, 'allumé tout le cycle');
});

test('0 % et 100 % sont des cas francs', () => {
  assert.equal(stepDutyCycle(createDutyCycleState(), 0, P, 0).commanded, false);
  assert.equal(stepDutyCycle(createDutyCycleState(), 1, P, 0).commanded, true);
});

test('une puissance aberrante ne fait rien allumer', () => {
  assert.equal(stepDutyCycle(createDutyCycleState(), Number.NaN, P, 0).commanded, false);
  assert.equal(stepDutyCycle(createDutyCycleState(), -1, P, 0).commanded, false);
  assert.equal(stepDutyCycle(createDutyCycleState(), 5, P, 0).commanded, true);
});

test('`changed` ne vaut vrai que sur une vraie bascule', () => {
  let s = createDutyCycleState();
  const a = stepDutyCycle(s, 0.5, P, 0);
  assert.equal(a.changed, true);
  const b = stepDutyCycle(a.nextState, 0.5, P, 60_000);
  assert.equal(b.commanded, true);
  assert.equal(b.changed, false, 'une écriture inutile use le relais autant qu\'une utile');
});

test('une horloge qui recule redémarre le cycle au lieu de calculer à l\'envers', () => {
  let s = createDutyCycleState();
  s = stepDutyCycle(s, 0.5, P, 1_000_000).nextState;
  const back = stepDutyCycle(s, 0.5, P, 500_000);
  assert.equal(back.nextState.cycleStartMs, 500_000);
  assert.equal(back.commanded, true);
});

test('le cycle le plus court possible reste cohérent', () => {
  const short: DutyCycleParams = { cycleMin: 1, minActivationSec: 30, minDeactivationSec: 30 };
  // Sur une minute, 50 % fait 30 s de marche et 30 s d'arrêt : exactement les deux seuils.
  const r = stepDutyCycle(createDutyCycleState(), 0.5, short, 0);
  assert.equal(r.commanded, true);
  assert.equal(r.wakeUpAtMs, 30_000);
});

test('la fonction est pure : l\'état d\'entrée n\'est pas muté', () => {
  const s = Object.freeze(createDutyCycleState());
  stepDutyCycle(s, 0.5, P, 0);
  assert.equal(s.cycleStartMs, null);
});
