import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowState, stepWindow } from '../lib/windowDetector.mjs';
import type { WindowInput, WindowParams, WindowState } from '../lib/types.mjs';

const SENSOR_PARAMS: WindowParams = {
  mode: 'sensor',
  delaySec: 30,
  offDelaySec: 30,
  action: 'turn_off',
  autoOpenThreshold: 3,
  autoCloseThreshold: 0,
  autoMaxDurationSec: 1800,
};

const AUTO_PARAMS: WindowParams = { ...SENSOR_PARAMS, mode: 'auto' };

function input(overrides: Partial<WindowInput>): WindowInput {
  return { sensorOpen: null, slopePerHour: null, bypass: false, ...overrides };
}

// --- Mode capteur -----------------------------------------------------------

test('mode capteur : délai respecté avant confirmation', () => {
  let state = createWindowState();

  let result = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0);
  assert.equal(result.nextState.phase, 'pending_open');
  assert.equal(result.active, false);
  state = result.nextState;

  result = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 29_999);
  assert.equal(result.nextState.phase, 'pending_open');
  assert.equal(result.active, false);
  state = result.nextState;

  result = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 30_000);
  assert.equal(result.nextState.phase, 'open');
  assert.equal(result.active, true);
  assert.equal(result.action, 'turn_off');
});

test('mode capteur : ouverture fugace ignorée', () => {
  let state = createWindowState();
  let result = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0);
  state = result.nextState;
  assert.equal(state.phase, 'pending_open');

  // Refermé avant la fin du délai : retour direct, rien ne s'est passé.
  result = stepWindow(state, input({ sensorOpen: false }), SENSOR_PARAMS, 10_000);
  assert.equal(result.nextState.phase, 'closed');
  assert.equal(result.active, false);
});

test('mode capteur : restauration après délai de fermeture', () => {
  // Établit la phase `open`.
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0));
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 30_000));
  assert.equal(state.phase, 'open');

  let result = stepWindow(state, input({ sensorOpen: false }), SENSOR_PARAMS, 40_000);
  assert.equal(result.nextState.phase, 'pending_close');
  assert.equal(result.active, true); // toujours actif tant que non confirmé
  state = result.nextState;

  result = stepWindow(state, input({ sensorOpen: false }), SENSOR_PARAMS, 40_000 + 29_999);
  assert.equal(result.nextState.phase, 'pending_close');
  state = result.nextState;

  result = stepWindow(state, input({ sensorOpen: false }), SENSOR_PARAMS, 40_000 + 30_000);
  assert.equal(result.nextState.phase, 'closed');
  assert.equal(result.active, false);
});

test('mode capteur : réouverture pendant pending_close revient à open sans délai', () => {
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0));
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 30_000));
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: false }), SENSOR_PARAMS, 40_000));
  assert.equal(state.phase, 'pending_close');

  const result = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 45_000);
  assert.equal(result.nextState.phase, 'open');
  assert.equal(result.active, true);
});

test('mode capteur : les deux délais sont indépendants', () => {
  // VT a `window_delay` ET `window_off_delay` : couper vite et restaurer lentement est un
  // réglage légitime, qu'un délai symétrique interdisait.
  const params: WindowParams = { ...SENSOR_PARAMS, delaySec: 10, offDelaySec: 120 };
  let state = createWindowState();

  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), params, 0));
  const opened = stepWindow(state, input({ sensorOpen: true }), params, 10_000);
  assert.equal(opened.nextState.phase, 'open'); // ouverture confirmée en 10 s
  state = opened.nextState;

  ({ nextState: state } = stepWindow(state, input({ sensorOpen: false }), params, 20_000));
  assert.equal(state.phase, 'pending_close');

  // Au bout du délai d'OUVERTURE, la fermeture n'est toujours pas confirmée.
  const tooEarly = stepWindow(state, input({ sensorOpen: false }), params, 20_000 + 10_000);
  assert.equal(tooEarly.nextState.phase, 'pending_close');
  assert.equal(tooEarly.active, true);

  const confirmed = stepWindow(state, input({ sensorOpen: false }), params, 20_000 + 120_000);
  assert.equal(confirmed.nextState.phase, 'closed');
  assert.equal(confirmed.active, false);
});

// --- Mode auto ---------------------------------------------------------------

