import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPersistentState, createVThermState, createVolatileState,
  migratePersistentState, restoreVThermState,
} from '../lib/state.mjs';
import type { VThermStateDefaults } from '../lib/types.mjs';

const DEFAULTS: VThermStateDefaults = { preset: 'comfort', manualSetpoint: 19 };

const HOUR_MS = 3_600_000;
const NOW = 1_000_000_000;

/** État durable plausible et complet, base des tests de dégradation champ par champ. */
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    preset: 'eco',
    manualSetpoint: 20.5,
    timedPreset: { preset: 'boost', untilMs: NOW + 60_000, previous: 'eco' },
    window: { phase: 'open', phaseSinceMs: NOW - 5_000, openSinceMs: NOW - 5_000 },
    windowMemento: { onoff: true, preset: 'eco', setpoint: 17 },
    regulation: { accumulatedError: 12.5, lastErrorSign: -1 },
    lastRunAtMs: NOW - 1_000,
    ...overrides,
  };
}

// --- Construction -----------------------------------------------------------

test('createVThermState part des défauts fournis et d\'un volatile neuf', () => {
  const state = createVThermState(NOW, DEFAULTS);

  assert.equal(state.persistent.version, 1);
  assert.equal(state.persistent.preset, 'comfort');
  assert.equal(state.persistent.manualSetpoint, 19);
  assert.equal(state.persistent.timedPreset, null);
  assert.equal(state.persistent.windowMemento, null);
  assert.equal(state.persistent.window.phase, 'closed');
  assert.equal(state.persistent.regulation.accumulatedError, 0);
  assert.equal(state.persistent.lastRunAtMs, NOW);

  assert.equal(state.volatile.slope.slope, null);
  assert.equal(state.volatile.motion.confirmed, false);
  assert.equal(state.volatile.lastWrite.valvePercent, null);
  assert.equal(state.volatile.lastWrite.setpoint, null);
});

test('rien n\'a jamais été publié au démarrage : aucun Flow fantôme au premier pas', () => {
  const { lastPublished } = createVolatileState();

  assert.equal(lastPublished.stateLabel, null);
  assert.equal(lastPublished.preset, null);
  assert.equal(lastPublished.windowOpen, null);
  assert.equal(lastPublished.demandActive, null);
});

test('la consigne manuelle par défaut est bornée comme les autres', () => {
  assert.equal(createPersistentState(NOW, { preset: 'none', manualSetpoint: 99 }).manualSetpoint, 35);
  assert.equal(createPersistentState(NOW, { preset: 'none', manualSetpoint: -5 }).manualSetpoint, 5);
});

// --- Migration : les valeurs qui n'auraient jamais dû arriver ---------------

test('undefined retombe intégralement sur les défauts', () => {
  const state = migratePersistentState(undefined, NOW, DEFAULTS);
  assert.deepEqual(state, createPersistentState(NOW, DEFAULTS));
});

test('null retombe intégralement sur les défauts', () => {
  assert.deepEqual(migratePersistentState(null, NOW, DEFAULTS), createPersistentState(NOW, DEFAULTS));
});

test('un objet vide retombe sur les défauts : pas de version, pas de confiance', () => {
  assert.deepEqual(migratePersistentState({}, NOW, DEFAULTS), createPersistentState(NOW, DEFAULTS));
});

test('une version inconnue repart des défauts, sans deviner champ par champ', () => {
  // L'état est par ailleurs parfaitement valide : c'est la version qui le disqualifie.
  const raw = validRaw({ version: 2 });
  const state = migratePersistentState(raw, NOW, DEFAULTS);

  assert.deepEqual(state, createPersistentState(NOW, DEFAULTS));
  assert.equal(state.preset, 'comfort');
  assert.equal(state.timedPreset, null);
});

test('un type primitif à la place de l\'objet retombe sur les défauts', () => {
  for (const raw of ['{}', 42, true, Symbol('x')] as unknown[]) {
    assert.deepEqual(migratePersistentState(raw, NOW, DEFAULTS), createPersistentState(NOW, DEFAULTS));
  }
});

test('un tableau n\'est pas un état durable', () => {
  assert.deepEqual(migratePersistentState([], NOW, DEFAULTS), createPersistentState(NOW, DEFAULTS));
});

