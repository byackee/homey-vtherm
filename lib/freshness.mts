/**
 * Datation et fraîcheur d'une lecture de capteur.
 *
 * Extrait de `runtime/hub.mts` pour être testable sans Homey : ce fichier porte les deux décisions
 * qui déterminent si la régulation pilote une vraie mesure ou une valeur morte —
 *  1. d'où vient l'horodatage d'une lecture (jamais de l'horloge courante) ;
 *  2. à partir de quel âge cette lecture cesse d'être croyable.
 *
 * Pur : aucune référence à Homey, aucune lecture d'horloge (`nowMs` est toujours un paramètre).
 */

/**
 * Origine retenue pour l'horodatage, dans l'ordre de préférence.
 *
 * - `lastUpdated` : `capabilitiesObj[capId].lastUpdated`. Champ mis à jour en place par le
 *   websocket `homey-api`, donc la source la plus proche de l'émetteur réel.
 * - `lastChanged` : `DeviceCapability.lastChanged`. Dérivé du `transactionTime` de l'émetteur, il
 *   vaut `null` dès que celui-ci ne l'envoie pas : jamais s'y fier seul.
 * - `listener` : instant où le listener a effectivement tiré. Dernier recours, mais honnête —
 *   c'est un minorant de l'âge réel, pas une valeur inventée.
 */
export type TimestampSource = 'lastUpdated' | 'lastChanged' | 'listener';

export interface TimestampCandidates {
  lastUpdatedMs: number | null;
  lastChangedMs: number | null;
  listenerFiredAtMs: number | null;
}

export interface ResolvedTimestamp {
  atMs: number;
  /** Conservée pour le journal : sans elle, un « pourquoi cette mesure paraît fraîche » est indiagnosticable. */
  source: TimestampSource;
}

/**
 * Convertit en millisecondes d'époque ce que `homey-api` peut mettre dans un champ de date.
 *
 * `Device.transformGet` convertit `lastUpdated` en `Date`, mais `DeviceCapability.setValue` y
 * réinjecte un nombre et le websocket une chaîne ISO : les trois formes existent réellement.
 * Tout le reste — `null`, `undefined`, `NaN`, date invalide, époque 0 — retourne `null`, car une
 * date fausse acceptée ici deviendrait une lecture éternellement fraîche.
 */
export function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/**
 * Choisit l'horodatage d'une lecture parmi les trois sources disponibles.
 *
 * Retourne `null` quand aucune source n'est exploitable. C'est volontaire et c'est le point le plus
 * important du fichier : `Date.now()` par défaut produirait une lecture qui ne paraîtrait JAMAIS
 * périmée, donc une régulation qui continuerait à chauffer sur un capteur muet depuis des heures.
 * Une lecture non datable est une lecture absente.
 */
export function resolveTimestamp(candidates: TimestampCandidates): ResolvedTimestamp | null {
  const { lastUpdatedMs, lastChangedMs, listenerFiredAtMs } = candidates;

  if (lastUpdatedMs !== null) return { atMs: lastUpdatedMs, source: 'lastUpdated' };
  if (lastChangedMs !== null) return { atMs: lastChangedMs, source: 'lastChanged' };
  if (listenerFiredAtMs !== null) return { atMs: listenerFiredAtMs, source: 'listener' };

  return null;
}

export interface StaleInput {
  atMs: number;
  nowMs: number;
  /**
   * Seuil de fraîcheur fourni par l'APPELANT, par nature de source — jamais un seuil global :
   * un capteur de température dans une pièce stable se tait légitimement vingt minutes, un contact
   * de fenêtre des jours entiers. `Infinity` désactive le critère d'âge.
   */
  freshnessMs: number;
  /** `device.available`. Un appareil indisponible rend sa lecture inutilisable quel que soit son âge. */
  available: boolean;
}

/** Vrai quand la lecture ne doit plus être crue. */
export function computeStale(input: StaleInput): boolean {
  const { atMs, nowMs, freshnessMs, available } = input;

  // Règle non négociable : indisponible ⇒ périmé, même horodaté à l'instant.
  if (!available) return true;

  // Horodatage aberrant : traité comme périmé plutôt que comme frais.
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return true;

  // Un horodatage dans le futur (dérive d'horloge de l'émetteur) n'est pas une raison de périmer.
  const ageMs = Math.max(0, nowMs - atMs);

  return ageMs > freshnessMs;
}
