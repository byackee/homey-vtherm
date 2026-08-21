/**
 * Politique d'écriture vers un appareil tiers.
 *
 * Extrait de `runtime/hub.mts` pour être testable sans Homey.
 *
 * La déduplication est ici une fonction de CORRECTION, pas une optimisation : le quota de l'API
 * Athom se déclenche aussi en production, après quelques dizaines d'appels rapprochés, et un
 * thermostat qui réécrit sa consigne à chaque tick y arrive vite.
 *
 * Le pendant indispensable est `maxIntervalMs`, qui force la réécriture d'une valeur identique :
 * la SPEC §5.3 exige de rafraîchir périodiquement la température injectée dans la vanne, faute de
 * quoi celle-ci retombe sur sa dernière valeur connue. Sans ce rappel, la seule déduplication
 * transformerait le bug en « la vanne dérive lentement au bout d'une heure ».
 *
 * Pur : aucune référence à Homey, aucune lecture d'horloge (`nowMs` est toujours un paramètre).
 */

/** Ce qu'une capability Homey peut porter comme valeur. */
export type CapValue = boolean | number | string;

export interface WriteOptions {
  /**
   * Variation minimale, valeurs numériques seulement. Un écart EXACTEMENT égal au seuil écrit :
   * le pas de consigne de la TRVZB est 0,5 °C et `auto_regulation_dtemp` vaut 0,5, donc un seuil
   * strict ne laisserait jamais passer le cas nominal.
   */
  minDelta?: number;
  /** Intervalle minimal entre deux écritures. */
  minIntervalMs?: number;
  /** Intervalle au-delà duquel on réécrit même une valeur inchangée (SPEC §5.3). */
  maxIntervalMs?: number;
}

/** Dernière écriture réellement partie vers l'appareil. `null` tant qu'il n'y en a eu aucune. */
export interface LastWrite {
  value: CapValue;
  atMs: number;
}

export type WriteDecisionReason =
  /** Première écriture de la liaison : toujours autorisée, sinon la vanne ne partirait jamais. */
  | 'first'
  /** Rappel périodique exigé par `maxIntervalMs`. Prime sur tout le reste. */
  | 'max_interval'
  /** La valeur a changé assez pour justifier un appel. */
  | 'changed'
  /** `minIntervalMs` pas encore écoulé. */
  | 'min_interval'
  /** Écart numérique sous `minDelta`. */
  | 'min_delta'
  /** Valeur strictement identique à la dernière écrite. */
  | 'unchanged';

export interface WriteDecision {
  write: boolean;
  reason: WriteDecisionReason;
}

/**
 * Décide si `next` doit réellement partir vers l'appareil.
 *
 * `last` regroupe volontairement valeur et instant : les passer séparément inviterait à un
 * `(null, 0)` qui ferait passer une première écriture pour une écriture très ancienne.
 *
 * Ordre des règles, et il compte :
 *  1. aucune écriture antérieure ⇒ on écrit ;
 *  2. `maxIntervalMs` écoulé ⇒ on écrit, même valeur inchangée, même `minIntervalMs` non atteint ;
 *  3. `minIntervalMs` non écoulé ⇒ on n'écrit pas ;
 *  4. écart numérique sous `minDelta` ⇒ on n'écrit pas ;
 *  5. valeur identique ⇒ on n'écrit pas.
 */
export function shouldWrite(
  last: LastWrite | null,
  next: CapValue,
  opts: WriteOptions,
  nowMs: number,
): WriteDecision {
  if (last === null) return { write: true, reason: 'first' };

  const elapsedMs = nowMs - last.atMs;
  const { minDelta, minIntervalMs, maxIntervalMs } = opts;

  // Le rappel périodique passe avant les deux garde-fous : c'est lui qui empêche la vanne de
  // retomber sur sa dernière valeur connue. L'inverser réintroduirait exactement le bug de §5.3.
  if (maxIntervalMs !== undefined && maxIntervalMs > 0 && elapsedMs >= maxIntervalMs) {
    return { write: true, reason: 'max_interval' };
  }

  if (minIntervalMs !== undefined && minIntervalMs > 0 && elapsedMs < minIntervalMs) {
    return { write: false, reason: 'min_interval' };
  }

  if (
    minDelta !== undefined
    && minDelta > 0
    && typeof next === 'number'
    && typeof last.value === 'number'
  ) {
    if (Math.abs(next - last.value) < minDelta) return { write: false, reason: 'min_delta' };
    return { write: true, reason: 'changed' };
  }

  if (next === last.value) return { write: false, reason: 'unchanged' };

  return { write: true, reason: 'changed' };
}
