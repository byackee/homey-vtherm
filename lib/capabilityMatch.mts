/**
 * Correspondance entre une capability recherchée et celles qu'un appareil expose.
 */

/**
 * Vrai si `capabilities` contient `wanted`, sous-capability comprise.
 *
 * Homey autorise les sous-capabilities pointées, et les apps s'en servent : une SONOFF TRVZB
 * exposée par Zigbee2MQTT n'a pas `target_temperature` mais `target_temperature.local`. Une
 * comparaison exacte rendait les cinq vannes de l'installation de référence invisibles à la
 * sélection d'émetteur — c'est-à-dire précisément les appareils que l'app existe pour piloter,
 * et le symptôme était une liste presque vide sans le moindre message d'erreur.
 *
 * Le point est exigé explicitement : chercher `measure_temperature` ne doit pas ramener un
 * hypothétique `measure_temperature_offset`.
 */
export function matchesCapability(capabilities: readonly string[], wanted: string): boolean {
  const prefix = `${wanted}.`;
  return capabilities.some((id) => id === wanted || id.startsWith(prefix));
}

/**
 * L'identifiant exact à utiliser pour lire ou écrire, parmi ceux que l'appareil expose.
 *
 * La sous-capability est préférée à la capability nue quand les deux existent : c'est elle qui
 * porte la valeur réelle sur les appareils qui font la distinction.
 */
export function resolveCapabilityId(
  capabilities: readonly string[],
  wanted: string,
): string | null {
  const prefix = `${wanted}.`;
  const sub = capabilities.find((id) => id.startsWith(prefix));
  if (sub !== undefined) return sub;
  return capabilities.includes(wanted) ? wanted : null;
}
