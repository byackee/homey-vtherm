/**
 * Algorithme TPI (SPEC §4) : calcule le pourcentage de puissance du cycle à partir des écarts
 * de température intérieure et extérieure, puis applique les seuils de dépassement de VT.
 *
 * Le calcul est **sans état**. Il n'y a chez VT (`prop_algo_tpi.py`) aucun verrou de coupure à
 * conserver d'un pas à l'autre : une première rédaction avait inventé un `TpiState { cutOff }`
 * d'hystérésis, qui gelait la chauffe jusqu'au seuil bas alors que VT réévalue tout à chaque pas.
 */

import type { TpiInput, TpiParams, TpiResult } from './types.mjs';

export function computeOnPercent(input: TpiInput, params: TpiParams): TpiResult {
  const {
    setpoint, roomTemp, outdoorTemp, slopePerHour,
  } = input;
  const {
    coefInt, coefExt, thresholdHigh, thresholdLow,
  } = params;

  // Sans capteur extérieur, le terme externe est nul — pas une valeur inventée (SPEC §4).
  const extTerm = outdoorTemp === null ? 0 : coefExt * (setpoint - outdoorTemp);
  let onPercent = coefInt * (setpoint - roomTemp) + extTerm;
  onPercent = Math.min(1, Math.max(0, onPercent));

  /*
   * Seuils de dépassement — NE PAS transformer en hystérésis.
   *
   * Chez VT les deux seuils ne se répondent pas : ils s'appliquent tous les deux à la MÊME
   * grandeur (`roomTemp − setpoint`), et c'est le SIGNE DE LA PENTE qui décide lequel arbitre.
   * Pente montante : on tolère `thresholdHigh` de dépassement avant de couper. Pente descendante :
   * la pièce redescend d'elle-même, on coupe donc dès `thresholdLow` (typiquement plus petit).
   * Pente nulle ou inconnue : aucun effet, le calcul nominal passe tel quel.
   *
   * Les deux seuils vont par paire : si l'un est à 0, la fonction entière est désactivée.
   */
  if (thresholdHigh !== 0 && thresholdLow !== 0 && slopePerHour !== null) {
    const overshoot = roomTemp - setpoint;
    if (slopePerHour > 0 && overshoot > thresholdHigh) {
      onPercent = 0;
    } else if (slopePerHour < 0 && overshoot > thresholdLow) {
      onPercent = 0;
    }
  }

  return { onPercent };
}
