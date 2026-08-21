/**
 * Résolution de la consigne : preset temporisé, preset Activité, absence (SPEC §7-8).
 *
 * Décision de modélisation du preset Activité (SPEC §7) : `'activity'` a été ajouté au type
 * `Preset` (types.mts) comme valeur *sélectionnable* par l'utilisateur, mais il n'a pas de
 * température propre — sa consigne dépend du mouvement. `resolveSetpoint` le résout donc toujours
 * vers un preset concret (`motion.motionPreset` ou `motion.noMotionPreset`) avant de calculer la
 * consigne : `effectivePreset` dans le résultat est donc TOUJOURS l'un de
 * `frost | eco | comfort | boost | none`, jamais `'activity'` littéralement. Le drapeau `activity`
 * du résultat indique que cette résolution a eu lieu (utile pour afficher l'état `activity` côté
 * Homey). Si `motion.enabled` est faux, `'activity'` ne doit jamais être sélectionnable côté
 * appelant ; si on le reçoit quand même, on se replie défensivement sur la consigne manuelle
 * (`effectivePreset: 'none'`, `activity: false`).
 */

import type { MotionConfig, MotionState, Preset, PresetInput, PresetResult } from './types.mjs';

export function createMotionState(): MotionState {
  return { raw: false, confirmed: false, pendingSinceMs: null };
}

export function updateMotion(
  state: MotionState,
  rawDetected: boolean,
  config: MotionConfig,
  nowMs: number,
): MotionState {
  // Le brut rejoint le confirmé : on annule toute temporisation en cours. C'est ce qui fait qu'une
  // réapparition du mouvement avant l'échéance de offDelaySec annule le retour à "non détecté".
  if (rawDetected === state.confirmed) {
    return { raw: rawDetected, confirmed: state.confirmed, pendingSinceMs: null };
  }

  // Divergence par rapport au confirmé : on compte depuis le début de CETTE divergence (fraîche
  // si le brut vient de changer, poursuivie sinon).
  const pendingSinceMs = state.raw === rawDetected ? (state.pendingSinceMs ?? nowMs) : nowMs;
  const delaySec = rawDetected ? config.delaySec : config.offDelaySec;

  if (nowMs - pendingSinceMs >= delaySec * 1000) {
    return { raw: rawDetected, confirmed: rawDetected, pendingSinceMs: null };
  }
  return { raw: rawDetected, confirmed: state.confirmed, pendingSinceMs };
}

export function resolveSetpoint(input: PresetInput, nowMs: number): PresetResult {
  const {
    preset, manualSetpoint, presetTemps, awayTemps, presence, motion, motionState, timedPreset,
  } = input;

  // 1. Preset temporisé : prime sur le preset choisi tant qu'il n'a pas expiré.
  let workingPreset: Preset = preset;
  let timedExpired = false;
  if (timedPreset !== null) {
    if (nowMs >= timedPreset.untilMs) {
      timedExpired = true;
      workingPreset = timedPreset.previous;
    } else {
      workingPreset = timedPreset.preset;
    }
  }

  // 2. Preset Activité : voir décision de modélisation en tête de fichier.
  let activity = false;
  let effectivePreset: Exclude<Preset, 'activity'>;
  if (workingPreset === 'activity') {
    if (motion.enabled) {
      activity = true;
      const base = motionState.confirmed ? motion.motionPreset : motion.noMotionPreset;
      // motionPreset/noMotionPreset sont typés Exclude<Preset, 'none'>, qui inclut techniquement
      // 'activity' depuis son ajout à Preset ; par construction métier ça n'arrive jamais.
      effectivePreset = base === 'activity' ? 'none' : base;
    } else {
      effectivePreset = 'none';
    }
  } else {
    effectivePreset = workingPreset;
  }

  // 3. Preset none : consigne manuelle, aucune substitution — même en cas d'absence.
  if (effectivePreset === 'none') {
    return {
      setpoint: manualSetpoint, effectivePreset, away: false, activity, timedExpired,
    };
  }

  // 4. Absence : température "absence" du preset courant. Le hors-gel n'en a pas de variante.
  if (presence === false) {
    const setpoint = effectivePreset === 'frost' ? presetTemps.frost : awayTemps[effectivePreset];
    return {
      setpoint, effectivePreset, away: true, activity, timedExpired,
    };
  }

  // 5. Cas général.
  return {
    setpoint: presetTemps[effectivePreset], effectivePreset, away: false, activity, timedExpired,
  };
}
