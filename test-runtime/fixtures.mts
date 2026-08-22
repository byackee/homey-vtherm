/**
 * Réglages de référence pour les essais de `runtime/`.
 *
 * Un seul jeu, partagé : deux copies divergeraient, et un test vert sur une configuration que
 * personne n'utilise ne prouve rien.
 */

import {
  DEFAULT_AWAY_TEMPS, DEFAULT_EXPERT_REGULATION, DEFAULT_PRESET_TEMPS, DEFAULT_SAFETY,
  DEFAULT_SLOPE,
} from '../lib/constants.mjs';
import type { VThermConfig, VThermStateDefaults } from '../lib/types.mjs';

export const DEFAULTS: VThermStateDefaults = { preset: 'comfort', manualSetpoint: 19 };

/** Confort à 19 °C, cycle de 5 min, aucune détection d'ouverture ni de mouvement. */
export const CONFIG: VThermConfig = {
  tpi: {
    coefInt: 0.6, coefExt: 0.01, thresholdHigh: 0, thresholdLow: 0,
  },
  slope: DEFAULT_SLOPE,
  window: {
    mode: 'off',
    delaySec: 30,
    offDelaySec: 30,
    action: 'turn_off',
    autoOpenThreshold: 3,
    autoCloseThreshold: 0,
    autoMaxDurationSec: 1800,
  },
  presetTemps: DEFAULT_PRESET_TEMPS,
  awayTemps: DEFAULT_AWAY_TEMPS,
  motion: {
    enabled: false,
    motionPreset: 'comfort',
    noMotionPreset: 'eco',
    delaySec: 30,
    offDelaySec: 300,
  },
  regulationMode: 'medium',
  expertRegulation: DEFAULT_EXPERT_REGULATION,
  minOpeningDegree: 0,
  maxOpeningDegree: 100,
  maxClosingDegree: 100,
  openingThreshold: 0,
  regulationThreshold: 3,
  autoRegulationDtemp: 0.5,
  autoRegulationPeriodMin: 5,
  cycleMin: 5,
  minActivationSec: 30,
  minDeactivationSec: 30,
  useCentralMode: true,
  safety: DEFAULT_SAFETY,
};
