/**
 * Mode sécurité : que faire quand le capteur de pièce se tait (SPEC §12, porté de VT).
 *
 * Sans lui, une pile morte une nuit de janvier laisse la pièce sans chauffage : la régulation
 * refuse — à raison — de calculer sur une mesure figée, la demande de chaleur devient inconnue,
 * et la chaudière s'éteint. La vanne garde bien sa dernière ouverture, mais sans eau chaude
 * dedans elle ne chauffe rien.
 *
 * VT résout ça en forçant une chauffe minimale plutôt qu'en s'arrêtant. On reprend le principe et
 * ses trois paramètres.
 */

import type { EmitterMode } from './types.mjs';

export interface SafetyParams {
  enabled: boolean;
  /**
   * En dessous de cette puissance au moment où le capteur s'est tu, on ne fait rien.
   *
   * Une pièce qui ne chauffait presque pas ne risque pas de geler : la déclencher quand même
   * ferait tourner une chaudière pour rien, et pour longtemps puisque plus rien ne dira d'arrêter.
   * Fraction 0..1, défaut 0,5.
   */
  minOnPercent: number;
  /** Puissance de repli appliquée pendant la sécurité. Fraction 0..1, défaut 0,1. */
  defaultOnPercent: number;
}

export interface SafetyInput {
  /** Un capteur est désigné mais ne répond plus. Distinct de « aucun capteur lié ». */
  sensorStale: boolean;
  /** Faux quand aucun capteur n'est désigné : c'est un défaut de configuration, pas une panne. */
  sensorBound: boolean;
  emitterMode: EmitterMode;
  /** Dernière puissance calculée avant que la mesure ne se taise. */
  lastOnPercent: number;
  onoff: boolean;
}

export interface SafetyResult {
  active: boolean;
  /** Puissance à appliquer quand `active` est vrai. */
  onPercent: number;
}

export function evaluateSafety(input: SafetyInput, params: SafetyParams): SafetyResult {
  const inactive: SafetyResult = { active: false, onPercent: 0 };

  if (!params.enabled || !input.onoff) return inactive;

  // Aucun capteur désigné : il n'y a rien à secourir. Un thermostat sans thermomètre est un
  // problème de configuration, que l'avertissement de l'appareil signale déjà — le mettre en
  // sécurité ferait chauffer indéfiniment une pièce dont on ignore tout.
  if (!input.sensorBound || !input.sensorStale) return inactive;

  /*
   * Réservé au pilotage par vanne, comme chez VT.
   *
   * En mode consigne, l'émetteur régule sur son propre thermomètre : privé de nos écritures il
   * continue de tenir sa dernière consigne, tout seul. Il n'y a donc pas de risque physique, et
   * forcer une puissance ici reviendrait à se substituer à un régulateur qui fonctionne.
   */
  if (input.emitterMode !== 'valve') return inactive;

  // La pièce ne chauffait pas assez pour qu'un arrêt soit dangereux.
  if (input.lastOnPercent < params.minOnPercent) return inactive;

  return { active: true, onPercent: clampFraction(params.defaultOnPercent) };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
