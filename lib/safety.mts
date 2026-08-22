/**
 * Mode sécurité : que faire quand le capteur de pièce se tait (SPEC §12, porté de VT).
 *
 * Sans lui, une pile morte une nuit de janvier laisse la pièce sans chauffage : la régulation
 * refuse — à raison — de calculer sur une mesure figée, la demande de chaleur devient inconnue,
 * et la chaudière s'éteint. La vanne garde bien sa dernière ouverture, mais sans eau chaude
 * dedans elle ne chauffe rien.
 *
 * VT résout ça en forçant une chauffe minimale plutôt qu'en s'arrêtant. On reprend le principe et
 * ses trois paramètres, avec une différence assumée : le repli s'exprime dans l'unité de
 * l'émetteur. Une puissance quand on pilote une vanne, une CONSIGNE quand on ne sait lui parler
 * qu'en degrés — sans quoi la sécurité resterait inerte sur toute installation sans dorsale MQTT,
 * qui est la configuration standard de l'app.
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
  /** Puissance de repli appliquée pendant la sécurité, en mode vanne. Fraction 0..1, défaut 0,1. */
  defaultOnPercent: number;
  /**
   * Consigne de repli appliquée pendant la sécurité, en mode consigne, en °C.
   *
   * Une PUISSANCE n'a aucun sens sur un émetteur qu'on pilote par consigne : on ne lui parle qu'en
   * degrés. Sans cette consigne connue, il resterait sur la dernière valeur écrite avant la panne
   * — qui peut être l'éco de la nuit, ou une consigne décalée VERS LE BAS par l'auto-régulation.
   * Défaut : la température du preset confort.
   */
  fallbackSetpoint: number;
  /**
   * Durée maximale du mode sécurité, en millisecondes. Défaut 24 h.
   *
   * Pourquoi une borne : sans elle, une pile morte en février fait chauffer la pièce jusqu'à ce
   * que quelqu'un s'en aperçoive — des semaines. Le mode sécurité est fait pour tenir le temps
   * qu'on remplace une pile, pas pour remplacer un capteur. Passé ce délai, une chaudière qui
   * tourne à l'aveugle sur une mesure morte est un risque plus grand que le gel qu'on voulait
   * éviter : facture, usure, et surtout plus personne pour dire d'arrêter.
   *
   * Zéro ou valeur non finie : borne désactivée, on retombe sur l'ancien comportement.
   */
  maxDurationMs: number;
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
  /**
   * Instant de la dernière mesure de pièce exploitable. `null` = on n'en a jamais eu depuis le
   * démarrage, auquel cas la borne de durée ne peut pas s'appliquer faute d'origine.
   */
  lastGoodReadingAtMs: number | null;
  nowMs: number;
}

export interface SafetyResult {
  active: boolean;
  /** Puissance à appliquer quand `active` est vrai, en mode vanne. */
  onPercent: number;
  /**
   * Consigne à appliquer quand `active` est vrai, en mode consigne. Sans objet quand la sécurité
   * ne s'applique pas : l'appelant ne doit la lire que sur `active`.
   */
  setpoint: number;
  /**
   * Vrai quand la sécurité s'est désactivée d'elle-même parce que le capteur se tait depuis plus
   * de `maxDurationMs`. Distinct de « jamais déclenchée » : c'est un abandon délibéré, et
   * l'appelant peut vouloir le dire autrement à l'utilisateur.
   */
  expired: boolean;
}

export function evaluateSafety(input: SafetyInput, params: SafetyParams): SafetyResult {
  const inactive: SafetyResult = { active: false, onPercent: 0, setpoint: 0, expired: false };

  if (!params.enabled || !input.onoff) return inactive;

  // Aucun capteur désigné : il n'y a rien à secourir. Un thermostat sans thermomètre est un
  // problème de configuration, que l'avertissement de l'appareil signale déjà — le mettre en
  // sécurité ferait chauffer indéfiniment une pièce dont on ignore tout.
  if (!input.sensorBound || !input.sensorStale) return inactive;

  /*
   * Hors du pilotage par interrupteur, et cette exclusion-là est la seule qui tienne.
   *
   * Le mode consigne était exclu lui aussi, au motif que l'émetteur « régule tout seul sur son
   * propre thermomètre ». C'est justement le problème : le thermomètre d'une TRVZB est collé au
   * radiateur, livrée à elle-même elle lit chaud, ferme la vanne, et la pièce refroidit. Pire, le
   * mode consigne est le SEUL disponible sans dorsale MQTT — la sécurité ne s'armait donc jamais
   * dans la configuration standalone, c'est-à-dire exactement dans celle où le capteur muet ne
   * peut plus être secouru autrement.
   *
   * Un interrupteur, lui, reste dehors : sur un relais le repli sûr n'est pas de chauffer un peu,
   * c'est de COUPER — il a sa propre source d'énergie et rien ne l'arrêterait (voir lib/step.mts).
   */
  if (input.emitterMode === 'switch') return inactive;

  // La pièce ne chauffait pas assez pour qu'un arrêt soit dangereux.
  if (input.lastOnPercent < params.minOnPercent) return inactive;

  // Borne de durée. Comparée en valeur absolue : une horloge qui recule (changement d'heure,
  // resynchronisation NTP) ne doit pas remettre le compteur à zéro et relancer la sécurité pour
  // un tour de plus.
  if (hasExpired(input, params)) return { active: false, onPercent: 0, setpoint: 0, expired: true };

  return {
    active: true,
    onPercent: clampFraction(params.defaultOnPercent),
    setpoint: params.fallbackSetpoint,
    expired: false,
  };
}

function hasExpired(input: SafetyInput, params: SafetyParams): boolean {
  const max = params.maxDurationMs;
  if (!Number.isFinite(max) || max <= 0) return false;
  if (input.lastGoodReadingAtMs === null) return false;
  return Math.abs(input.nowMs - input.lastGoodReadingAtMs) > max;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
