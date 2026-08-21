import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMotionState, resolveSetpoint, updateMotion,
} from '../lib/presetResolver.mjs';
import type {
  MotionConfig, MotionState, PresetInput, TimedPreset,
} from '../lib/types.mjs';
import { DEFAULT_AWAY_TEMPS, DEFAULT_PRESET_TEMPS } from '../lib/constants.mjs';

const MOTION_ON: MotionConfig = {
  enabled: true, motionPreset: 'comfort', noMotionPreset: 'eco', delaySec: 30, offDelaySec: 300,
};
const MOTION_OFF: MotionConfig = {
  enabled: false, motionPreset: 'comfort', noMotionPreset: 'eco', delaySec: 30, offDelaySec: 300,
};

function baseInput(overrides: Partial<PresetInput> = {}): PresetInput {
  return {
    preset: 'comfort',
    manualSetpoint: 18.5,
    presetTemps: DEFAULT_PRESET_TEMPS,
    awayTemps: DEFAULT_AWAY_TEMPS,
    presence: true,
    motion: MOTION_OFF,
    motionState: createMotionState(),
    timedPreset: null,
    ...overrides,
  };
}

// --- Presets simples ---------------------------------------------------------

test('chaque preset renvoie sa température', () => {
  for (const preset of ['frost', 'eco', 'comfort', 'boost'] as const) {
    const result = resolveSetpoint(baseInput({ preset }), 0);
    assert.equal(result.setpoint, DEFAULT_PRESET_TEMPS[preset]);
    assert.equal(result.effectivePreset, preset);
  }
});

test('preset none renvoie la consigne manuelle', () => {
  const result = resolveSetpoint(baseInput({ preset: 'none', manualSetpoint: 21.5 }), 0);
  assert.equal(result.setpoint, 21.5);
  assert.equal(result.effectivePreset, 'none');
  assert.equal(result.away, false);
});

// --- Absence -------------------------------------------------------------------

test('absence : consigne "absence" du preset, sans changer le preset affiché', () => {
  const result = resolveSetpoint(baseInput({ preset: 'comfort', presence: false }), 0);
  assert.equal(result.setpoint, DEFAULT_AWAY_TEMPS.comfort);
  assert.equal(result.effectivePreset, 'comfort');
  assert.equal(result.away, true);
});

test('presence null : jamais d\'absence', () => {
  const result = resolveSetpoint(baseInput({ preset: 'comfort', presence: null }), 0);
  assert.equal(result.setpoint, DEFAULT_PRESET_TEMPS.comfort);
  assert.equal(result.away, false);
});

test('hors-gel non affecté par l\'absence', () => {
  const present = resolveSetpoint(baseInput({ preset: 'frost', presence: true }), 0);
  const away = resolveSetpoint(baseInput({ preset: 'frost', presence: false }), 0);
  assert.equal(present.setpoint, DEFAULT_PRESET_TEMPS.frost);
  assert.equal(away.setpoint, DEFAULT_PRESET_TEMPS.frost);
  assert.equal(away.away, true);
});

test('preset none ignore l\'absence (aucune substitution)', () => {
  const result = resolveSetpoint(baseInput({ preset: 'none', manualSetpoint: 19, presence: false }), 0);
  assert.equal(result.setpoint, 19);
  assert.equal(result.away, false);
});

// --- Preset Activité -------------------------------------------------------------

test('preset Activité indisponible quand motion.enabled est faux', () => {
  const result = resolveSetpoint(baseInput({ preset: 'activity', motion: MOTION_OFF }), 0);
  assert.equal(result.activity, false);
  assert.equal(result.effectivePreset, 'none');
  assert.equal(result.setpoint, 18.5); // repli sur la consigne manuelle
});

test('Activité suit le mouvement confirmé', () => {
  const confirmedDetected: MotionState = { raw: true, confirmed: true, pendingSinceMs: null };
  const confirmedAbsent: MotionState = { raw: false, confirmed: false, pendingSinceMs: null };

  const detected = resolveSetpoint(
    baseInput({ preset: 'activity', motion: MOTION_ON, motionState: confirmedDetected }),
    0,
  );
  assert.equal(detected.activity, true);
  assert.equal(detected.effectivePreset, 'comfort');
  assert.equal(detected.setpoint, DEFAULT_PRESET_TEMPS.comfort);

  const absent = resolveSetpoint(
    baseInput({ preset: 'activity', motion: MOTION_ON, motionState: confirmedAbsent }),
    0,
  );
  assert.equal(absent.activity, true);
  assert.equal(absent.effectivePreset, 'eco');
  assert.equal(absent.setpoint, DEFAULT_PRESET_TEMPS.eco);
});