test('mode auto : franchissement du seuil de pente déclenche la détection', () => {
  let state = createWindowState();
  let result = stepWindow(state, input({ slopePerHour: -3.5 }), AUTO_PARAMS, 0);
  assert.equal(result.nextState.phase, 'pending_open');
  state = result.nextState;

  result = stepWindow(state, input({ slopePerHour: -3.5 }), AUTO_PARAMS, 30_000);
  assert.equal(result.nextState.phase, 'open');
  assert.equal(result.active, true);
});

test('mode auto : fin de détection sur le seuil de fermeture', () => {
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ slopePerHour: -3.5 }), AUTO_PARAMS, 0));
  ({ nextState: state } = stepWindow(state, input({ slopePerHour: -3.5 }), AUTO_PARAMS, 30_000));
  assert.equal(state.phase, 'open');

  let result = stepWindow(state, input({ slopePerHour: 0.1 }), AUTO_PARAMS, 40_000);
  assert.equal(result.nextState.phase, 'pending_close');
  state = result.nextState;

  result = stepWindow(state, input({ slopePerHour: 0.1 }), AUTO_PARAMS, 70_000);
  assert.equal(result.nextState.phase, 'closed');
  assert.equal(result.active, false);
});

test('mode auto : durée maximale force la fermeture même si la chute continue', () => {
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ slopePerHour: -5 }), AUTO_PARAMS, 0));
  ({ nextState: state } = stepWindow(state, input({ slopePerHour: -5 }), AUTO_PARAMS, 30_000));
  assert.equal(state.phase, 'open');
  assert.equal(state.openSinceMs, 30_000);

  // La chute continue sans jamais franchir le seuil de fermeture, mais la durée max est atteinte.
  const forcedMs = 30_000 + AUTO_PARAMS.autoMaxDurationSec * 1000;
  const forced = stepWindow(state, input({ slopePerHour: -5 }), AUTO_PARAMS, forcedMs);
  assert.equal(forced.nextState.phase, 'closed');
  assert.equal(forced.active, false);

  // Comportement choisi : pas de réouverture instantanée sur la même chute. Au tick suivant,
  // même avec la pente toujours sous le seuil, on repasse par `pending_open` (donc par son délai)
  // plutôt que de rouvrir immédiatement.
  const next = stepWindow(forced.nextState, input({ slopePerHour: -5 }), AUTO_PARAMS, forcedMs + 1);
  assert.equal(next.nextState.phase, 'pending_open');
  assert.equal(next.active, false);
});

test('mode auto : pente null n\'a aucun effet', () => {
  let state = createWindowState();
  for (let t = 0; t < 5; t += 1) {
    const result = stepWindow(state, input({ slopePerHour: null }), AUTO_PARAMS, t * 10_000);
    assert.equal(result.nextState.phase, 'closed');
    assert.equal(result.active, false);
    state = result.nextState;
  }
});

// --- Mode off ------------------------------------------------------------

test('mode off : toujours inactif, état remis à closed', () => {
  const dirtyState: WindowState = { phase: 'open', phaseSinceMs: 100, openSinceMs: 50 };
  const result = stepWindow(dirtyState, input({ sensorOpen: true }), { ...SENSOR_PARAMS, mode: 'off' }, 200);
  assert.equal(result.active, false);
  assert.equal(result.action, null);
  assert.deepEqual(result.nextState, createWindowState());
});

// --- Bypass ----------------------------------------------------------------

test('bypass : neutralise active/action mais l\'état interne continue de suivre le capteur', () => {
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0));
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 30_000));
  assert.equal(state.phase, 'open');

  const withoutBypass = stepWindow(state, input({ sensorOpen: false }), SENSOR_PARAMS, 40_000);
  const withBypass = stepWindow(state, input({ sensorOpen: false, bypass: true }), SENSOR_PARAMS, 40_000);

  assert.equal(withBypass.active, false);
  assert.equal(withBypass.action, null);
  // L'état interne progresse exactement comme sans bypass : la levée du bypass reprendra au bon endroit.
  assert.deepEqual(withBypass.nextState, withoutBypass.nextState);
});

// --- Pureté ------------------------------------------------------------------

test('état non muté : l\'état passé en entrée n\'est jamais modifié', () => {
  const state: WindowState = createWindowState();
  Object.freeze(state);

  assert.doesNotThrow(() => {
    stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0);
  });
});
