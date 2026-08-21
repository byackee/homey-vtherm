/**
 * Auto-régulation par offset de consigne (SPEC §5.2), pour les émetteurs sans vanne pilotable.
 */

import type {
  RegulationInput, RegulationMode, RegulationParams, RegulationResult, RegulationState,
} from './types.mjs';
import { REGULATION_PRESETS } from './constants.mjs';

export function createRegulationState(): RegulationState {
  return { accumulatedError: 0, lastErrorSign: 0 };
}

export function resolveRegulationParams(mode: RegulationMode, expert: RegulationParams): RegulationParams {
  if (mode === 'expert') {
    return expert;
  }
  return REGULATION_PRESETS[mode];
}

function sign(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeOffset(input: RegulationInput, params: RegulationParams, state: RegulationState): RegulationResult {
  const {
    setpoint, roomTemp, outdoorTemp, dtCycles,
  } = input;
  const {
    kp, ki, kExt, offsetMax, accumulatedErrorThreshold, overheatProtection,
  } = params;

  /*
   * Pas de capteur extérieur ⇒ AUCUNE auto-régulation.
   *
   * C'est le comportement de VT (`pi_algorithm.py`), et c'est un choix, pas un cas dégradé :
   * appliquer kp et ki en mettant seulement le terme externe à zéro reviendrait à réguler avec
   * une moitié de formule, donc à inventer un offset. L'état reste figé — l'intégrale ne doit pas
   * accumuler pendant que la régulation est suspendue.
   */
  if (outdoorTemp === null) {
    return { offset: 0, nextState: { ...state } };
  }

  const erreur = setpoint - roomTemp;
  const erreurSign = sign(erreur);

  /*
   * Pondération temporelle de l'accumulation : VT fait `accumulated_error += error * time_delta`,
   * où `time_delta` est l'intervalle écoulé exprimé en cycles. Au-delà de 2 cycles, VT le ramène
   * à 1.0 — un long trou (app arrêtée, capteur muet) ne doit pas se traduire par un à-coup
   * d'intégrale proportionnel au trou. Sans cette pondération, un pas déclenché hors cycle
   * (changement de consigne, nouvelle mesure) pèserait autant qu'un cycle complet.
   */
  const dt = dtCycles > 2.0 ? 1.0 : dtCycles;

  let accumulatedError = state.accumulatedError;
  // Inversion de signe sous protection surchauffe : on décharge l'accumulation avant d'ajouter.
  const signInverted = state.lastErrorSign !== 0 && erreurSign !== 0 && state.lastErrorSign !== erreurSign;
  if (overheatProtection && signInverted) {
    // Diviseur `2 × max(dt, 0.5)` et non 2 : la décharge suit la même horloge que la charge.
    // Le plancher de 0,5 empêche une rafale de pas rapprochés de vider l'intégrale d'un coup.
    accumulatedError /= 2 * Math.max(dt, 0.5);
  }
  accumulatedError = clamp(
    accumulatedError + erreur * dt,
    -accumulatedErrorThreshold,
    accumulatedErrorThreshold,
  );

  /*
   * Terme externe : `roomTemp − outdoorTemp`, PAS `setpoint − outdoorTemp`.
   *
   * Les deux ne coïncident que lorsque la pièce est déjà à la consigne ; l'écart grandit
   * précisément quand on chauffe, c'est-à-dire quand ce terme compte. Il modélise les pertes
   * réelles de la pièce vers l'extérieur, qui dépendent de la température qu'elle a, pas de
   * celle qu'on lui souhaite.
   */
  const extTerm = kExt * (roomTemp - outdoorTemp);
  let offset = kp * erreur + ki * accumulatedError + extTerm;
  offset = clamp(offset, -offsetMax, offsetMax);

  return {
    offset,
    nextState: { accumulatedError, lastErrorSign: erreurSign },
  };
}
