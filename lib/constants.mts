/**
 * Valeurs par défaut de la SPEC, rassemblées ici pour qu'il n'y ait jamais deux vérités.
 * Les constantes d'auto-régulation sont reprises telles quelles de Versatile Thermostat.
 */

import type {
  AwayTemps, BoilerParams, PresetTemps, RegulationMode, RegulationParams,
  SlopeParams, TpiParams, WindowParams,
} from './types.mjs';

// --- TPI (SPEC §4) ---------------------------------------------------------

export const DEFAULT_TPI: TpiParams = {
  coefInt: 0.6,
  coefExt: 0.01,
  thresholdHigh: 0,
  thresholdLow: 0,
};

/** Période de recalcul, en minutes. Sert aussi de longueur de cycle au mode interrupteur. */
export const DEFAULT_CYCLE_MIN = 5;

/**
 * Gardes du mode interrupteur, en secondes (`minimal_activation_delay` de VT et son symétrique).
 *
 * 30 s sur un cycle de 5 min, c'est 10 % : en dessous, un convecteur n'a pas le temps de chauffer
 * quoi que ce soit et le contacteur claque pour rien.
 */
export const DEFAULT_MIN_ACTIVATION_SEC = 30;
export const DEFAULT_MIN_DEACTIVATION_SEC = 30;

/** Bornes d'ouverture de vanne, en %. */
export const DEFAULT_MIN_OPENING_DEGREE = 0;
export const DEFAULT_MAX_OPENING_DEGREE = 100;
/**
 * Fermeture maximale, en % (SPEC §4.1). Sous le seuil d'ouverture, la vanne reçoit
 * `100 − maxClosingDegree` : avec le défaut 100 cela fait bien 0, mais l'utilisateur qui
 * baisse ce réglage garde délibérément un filet d'ouverture — d'où le paramètre.
 */
export const DEFAULT_MAX_CLOSING_DEGREE = 100;
/** Fraction 0..1, sur l'échelle de `on_percent` et non en points de pourcentage. */
export const DEFAULT_OPENING_THRESHOLD = 0;
/** Variation minimale pour réécrire la vanne — recommandation VT pour les TRVZB. */
export const DEFAULT_REGULATION_THRESHOLD = 3;

// --- Auto-régulation par offset (SPEC §5.2) --------------------------------

/**
 * Les **quatre** modes actifs ont la protection surchauffe (`const.py:575` donne
 * `overheat_protection = True` jusque pour `slow`). Une première rédaction mettait `false` sur
 * `slow` : avec son seuil d'accumulation de 576, l'intégrale mettait des heures à se décharger
 * après un dépassement.
 */
export const REGULATION_PRESETS: Record<Exclude<RegulationMode, 'expert'>, RegulationParams> = {
  none: {
    kp: 0, ki: 0, kExt: 0,
    offsetMax: 0,
    accumulatedErrorThreshold: 0,
    overheatProtection: false,
  },
  slow: {
    kp: 0.2, ki: 0.8 / 288.0, kExt: 1.0 / 25.0,
    offsetMax: 2.0,
    accumulatedErrorThreshold: 2.0 * 288,
    overheatProtection: true,
  },
  light: {
    kp: 0.2, ki: 0.05, kExt: 0.05,
    offsetMax: 1.5,
    accumulatedErrorThreshold: 10,
    overheatProtection: true,
  },
  medium: {
    kp: 0.3, ki: 0.05, kExt: 0.1,
    offsetMax: 2,
    accumulatedErrorThreshold: 20,
    overheatProtection: true,
  },
  strong: {
    kp: 0.4, ki: 0.08, kExt: 0.0,
    offsetMax: 5,
    accumulatedErrorThreshold: 50,
    overheatProtection: true,
  },
};

/** Valeurs de départ du mode expert, éditables par appareil. */
export const DEFAULT_EXPERT_REGULATION: RegulationParams = { ...REGULATION_PRESETS.medium };

/** Variation minimale d'offset avant de réécrire la consigne, en °C. */
export const DEFAULT_AUTO_REGULATION_DTEMP = 0.5;
/** Intervalle minimal entre deux écritures de consigne, en minutes. */
export const DEFAULT_AUTO_REGULATION_PERIOD_MIN = 5;

// --- Pente de température (SPEC §6.2) --------------------------------------

export const DEFAULT_SLOPE: SlopeParams = {
  alpha: 0.8,
  precision: 2,
  minSamples: 4,
  maxAbsSlopePerHour: 120,
  staleAfterSec: 30 * 60,
};

// --- Détection d'ouverture (SPEC §6) ---------------------------------------

export const DEFAULT_WINDOW: WindowParams = {
  mode: 'off',
  delaySec: 30,
  // `window_off_delay` chez VT : même valeur par défaut que `window_delay`, mais réglage distinct.
  offDelaySec: 30,
  action: 'turn_off',
  autoOpenThreshold: 3,
  autoCloseThreshold: 0,
  autoMaxDurationSec: 30 * 60,
};

