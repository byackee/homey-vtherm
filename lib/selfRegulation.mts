/**
 * Auto-régulation par offset de consigne (SPEC §5.2), pour les émetteurs sans vanne pilotable.
 */

import type {
  RegulationInput, RegulationMode, RegulationParams, RegulationResult, RegulationState,
} from './types.mjs';
import { REGULATION_PRESETS } from './constants.mjs';

export function createRegulationState(): RegulationState {
  return { accumulatedError: 0, lastRegulationAtMs: null };
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
    setpoint, roomTemp, outdoorTemp, dtPeriods, nowMs,
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

  /*
   * LA PORTE : la boucle n'intègre qu'une fois par période de régulation.
   *
   * C'est `check_auto_regulation_period_min` de l'amont, qui manquait. L'ordonnanceur force un pas
   * de TOUS les participants au moindre événement — une mesure qui arrive quelque part réveille
   * tout le logement — si bien que l'intervalle entre deux pas tombait sous une demi-période dans
   * 98 à 100 % des cas dès trois thermostats. Le plancher de la protection surchauffe y ramenait
   * le diviseur à 1 : la protection ne protégeait plus rien, et une intégrale saturée mettait des
   * heures à se résorber là où l'amont y met quelques pas.
   *
   * Les termes proportionnel et extérieur, eux, restent VIVANTS à chaque pas : ils ne dépendent
   * que de la mesure courante, et les figer rendrait l'app sourde à un changement de consigne
   * entre deux périodes. Seule l'intégrale attend son tour. L'écriture vers l'émetteur reste par
   * ailleurs bornée par `auto_regulation_dtemp`, donc ceci n'ajoute aucun appel.
   */
  if (state.lastRegulationAtMs !== null && dtPeriods < 1) {
    const held = clamp(
      kp * erreur + ki * state.accumulatedError + kExt * (roomTemp - outdoorTemp),
      -offsetMax,
      offsetMax,
    );
    return { offset: held, nextState: { ...state } };
  }

  /*
   * Pondération temporelle de l'accumulation : VT fait `accumulated_error += error * time_delta`,
   * où `time_delta` est l'intervalle écoulé exprimé en cycles. Au-delà de 2 cycles, VT le ramène
   * à 1.0 — un long trou (app arrêtée, capteur muet) ne doit pas se traduire par un à-coup
   * d'intégrale proportionnel au trou. Sans cette pondération, un pas déclenché hors cycle
   * (changement de consigne, nouvelle mesure) pèserait autant qu'un cycle complet.
   */
  // Première intégration de la session : on part d'une période pleine plutôt que de zéro.
  const dt = state.lastRegulationAtMs === null || dtPeriods > 2.0 ? 1.0 : dtPeriods;

  let accumulatedError = state.accumulatedError;
  // Inversion de signe sous protection surchauffe : on décharge l'accumulation avant d'ajouter.
  /*
   * Protection surchauffe : l'erreur et l'INTÉGRALE se contredisent.
   *
   * Amont : `error * self.accumulated_error < 0`. Une première transcription comparait l'erreur à
   * l'erreur du pas PRÉCÉDENT, ce qui n'est pas la même chose et se trompe deux fois. D'abord la
   * décharge devenait ponctuelle — une seule division à la traversée, alors qu'elle doit se rejouer
   * tant que les deux désaccordent, ce qui prend l'intégrale des heures à résorber au lieu de
   * quelques pas. Ensuite elle produisait un faux positif : intégrale déjà négative et erreur qui
   * bascule, on coupait en deux une intégrale pourtant correctement signée.
   *
   * L'intégrale est sa propre mémoire : aucun état supplémentaire n'est nécessaire, et le champ
   * `lastErrorSign` qui l'accompagnait — avec son cas particulier de l'erreur exactement nulle —
   * n'était que le symptôme d'avoir choisi la mauvaise variable.
   */
  const signInverted = erreur * state.accumulatedError < 0;
  if (overheatProtection && signInverted) {
    /*
     * Diviseur `2 × max(dt, 0.5)`, transcrit littéralement de la SPEC §5.2.
     *
     * ATTENTION à ce que fait vraiment le plancher, un commentaire antérieur disait l'inverse. Il
     * n'empêche pas une rafale de pas rapprochés de VIDER l'intégrale : sans lui, un pas de 0,1
     * cycle donnerait un diviseur de 0,2, donc une MULTIPLICATION par cinq. Le plancher empêche
     * l'amplification.
     *
     * Mais il a un effet de bord qu'il faut connaître : à `dt ≤ 0,5` le diviseur vaut exactement 1,
     * et la décharge ne décharge alors RIEN. Or l'ordonnanceur force un pas de tous les participants
     * à chaque événement, coalescé à cinq secondes : sur un cycle de cinq minutes, la plupart des
     * pas sont donc bien en dessous de 0,5 cycle. La protection surchauffe est en pratique inerte,
     * et l'intégrale traverse l'inversion à pleine charge. C'est un écart de CONCEPTION hérité de
     * la transcription — VT appelle son régulateur une fois par cycle, donc son `dt` vaut environ
     * 1 et son diviseur environ 2 — et non un défaut de codage : la SPEC et les essais fixent
     * l'un comme l'autre ce comportement. Le corriger demande de trancher la SPEC d'abord.
     */
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
    nextState: { accumulatedError, lastRegulationAtMs: nowMs },
  };
}
