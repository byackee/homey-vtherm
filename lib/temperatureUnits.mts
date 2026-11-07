/**
 * Les unités d'une température venue d'un autre appareil.
 *
 * Tout le noyau raisonne en °C, et Homey convertit lui-même l'affichage selon la préférence de
 * l'utilisateur. Mais une app tierce peut déclarer sa capability en °F (`units` de la capability) :
 * sa valeur est alors bien en °F. Prise telle quelle, une pièce à 72,8 °F devenait 72,8 °C — le
 * thermostat ne chauffait plus, et Homey l'affichait à 163 °F (retour du forum, novembre 2026).
 */

import { matchesCapability } from './capabilityMatch.mjs';
import type { CapValue } from './writePolicy.mjs';

/** Les seules capabilities converties : `F` peut désigner autre chose ailleurs, des farads par exemple. */
export function isTemperatureCapability(capabilityId: string): boolean {
  return matchesCapability([capabilityId], 'measure_temperature')
    || matchesCapability([capabilityId], 'target_temperature');
}

/** Vrai si `units`, tel que l'API des appareils le donne, désigne le degré Fahrenheit. */
export function isFahrenheit(units: unknown): boolean {
  if (typeof units !== 'string') return false;
  const normalized = units.replace(/[\s°º˚]/g, '').toUpperCase();
  return normalized === 'F' || normalized === '℉' || normalized === 'FAHRENHEIT';
}

/**
 * Une valeur lue sur un appareil, ramenée en °C.
 *
 * Au centième : assez fin pour que `valueToHomey` n'introduise aucun écart sur une consigne au pas
 * de 0,5 °C, ce dont dépend la reconnaissance des échos dans `runtime/emitter.mts`.
 */
export function valueFromHomey(value: CapValue, units: unknown): CapValue {
  if (typeof value !== 'number' || !isFahrenheit(units)) return value;
  return Math.round((value - 32) / 1.8 * 100) / 100;
}

/** Une valeur à écrire sur un appareil, exprimée dans son unité. */
export function valueToHomey(value: CapValue, units: unknown): CapValue {
  if (typeof value !== 'number' || !isFahrenheit(units)) return value;
  return Math.round((value * 1.8 + 32) * 10) / 10;
}