// --- Presets (SPEC §8) -----------------------------------------------------

export const DEFAULT_PRESET_TEMPS: PresetTemps = {
  frost: 7,
  eco: 17,
  comfort: 19,
  boost: 21,
};

export const DEFAULT_AWAY_TEMPS: AwayTemps = {
  eco: 17,
  comfort: 17,
  boost: 17,
};

export const DEFAULT_MOTION_DELAY_SEC = 30;
export const DEFAULT_MOTION_OFF_DELAY_SEC = 300;

/** Bornes du preset temporisé, en minutes. */
export const TIMED_PRESET_MIN_MINUTES = 1;
export const TIMED_PRESET_MAX_MINUTES = 1440;

// --- Chaudière (SPEC §9.2) -------------------------------------------------

export const DEFAULT_BOILER: BoilerParams = {
  threshold: 1,
  activationDelaySec: 0,
  minDwellSec: 60,
  keepAliveSec: 0,
};

/**
 * Plancher absolu du garde-fou anti-pulsation, **à l'allumage uniquement**. L'installation de
 * référence a déjà connu une chaudière commutée deux fois en moins d'une seconde ; ce plancher
 * n'est pas configurable à zéro.
 *
 * Il ne retarde JAMAIS une extinction. VT le dit explicitement : « Il n'y a pas de délai pour
 * l'extinction de la chaudière. C'est volontaire pour vous éviter de laisser tourner la chaudière
 * alors que toutes les vannes sont fermées. » — le risque étant une surpression du circuit.
 */
export const BOILER_MIN_DWELL_FLOOR_SEC = 60;

/**
 * Espacement minimal entre deux CORRECTIONS d'un relais divergent.
 *
 * La correction se déclenche sur ce que le relais rapporte, pas sur une horloge : un appareil qui
 * répond normalement n'en produit qu'une. Mais un relais en panne peut réannoncer son état plusieurs
 * fois par seconde, et chaque annonce vaudrait alors un appel d'API — le quota Athom se déclenche
 * en production après quelques dizaines d'appels rapprochés, et il emporterait avec lui toutes les
 * autres écritures de l'app. Une correction qui n'a pas pris n'est de toute façon pas rattrapée en
 * la répétant plus vite.
 */
export const BOILER_DIVERGENCE_RETRY_SEC = 30;

// --- Consigne --------------------------------------------------------------

export const SETPOINT_MIN = 5;
export const SETPOINT_MAX = 35;
export const SETPOINT_STEP = 0.5;

/**
 * Au-delà de ce délai sans mesure fraîche du capteur de pièce, la mesure est considérée morte
 * et la régulation refuse de commander une chaudière sur cette base (SPEC §12 — le mode sécurité
 * complet arrive en v1.1, ceci en est le garde-fou minimal).
 */
export const STALE_MEASUREMENT_SEC = 3600;

/**
 * SPEC §11 : au-delà de cette interruption, l'erreur cumulée de l'auto-régulation est remise à zéro.
 * L'intégrale d'un régulateur suppose une continuité temporelle ; après une heure d'arrêt, la
 * réappliquer reviendrait à corriger le présent avec l'écart d'un logement qui n'existe plus.
 */
export const REGULATION_RESET_AFTER_SEC = 3600;

// --- Mode sécurité (porté de VT) -------------------------------------------

/**
 * Défauts repris de Versatile Thermostat.
 *
 * `minOnPercent` à 0,5 : en dessous, la pièce ne chauffait pas assez pour qu'un arrêt soit
 * dangereux, et déclencher ferait tourner une chaudière pour rien — longtemps, puisque plus rien
 * ne dira d'arrêter. `defaultOnPercent` à 0,1 : de quoi éviter le gel, pas de quoi chauffer.
 * Le délai de 60 minutes de VT correspond ici au seuil de péremption de la mesure de pièce.
 */
export const DEFAULT_SAFETY = {
  enabled: true,
  minOnPercent: 0.5,
  defaultOnPercent: 0.1,
  /**
   * Consigne de repli du mode consigne : la température du preset confort.
   *
   * Ni le hors-gel — la pièce chauffait franchement, la laisser tomber à 7 °C est ce qu'on cherche
   * à éviter — ni une valeur haute qui ferait chauffer à l'aveugle. La consigne que l'utilisateur
   * a lui-même choisie pour être bien est le seul repli qui ne soit pas une invention.
   */
  fallbackSetpoint: DEFAULT_PRESET_TEMPS.comfort,
  /** 24 h. Au-delà, ce n'est plus une pile à changer, c'est un capteur à remplacer. */
  maxDurationMs: 24 * 60 * 60 * 1000,
} as const;
