import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_RULES, resolveStateLabel } from '../lib/stateLabel.mjs';
import type { EffectiveState, StateContext } from '../lib/types.mjs';

/** Contexte « rien de particulier » : appareil allumé, aucune priorité active. */
function ctx(overrides: Partial<StateContext> = {}): StateContext {
  return {
    onoff: true,
    centralOverride: false,
    windowActive: false,
    roomSensorMute: false,
    overpowered: false,
    away: false,
    activity: false,
    heating: false,
    ...overrides,
  };
}

// --- La table elle-même -----------------------------------------------------

test('la table est ordonnée exactement comme la SPEC §2.3', () => {
  const expected: EffectiveState[] = [
    'off', 'central', 'window', 'safety', 'power', 'away', 'activity', 'heating', 'idle',
  ];
  assert.deepEqual(STATE_RULES.map((rule) => rule.label), expected);
});

test('la dernière règle est inconditionnelle : resolveStateLabel est totale', () => {
  const last = STATE_RULES[STATE_RULES.length - 1];
  assert.ok(last !== undefined);
  assert.equal(last.label, 'idle');
  assert.equal(last.when(ctx()), true);
});

test('safety et power existent dans la table mais ne se déclenchent jamais en v1', () => {
  const safety = STATE_RULES.find((rule) => rule.label === 'safety');
  const power = STATE_RULES.find((rule) => rule.label === 'power');
  assert.ok(safety !== undefined);
  assert.ok(power !== undefined);

  // Même avec les drapeaux prévus pour eux positionnés, la v1 ne les active pas.
  const armed = ctx({ roomSensorMute: true, overpowered: true });
  assert.equal(safety.when(armed), false);
  assert.equal(power.when(armed), false);
  assert.equal(resolveStateLabel(armed), 'idle');
});

// --- Résolution -------------------------------------------------------------

test('cas nominal : ni demande ni priorité, l\'état est idle', () => {
  assert.equal(resolveStateLabel(ctx()), 'idle');
});

test('une demande en cours donne heating', () => {
  assert.equal(resolveStateLabel(ctx({ heating: true })), 'heating');
});

test('off prime sur absolument tout', () => {
  const everything = ctx({
    onoff: false,
    centralOverride: true,
    windowActive: true,
    away: true,
    activity: true,
    heating: true,
  });
  assert.equal(resolveStateLabel(everything), 'off');
});

test('central prime sur la fenêtre', () => {
  assert.equal(resolveStateLabel(ctx({ centralOverride: true, windowActive: true })), 'central');
});

test('la fenêtre prime sur absence, activité et chauffe', () => {
  const c = ctx({
    windowActive: true, away: true, activity: true, heating: true,
  });
  assert.equal(resolveStateLabel(c), 'window');
});

test('l\'absence prime sur l\'activité quand les deux sont vraies', () => {
  assert.equal(resolveStateLabel(ctx({ away: true, activity: true })), 'away');
});

test('activity prime sur heating : l\'origine de la consigne est plus informative que la chauffe', () => {
  assert.equal(resolveStateLabel(ctx({ activity: true, heating: true })), 'activity');
});

test('chaque étiquette de la table est atteignable par son propre drapeau', () => {
  assert.equal(resolveStateLabel(ctx({ onoff: false })), 'off');
  assert.equal(resolveStateLabel(ctx({ centralOverride: true })), 'central');
  assert.equal(resolveStateLabel(ctx({ windowActive: true })), 'window');
  assert.equal(resolveStateLabel(ctx({ away: true })), 'away');
  assert.equal(resolveStateLabel(ctx({ activity: true })), 'activity');
  assert.equal(resolveStateLabel(ctx({ heating: true })), 'heating');
});

test('ajouter safety en v1.1 est bien l\'édition d\'une seule ligne', () => {
  // Simulation de l'édition prévue : on remplace la condition constante par la vraie.
  const patched = STATE_RULES.map((rule) => (rule.label === 'safety'
    ? { label: rule.label, when: (c: StateContext) => c.roomSensorMute }
    : rule));

  const resolve = (c: StateContext): EffectiveState => patched.find((r) => r.when(c))?.label ?? 'idle';

  // Le capteur muet devient `safety`, sans toucher aux priorités voisines.
  assert.equal(resolve(ctx({ roomSensorMute: true })), 'safety');
  assert.equal(resolve(ctx({ roomSensorMute: true, windowActive: true })), 'window');
  assert.equal(resolve(ctx({ roomSensorMute: true, away: true })), 'safety');
});