test('un champ de mauvais type est remplacé, les champs sains sont conservés', () => {
  const state = migratePersistentState(
    validRaw({ manualSetpoint: 'chaud', preset: 'tiède' }),
    NOW,
    DEFAULTS,
  );

  assert.equal(state.manualSetpoint, 19, 'la consigne repart du défaut');
  assert.equal(state.preset, 'comfort', 'le preset repart du défaut');
  // Le reste de l'état, lui, a survécu.
  assert.equal(state.window.phase, 'open');
  assert.equal(state.regulation.accumulatedError, 12.5);
});

test('NaN ne franchit jamais la migration — c\'est le bug qui tue une capability en silence', () => {
  const state = migratePersistentState(
    validRaw({
      manualSetpoint: Number.NaN,
      lastRunAtMs: Number.NaN,
      regulation: { accumulatedError: Number.NaN, lastErrorSign: 1 },
      window: { phase: 'open', phaseSinceMs: Number.NaN, openSinceMs: Number.NaN },
    }),
    NOW,
    DEFAULTS,
  );

  assert.equal(Number.isNaN(state.manualSetpoint), false);
  assert.equal(state.manualSetpoint, 19);
  assert.equal(state.regulation.accumulatedError, 0);
  assert.equal(state.lastRunAtMs, NOW);
  assert.equal(state.window.phaseSinceMs, null);
  assert.equal(state.window.openSinceMs, null);
});

test('Infinity est traité comme NaN : ce n\'est pas un nombre exploitable', () => {
  const state = migratePersistentState(
    validRaw({ manualSetpoint: Number.POSITIVE_INFINITY, regulation: { accumulatedError: Number.NEGATIVE_INFINITY, lastErrorSign: 0 } }),
    NOW,
    DEFAULTS,
  );

  assert.equal(state.manualSetpoint, 19);
  assert.equal(state.regulation.accumulatedError, 0);
});

test('une consigne manuelle hors bornes est ramenée dans la plage de la SPEC §2.3', () => {
  assert.equal(migratePersistentState(validRaw({ manualSetpoint: 120 }), NOW, DEFAULTS).manualSetpoint, 35);
  assert.equal(migratePersistentState(validRaw({ manualSetpoint: -40 }), NOW, DEFAULTS).manualSetpoint, 5);
});

test('un signe d\'erreur hors domaine retombe à 0', () => {
  const state = migratePersistentState(
    validRaw({ regulation: { accumulatedError: 3, lastErrorSign: 5 } }),
    NOW,
    DEFAULTS,
  );
  assert.equal(state.regulation.lastErrorSign, 0);
  assert.equal(state.regulation.accumulatedError, 3);
});

test('une phase de fenêtre inconnue remet la machine à zéro plutôt que de la coincer', () => {
  const state = migratePersistentState(validRaw({ window: { phase: 'ajar' } }), NOW, DEFAULTS);

  assert.equal(state.window.phase, 'closed');
  assert.equal(state.window.phaseSinceMs, null);
  assert.equal(state.window.openSinceMs, null);
});

test('un preset temporisé incomplet est abandonné en entier', () => {
  const cases: unknown[] = [
    { preset: 'boost', previous: 'eco' }, // pas d'échéance
    { preset: 'boost', untilMs: NOW, previous: 'inconnu' }, // preset de retour invalide
    { preset: 'sieste', untilMs: NOW, previous: 'eco' }, // preset invalide
    { preset: 'boost', untilMs: Number.NaN, previous: 'eco' },
    'boost pendant 10 minutes',
    null,
  ];

  for (const timedPreset of cases) {
    assert.equal(migratePersistentState(validRaw({ timedPreset }), NOW, DEFAULTS).timedPreset, null);
  }
});

test('un mémento fenêtre incomplet est abandonné en entier', () => {
  const cases: unknown[] = [
    { preset: 'eco', setpoint: 17 }, // pas de onoff
    { onoff: true, preset: 'eco' }, // pas de consigne
    { onoff: true, preset: 'eco', setpoint: Number.NaN },
    { onoff: 'oui', preset: 'eco', setpoint: 17 },
    42,
  ];

  for (const windowMemento of cases) {
    assert.equal(migratePersistentState(validRaw({ windowMemento }), NOW, DEFAULTS).windowMemento, null);
  }
});

test('un état durable intact traverse la migration sans perte', () => {
  const state = migratePersistentState(validRaw(), NOW, DEFAULTS);

  assert.equal(state.preset, 'eco');
  assert.equal(state.manualSetpoint, 20.5);
  assert.deepEqual(state.timedPreset, { preset: 'boost', untilMs: NOW + 60_000, previous: 'eco' });
  assert.deepEqual(state.window, { phase: 'open', phaseSinceMs: NOW - 5_000, openSinceMs: NOW - 5_000 });
  assert.deepEqual(state.windowMemento, { onoff: true, preset: 'eco', setpoint: 17 });
  assert.deepEqual(state.regulation, { accumulatedError: 12.5, lastErrorSign: -1 });
  assert.equal(state.lastRunAtMs, NOW - 1_000);
});

