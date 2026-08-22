/**
 * Les textes d'explication des pages de réglages, et le filtre qui évite de les réécrire.
 *
 * Homey affiche un réglage de type `label` en montrant sa VALEUR. Le `hint` ne sort que dans
 * l'infobulle ⓘ. Les explications ont d'abord été écrites dans le `hint`, avec une valeur vide :
 * chaque groupe montrait donc un cadre gris vide, et l'explication n'existait que pour qui pensait
 * à survoler un ⓘ. Le texte doit vivre dans la valeur — que seul le code peut remplir, puisqu'une
 * valeur par défaut de `driver.settings.compose.json` n'est pas traduisible.
 *
 * D'où ce module : il compose ce que les appareils doivent écrire, et rien d'autre. Aucune
 * référence à Homey — la traduction arrive par une fonction, ce qui rend le tout testable.
 */

/** Les groupes du thermostat qui portent une explication, dans l'ordre de la page. */
export const VTHERM_EXPLAIN_IDS = [
  'presets_hint', 'away_hint', 'tpi_hint', 'regulation_hint', 'expert_hint',
  'window_hint', 'presence_hint', 'central_hint', 'emitter_hint', 'safety_hint',
] as const;

/** L'appareil chaudière n'a qu'un groupe à expliquer. */
export const CENTRAL_EXPLAIN_IDS = ['boiler_hint'] as const;

/** Sépare les sources d'un thermostat sur une seule ligne (voir `joinLinkedLabels`). */
export const LINKED_SEPARATOR = '  ·  ';

/**
 * Assemble les appareils liés en une valeur lisible.
 *
 * Le `\n` d'origine ne survivait pas : Homey rend le champ sur une seule ligne et écrase les
 * retours, ce qui donnait « Room sensor : Detecteur Heater : Valve … Outdoor : … » d'un bloc, où
 * l'œil ne trouve plus où commence chaque source. Un séparateur visible fait le travail que le
 * retour à la ligne ne peut pas faire ici.
 */
export function joinLinkedLabels(lines: readonly string[]): string {
  return lines.join(LINKED_SEPARATOR);
}

/** Le texte attendu dans chaque étiquette, traduit. */
export function explainSettings(
  ids: readonly string[],
  translate: (key: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    out[id] = translate(`settings.explain.${id}`);
  }
  return out;
}

/**
 * Ne garde que ce qui a réellement changé.
 *
 * Les réglages d'un appareil vivent en mémoire flash. Réécrire dix textes identiques à chaque
 * démarrage d'app userait le support pour rien ; ici on ne repasse que sur ce qui diffère, donc
 * en régime établi : rien du tout.
 */
export function changedSettings(
  desired: Record<string, string>,
  current: (key: string) => unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (current(key) !== value) {
      out[key] = value;
    }
  }
  return out;
}
