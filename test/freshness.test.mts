import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStale, resolveTimestamp, toEpochMs } from '../lib/freshness.mjs';
import type { TimestampCandidates } from '../lib/freshness.mjs';

const MINUTE = 60_000;

const NONE: TimestampCandidates = {
  lastUpdatedMs: null,
  lastChangedMs: null,
  listenerFiredAtMs: null,
};

// --- toEpochMs -------------------------------------------------------------

test('toEpochMs accepte les trois formes que homey-api produit réellement', () => {
  assert.equal(toEpochMs(new Date(1_700_000_000_000)), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs('2023-11-14T22:13:20.000Z'), 1_700_000_000_000);
});

test('toEpochMs refuse tout ce qui ne date rien', () => {
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs(undefined), null);
  assert.equal(toEpochMs(''), null);
  assert.equal(toEpochMs('pas une date'), null);
  assert.equal(toEpochMs(new Date('invalide')), null);
  assert.equal(toEpochMs(Number.NaN), null);
  assert.equal(toEpochMs(0), null);
  assert.equal(toEpochMs(-1), null);
  assert.equal(toEpochMs({}), null);
});

// --- resolveTimestamp ------------------------------------------------------

test('priorité 1 : lastUpdated l\'emporte sur les deux autres', () => {
  const resolved = resolveTimestamp({ lastUpdatedMs: 100, lastChangedMs: 200, listenerFiredAtMs: 300 });
  assert.deepStrictEqual(resolved, { atMs: 100, source: 'lastUpdated' });
});

test('priorité 2 : lastChanged prend le relais quand lastUpdated manque', () => {
  const resolved = resolveTimestamp({ lastUpdatedMs: null, lastChangedMs: 200, listenerFiredAtMs: 300 });
  assert.deepStrictEqual(resolved, { atMs: 200, source: 'lastChanged' });
});

test('priorité 3 : l\'instant du listener est le dernier recours', () => {
  const resolved = resolveTimestamp({ lastUpdatedMs: null, lastChangedMs: null, listenerFiredAtMs: 300 });
  assert.deepStrictEqual(resolved, { atMs: 300, source: 'listener' });
});

test('aucune source : null, et surtout pas l\'instant courant', () => {
  assert.equal(resolveTimestamp(NONE), null);
});

// --- computeStale ----------------------------------------------------------

test('lecture récente sous le seuil : fraîche', () => {
  const stale = computeStale({ atMs: 0, nowMs: 10 * MINUTE, freshnessMs: 20 * MINUTE, available: true });
  assert.equal(stale, false);
});

test('lecture exactement au seuil : encore fraîche', () => {
  const stale = computeStale({ atMs: 0, nowMs: 20 * MINUTE, freshnessMs: 20 * MINUTE, available: true });
  assert.equal(stale, false);
});

test('lecture au-delà du seuil : périmée', () => {
  const stale = computeStale({ atMs: 0, nowMs: 20 * MINUTE + 1, freshnessMs: 20 * MINUTE, available: true });
  assert.equal(stale, true);
});

test('le seuil vient de l\'appelant : le même âge est périmé pour un capteur de température et frais pour un contact de fenêtre', () => {
  const atMs = 0;
  const nowMs = 6 * 60 * MINUTE; // six heures
  assert.equal(computeStale({ atMs, nowMs, freshnessMs: 20 * MINUTE, available: true }), true);
  assert.equal(computeStale({ atMs, nowMs, freshnessMs: 3 * 24 * 60 * MINUTE, available: true }), false);
});

test('appareil indisponible : périmé quel que soit l\'âge, même horodaté à l\'instant', () => {
  const stale = computeStale({ atMs: 1_000, nowMs: 1_000, freshnessMs: 20 * MINUTE, available: false });
  assert.equal(stale, true);
});

test('freshnessMs infini : jamais périmé tant que l\'appareil répond', () => {
  const stale = computeStale({ atMs: 0, nowMs: 10 ** 12, freshnessMs: Infinity, available: true });
  assert.equal(stale, false);
});

test('horodatage dans le futur (dérive d\'horloge) : traité comme frais, pas comme périmé', () => {
  const stale = computeStale({ atMs: 10 * MINUTE, nowMs: 0, freshnessMs: MINUTE, available: true });
  assert.equal(stale, false);
});

test('horodatage aberrant : périmé plutôt que frais', () => {
  assert.equal(computeStale({ atMs: Number.NaN, nowMs: 0, freshnessMs: MINUTE, available: true }), true);
  assert.equal(computeStale({ atMs: 0, nowMs: Number.NaN, freshnessMs: MINUTE, available: true }), true);
});