test('Activité combinée à l\'absence utilise la température absence du preset résolu', () => {
  const confirmedDetected: MotionState = { raw: true, confirmed: true, pendingSinceMs: null };
  const result = resolveSetpoint(
    baseInput({
      preset: 'activity', motion: MOTION_ON, motionState: confirmedDetected, presence: false,
    }),
    0,
  );
  assert.equal(result.effectivePreset, 'comfort');
  assert.equal(result.away, true);
  assert.equal(result.setpoint, DEFAULT_AWAY_TEMPS.comfort);
});

// --- Preset temporisé -------------------------------------------------------------

test('preset temporisé prime sur le preset choisi tant qu\'il n\'a pas expiré', () => {
  const timedPreset: TimedPreset = { preset: 'boost', untilMs: 10_000, previous: 'eco' };
  const result = resolveSetpoint(baseInput({ preset: 'comfort', timedPreset }), 5_000);
  assert.equal(result.effectivePreset, 'boost');
  assert.equal(result.setpoint, DEFAULT_PRESET_TEMPS.boost);
  assert.equal(result.timedExpired, false);
});

test('preset temporisé expiré restaure le preset précédent', () => {
  const timedPreset: TimedPreset = { preset: 'boost', untilMs: 10_000, previous: 'eco' };

  const juste_avant = resolveSetpoint(baseInput({ preset: 'comfort', timedPreset }), 9_999);
  assert.equal(juste_avant.timedExpired, false);
  assert.equal(juste_avant.effectivePreset, 'boost');

  const expire = resolveSetpoint(baseInput({ preset: 'comfort', timedPreset }), 10_000);
  assert.equal(expire.timedExpired, true);
  assert.equal(expire.effectivePreset, 'eco');
  assert.equal(expire.setpoint, DEFAULT_PRESET_TEMPS.eco);
});

// --- Mouvement ---------------------------------------------------------------------

test('mouvement : confirmation après delaySec', () => {
  const config = MOTION_ON;
  let state = createMotionState();
  state = updateMotion(state, true, config, 0);
  assert.equal(state.confirmed, false);
  state = updateMotion(state, true, config, 29_999);
  assert.equal(state.confirmed, false);
  state = updateMotion(state, true, config, 30_000);
  assert.equal(state.confirmed, true);
});

test('mouvement : pas de confirmation si le mouvement cesse avant le délai', () => {
  const config = MOTION_ON;
  let state = createMotionState();
  state = updateMotion(state, true, config, 0);
  state = updateMotion(state, false, config, 10_000); // cesse avant les 30s
  assert.equal(state.confirmed, false);
  assert.equal(state.pendingSinceMs, null);
});

test('mouvement : retour à non-détecté après offDelaySec', () => {
  const config = MOTION_ON;
  let state: MotionState = { raw: true, confirmed: true, pendingSinceMs: null };
  state = updateMotion(state, false, config, 1_000);
  assert.equal(state.confirmed, true);
  state = updateMotion(state, false, config, 1_000 + 299_999);
  assert.equal(state.confirmed, true);
  state = updateMotion(state, false, config, 1_000 + 300_000);
  assert.equal(state.confirmed, false);
});

test('mouvement : une réapparition avant la fin de offDelaySec annule la temporisation', () => {
  const config = MOTION_ON;
  let state: MotionState = { raw: true, confirmed: true, pendingSinceMs: null };
  state = updateMotion(state, false, config, 1_000); // début de l'absence
  state = updateMotion(state, true, config, 1_000 + 100_000); // réapparaît bien avant 300s
  assert.equal(state.confirmed, true);
  assert.equal(state.pendingSinceMs, null);

  // Et l'absence qui suit doit repartir d'un compteur frais (depuis cette nouvelle divergence),
  // pas reprendre l'ancien décompte entamé avant la réapparition.
  const t0 = 1_000 + 100_000;
  state = updateMotion(state, false, config, t0); // nouvelle divergence, compteur frais
  assert.equal(state.confirmed, true);
  state = updateMotion(state, false, config, t0 + 299_999);
  assert.equal(state.confirmed, true);
  state = updateMotion(state, false, config, t0 + 300_000);
  assert.equal(state.confirmed, false);
});
