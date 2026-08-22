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

  // La fermeture forcée DÉSARME la détection jusqu'au rétablissement de la pente. Le seul délai
  // de confirmation ne suffisait pas : couper le chauffage une demi-heure garantit que la pièce
  // descend encore, donc que le signal d'ouverture est toujours vrai à la levée — la détection se
  // rouvrait trente secondes plus tard et la pièce n'était jamais rendue au chauffage.
  assert.equal(forced.nextState.autoDisarmed, true);

  const next = stepWindow(forced.nextState, input({ slopePerHour: -5 }), AUTO_PARAMS, forcedMs + 1);
  assert.equal(next.nextState.phase, 'closed', 'toujours désarmé : aucune nouvelle détection');
  assert.equal(next.active, false);

  // Même une demi-heure plus tard, tant que la pièce descend encore.
  const later = stepWindow(next.nextState, input({ slopePerHour: -5 }), AUTO_PARAMS, forcedMs + 1_800_000);
  assert.equal(later.nextState.phase, 'closed');
  assert.equal(later.active, false);
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
  const dirtyState: WindowState = { phase: 'open', phaseSinceMs: 100, openSinceMs: 50, autoDisarmed: true };
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

// --- Le capteur qui se tait ---------------------------------------------------
//
// PANNE EMPÊCHÉE : une pièce figée en hors-gel, indéfiniment, sans avertissement. En mode capteur
// la fermeture forcée sur durée maximale ne s'applique pas — c'est une garantie du mode auto — et
// la phase `open` n'avait donc plus aucune sortie dès que le contact cessait de répondre.

test('mode capteur : un contact devenu illisible LIBÈRE la pièce', () => {
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0));
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 30_000));
  assert.equal(state.phase, 'open');

  // L'appareil disparaît : ré-appairé sous un nouvel identifiant, hors du cache, valeur illisible.
  const gone = stepWindow(state, input({ sensorOpen: null }), SENSOR_PARAMS, 40_000);
  assert.equal(gone.nextState.phase, 'pending_close', 'la détection commence à se lever');

  const closed = stepWindow(gone.nextState, input({ sensorOpen: null }), SENSOR_PARAMS, 70_000);
  assert.equal(closed.nextState.phase, 'closed');
  assert.equal(closed.active, false, 'le chauffage est rendu à la pièce');
});

test('mode capteur sans contact lié : la détection ne s\'arme jamais', () => {
  // Le cas le plus direct : l'utilisateur bascule le mode sur `capteur` sans avoir lié de contact.
  let state = createWindowState();
  for (const t of [0, 30_000, 60_000, 3_600_000]) {
    ({ nextState: state } = stepWindow(state, input({ sensorOpen: null }), SENSOR_PARAMS, t));
    assert.equal(state.phase, 'closed');
  }
});

test('mode capteur : un état `open` hérité se referme au premier pas', () => {
  // L'état est persisté. Une pièce déjà bloquée par l'ancienne version doit se libérer seule après
  // la mise à jour, sans intervention.
  const stuck: WindowState = {
    phase: 'open', phaseSinceMs: 0, openSinceMs: 0, autoDisarmed: false,
  };
  const first = stepWindow(stuck, input({ sensorOpen: null }), SENSOR_PARAMS, 10_000);
  assert.equal(first.nextState.phase, 'pending_close');

  const second = stepWindow(first.nextState, input({ sensorOpen: null }), SENSOR_PARAMS, 41_000);
  assert.equal(second.nextState.phase, 'closed');
  assert.equal(second.active, false);
});

test('un capteur qui affirme « ouvert » est toujours cru', () => {
  // La contrepartie : assouplir la fermeture ne doit pas affaiblir la détection elle-même.
  let state = createWindowState();
  ({ nextState: state } = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 0));
  const open = stepWindow(state, input({ sensorOpen: true }), SENSOR_PARAMS, 30_000);
  assert.equal(open.nextState.phase, 'open');
  assert.equal(open.active, true);
});

// --- Le désarmement du mode auto ---------------------------------------------

test('mode auto : le désarmement se lève dès que la pente se rétablit', () => {
  const disarmed: WindowState = {
    phase: 'closed', phaseSinceMs: 0, openSinceMs: null, autoDisarmed: true,
  };

  // La pièce se réchauffe : le signal de fermeture est vrai, la détection se réarme.
  const rearmed = stepWindow(disarmed, input({ slopePerHour: 1 }), AUTO_PARAMS, 1_000);
  assert.equal(rearmed.nextState.autoDisarmed, false);

  // Et une VRAIE chute est de nouveau détectée.
  const detected = stepWindow(rearmed.nextState, input({ slopePerHour: -5 }), AUTO_PARAMS, 2_000);
  assert.equal(detected.nextState.phase, 'pending_open');
});
