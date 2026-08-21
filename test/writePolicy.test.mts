import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWrite } from '../lib/writePolicy.mjs';
import type { LastWrite, WriteOptions } from '../lib/writePolicy.mjs';

const MINUTE = 60_000;

test('première écriture toujours autorisée, quelles que soient les options', () => {
  const opts: WriteOptions = { minDelta: 10, minIntervalMs: MINUTE, maxIntervalMs: 10 * MINUTE };
  const decision = shouldWrite(null, 19.5, opts, 0);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'first');
});

test('minDelta : un écart inférieur au seuil ne part pas', () => {
  const last: LastWrite = { value: 19.5, atMs: 0 };
  const decision = shouldWrite(last, 19.7, { minDelta: 0.5 }, 10 * MINUTE);
  assert.equal(decision.write, false);
  assert.equal(decision.reason, 'min_delta');
});

test('minDelta : un écart exactement égal au seuil part (pas de 0,5 °C de la TRVZB)', () => {
  const last: LastWrite = { value: 19.5, atMs: 0 };
  const decision = shouldWrite(last, 20, { minDelta: 0.5 }, 10 * MINUTE);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'changed');
});

test('minDelta : un écart supérieur au seuil part, dans les deux sens', () => {
  const last: LastWrite = { value: 19.5, atMs: 0 };
  assert.equal(shouldWrite(last, 21, { minDelta: 0.5 }, MINUTE).write, true);
  assert.equal(shouldWrite(last, 18, { minDelta: 0.5 }, MINUTE).write, true);
});

test('minIntervalMs : rien ne part avant que le délai soit écoulé, même sur gros écart', () => {
  const last: LastWrite = { value: 19.5, atMs: 1_000_000 };
  const opts: WriteOptions = { minDelta: 0.5, minIntervalMs: 5 * MINUTE };
  const decision = shouldWrite(last, 25, opts, 1_000_000 + 4 * MINUTE);
  assert.equal(decision.write, false);
  assert.equal(decision.reason, 'min_interval');
});

test('minIntervalMs : exactement écoulé, l\'écriture passe', () => {
  const last: LastWrite = { value: 19.5, atMs: 1_000_000 };
  const opts: WriteOptions = { minDelta: 0.5, minIntervalMs: 5 * MINUTE };
  const decision = shouldWrite(last, 25, opts, 1_000_000 + 5 * MINUTE);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'changed');
});

test('maxIntervalMs force la réécriture d\'une valeur IDENTIQUE (SPEC §5.3)', () => {
  const last: LastWrite = { value: 20.3, atMs: 0 };
  const opts: WriteOptions = { minDelta: 0.5, minIntervalMs: 5 * MINUTE, maxIntervalMs: 15 * MINUTE };

  // Avant l'échéance : la valeur inchangée reste bloquée.
  const before = shouldWrite(last, 20.3, opts, 14 * MINUTE);
  assert.equal(before.write, false);
  assert.equal(before.reason, 'min_delta');

  // À l'échéance : elle repart, sinon la vanne retombe sur sa dernière valeur connue.
  const at = shouldWrite(last, 20.3, opts, 15 * MINUTE);
  assert.equal(at.write, true);
  assert.equal(at.reason, 'max_interval');
});

test('maxIntervalMs prime aussi sur minIntervalMs mal réglé', () => {
  const last: LastWrite = { value: true, atMs: 0 };
  const opts: WriteOptions = { minIntervalMs: 30 * MINUTE, maxIntervalMs: 10 * MINUTE };
  const decision = shouldWrite(last, true, opts, 12 * MINUTE);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'max_interval');
});

test('maxIntervalMs à 0 ou absent ne déclenche aucun rappel', () => {
  const last: LastWrite = { value: 20.3, atMs: 0 };
  assert.equal(shouldWrite(last, 20.3, { maxIntervalMs: 0 }, 10 * MINUTE).reason, 'unchanged');
  assert.equal(shouldWrite(last, 20.3, {}, 10 * MINUTE).reason, 'unchanged');
});

test('valeur strictement identique sans minDelta : déduplication', () => {
  const last: LastWrite = { value: false, atMs: 0 };
  const decision = shouldWrite(last, false, {}, MINUTE);
  assert.equal(decision.write, false);
  assert.equal(decision.reason, 'unchanged');
});

test('valeur booléenne changée : part immédiatement', () => {
  const last: LastWrite = { value: false, atMs: 0 };
  const decision = shouldWrite(last, true, {}, MINUTE);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'changed');
});

test('valeur énumérée changée : minDelta ne s\'applique pas aux chaînes', () => {
  const last: LastWrite = { value: 'heat', atMs: 0 };
  const decision = shouldWrite(last, 'off', { minDelta: 5 }, MINUTE);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'changed');
});

test('changement de type : minDelta est ignoré, la comparaison stricte tranche', () => {
  const last: LastWrite = { value: 'off', atMs: 0 };
  const decision = shouldWrite(last, 21, { minDelta: 5 }, MINUTE);
  assert.equal(decision.write, true);
  assert.equal(decision.reason, 'changed');
});

test('horloge qui recule : minIntervalMs bloque au lieu de laisser passer une rafale', () => {
  const last: LastWrite = { value: 19, atMs: 10 * MINUTE };
  const opts: WriteOptions = { minIntervalMs: 5 * MINUTE };
  const decision = shouldWrite(last, 22, opts, 9 * MINUTE);
  assert.equal(decision.write, false);
  assert.equal(decision.reason, 'min_interval');
});

test('sans aucune option, toute valeur différente part et toute valeur égale est dédupliquée', () => {
  const last: LastWrite = { value: 19, atMs: 0 };
  assert.equal(shouldWrite(last, 19.0001, {}, 1).write, true);
  assert.equal(shouldWrite(last, 19, {}, 1).write, false);
});