// --- SPEC §11 : RAZ de l'erreur cumulée après un arrêt prolongé -------------

test('arrêt de plus d\'une heure : l\'erreur cumulée est remise à zéro', () => {
  const raw = validRaw({ lastRunAtMs: NOW - HOUR_MS - 1 });
  const state = migratePersistentState(raw, NOW, DEFAULTS);

  assert.equal(state.regulation.accumulatedError, 0);
  assert.equal(state.regulation.lastErrorSign, 0);
  // Le reste de l'état durable n'est pas concerné : seule l'intégrale a perdu son sens.
  assert.equal(state.preset, 'eco');
  assert.equal(state.window.phase, 'open');
});

test('arrêt d\'exactement une heure : l\'intégrale est conservée', () => {
  const raw = validRaw({ lastRunAtMs: NOW - HOUR_MS });
  assert.equal(migratePersistentState(raw, NOW, DEFAULTS).regulation.accumulatedError, 12.5);
});

test('arrêt court : l\'intégrale survit au redémarrage', () => {
  const raw = validRaw({ lastRunAtMs: NOW - 5 * 60_000 });
  const state = migratePersistentState(raw, NOW, DEFAULTS);

  assert.equal(state.regulation.accumulatedError, 12.5);
  assert.equal(state.regulation.lastErrorSign, -1);
});

test('horloge qui recule de plus d\'une heure : l\'intégrale est invalidée elle aussi', () => {
  // Changement d'heure ou resynchronisation NTP : la continuité temporelle est rompue dans les
  // deux sens, et une intégrale sans continuité ne veut plus rien dire.
  const raw = validRaw({ lastRunAtMs: NOW + HOUR_MS + 1 });
  assert.equal(migratePersistentState(raw, NOW, DEFAULTS).regulation.accumulatedError, 0);
});

test('lastRunAtMs illisible : on ne peut rien conclure sur l\'arrêt, on repart de maintenant', () => {
  const state = migratePersistentState(validRaw({ lastRunAtMs: 'hier' }), NOW, DEFAULTS);

  assert.equal(state.lastRunAtMs, NOW);
  assert.equal(state.regulation.accumulatedError, 12.5, 'aucun arrêt constaté, aucune RAZ');
});

// --- Restauration complète --------------------------------------------------

test('restoreVThermState relit le durable et repart d\'un volatile neuf', () => {
  const state = restoreVThermState(validRaw(), NOW, DEFAULTS);

  assert.equal(state.persistent.preset, 'eco');
  assert.equal(state.volatile.slope.slope, null);
  assert.equal(state.volatile.lastWrite.setpoint, null);
  assert.equal(state.volatile.lastPublished.stateLabel, null);
});

// --- Origine du compte à rebours du mode sécurité ---------------------------

test('lastGoodReadingAtMs se relit du store, et vaut null quand il n\'y était pas', () => {
  // Persisté pour la même raison que `lastOnPercent` : volatile, il repartirait de zéro à chaque
  // redémarrage et la borne de 24 h du mode sécurité ne serait jamais atteinte sur un capteur
  // mort depuis des semaines — le cas même qu'elle existe pour fermer.
  assert.equal(migratePersistentState(validRaw({ lastGoodReadingAtMs: 1234 }), NOW, DEFAULTS).lastGoodReadingAtMs, 1234);
  assert.equal(migratePersistentState(validRaw(), NOW, DEFAULTS).lastGoodReadingAtMs, null);
});

test('lastGoodReadingAtMs illisible : null, jamais un NaN ni une origine inventée', () => {
  for (const bogus of ['hier', Number.NaN, Number.POSITIVE_INFINITY, {}, null]) {
    const state = migratePersistentState(validRaw({ lastGoodReadingAtMs: bogus }), NOW, DEFAULTS);
    assert.equal(state.lastGoodReadingAtMs, null, `valeur relue : ${String(bogus)}`);
  }
});

test('un état neuf n\'invente pas d\'origine de mesure', () => {
  // `nowMs` ferait croire qu'une mesure vient d'arriver : la sécurité repartirait pour 24 h à
  // chaque mise à jour de l'app.
  assert.equal(createPersistentState(NOW, DEFAULTS).lastGoodReadingAtMs, null);
});
