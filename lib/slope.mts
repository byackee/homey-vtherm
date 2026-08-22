/**
 * Pente de température lissée (SPEC §6.2), en °C par heure : signal d'entrée du mode auto de la
 * détection d'ouverture de fenêtre, et entrée obligatoire des seuils du TPI (§4).
 *
 * Le lissage est celui de VT (`open_window_algorithm.py`), et rien d'autre :
 *
 *     pente = arrondi(0,2 × pente_précédente + 0,8 × pente_instantanée, 2)
 *
 * Ce n'est PAS une EMA à demi-vie. Une première rédaction avait repris les `short_ema_params`
 * (`max_alpha` 0,5 ; `halflife` 300 s) de VT, qui lissent chez lui une **température** et non une
 * pente : le facteur y était recalculé à chaque mesure en fonction du delta écoulé, ce qui donnait
 * une pente d'autant plus molle que les mesures étaient rapprochées — exactement l'inverse de ce
 * qu'on veut pour détecter une fenêtre ouverte.
 */

import type { SlopeParams, SlopeResult, SlopeState } from './types.mjs';

export function createSlopeState(): SlopeState {
  return {
    slope: null, lastMs: null, lastTemp: null, sampleCount: 0,
  };
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Garde n°1 — au moins `minSamples` mesures avant de publier quoi que ce soit.
 * Une pente issue de deux points est un bruit de capteur, pas une tendance : c'est ce qui
 * déclenchait une « fenêtre ouverte » au premier courant d'air sur la sonde.
 */
function publishable(state: SlopeState, minSamples: number): number | null {
  return state.sampleCount >= minSamples ? state.slope : null;
}

export function updateSlope(state: SlopeState, temp: number, nowMs: number, params: SlopeParams): SlopeResult {
  const {
    alpha, precision, minSamples, maxAbsSlopePerHour, staleAfterSec,
  } = params;

  // Premier point : rien à dériver, on se contente d'ancrer la série.
  if (state.lastMs === null || state.lastTemp === null) {
    const next: SlopeState = {
      slope: state.slope,
      lastMs: nowMs,
      lastTemp: temp,
      sampleCount: Math.min(state.sampleCount + 1, minSamples),
    };
    return { slopePerHour: publishable(next, minSamples), nextState: next };
  }

  const dtSec = (nowMs - state.lastMs) / 1000;

  /*
   * Horodatage non croissant : aucune dérivée n'est calculée — mais la RÉFÉRENCE est reprise.
   *
   * `lastMs` vient de l'horodatage du CAPTEUR, pas de l'horloge de l'app, et `toEpochMs` accepte
   * toute date positive sans plafond. Une passerelle qui hoquette suffit donc à poser un `lastMs`
   * dans le futur — et l'ancienne version rendait `{ ...state }` tel quel, sans le réparer : toute
   * lecture ultérieure, correctement datée, retombait dans cette même branche. La pente restait
   * figée pour la durée de vie du processus, en silence, alors qu'elle arbitre les seuils TPI et
   * pilote entièrement la détection d'ouverture en mode auto.
   *
   * Reprendre la référence sur la lecture courante défait l'empoisonnement au pas suivant, sans
   * rien inventer : ni pente, ni confiance — `sampleCount` et `slope` sont conservés tels quels.
   */
  if (dtSec <= 0) {
    return {
      slopePerHour: publishable(state, minSamples),
      nextState: { ...state, lastMs: nowMs, lastTemp: temp },
    };
  }

  let instantSlope: number;

  if (dtSec > staleAfterSec) {
    /*
     * Garde n°3 — trou de mesure. Au-delà de `staleAfterSec`, on n'a AUCUNE idée de ce qui s'est
     * passé entre les deux points : dériver sur le trou produirait, au retour du capteur, une
     * pente délirante bâtie sur une demi-journée de silence. VT injecte à la place un point
     * fictif — la dernière température connue, prolongée jusqu'à maintenant — ce qui vaut une
     * pente instantanée nulle sur l'intervalle. La mesure réelle, elle, sert d'ancre au pas
     * suivant : c'est de là que repartira la première vraie dérivée.
     */
    instantSlope = 0;
  } else {
    instantSlope = (temp - state.lastTemp) / (dtSec / 3600);

    /*
     * Garde n°2 — aberration. Au-delà de `maxAbsSlopePerHour` (120 °C/h chez VT), ce n'est pas
     * une pièce qui change de température, c'est un capteur qui ment (valeur par défaut à la
     * reconnexion, trame corrompue). Le point est ignoré et l'état reste STRICTEMENT inchangé :
     * mémoriser la température aberrante comme ancre importerait l'aberration au pas suivant,
     * avec le signe opposé.
     */
    if (Math.abs(instantSlope) > maxAbsSlopePerHour) {
      return { slopePerHour: publishable(state, minSamples), nextState: { ...state } };
    }
  }

  // Pas de pente précédente : on initialise directement sur la pente instantanée.
  const smoothed = state.slope === null
    ? instantSlope
    : (1 - alpha) * state.slope + alpha * instantSlope;

  const next: SlopeState = {
    // L'arrondi porte sur la valeur MÉMORISÉE, comme chez VT : il fait partie du lissage,
    // il n'est pas un simple habillage de sortie.
    slope: roundTo(smoothed, precision),
    lastMs: nowMs,
    lastTemp: temp,
    sampleCount: Math.min(state.sampleCount + 1, minSamples),
  };

  return { slopePerHour: publishable(next, minSamples), nextState: next };
}
