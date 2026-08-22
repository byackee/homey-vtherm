/**
 * État agrégé d'un VTherm (SPEC §11), séparé en durable et volatile.
 *
 * Le partage n'est pas cosmétique. Le durable part dans le `store` du device et doit survivre à une
 * mise à jour de l'app ; le volatile (pente, mouvement, dernières écritures) se reconstruit en
 * quelques cycles et n'a rien à faire dans un stockage qu'il faudra migrer à chaque version.
 *
 * `migratePersistentState` est un GARDE-FOU, pas une formalité. Un `accumulatedError` relu comme
 * `undefined` produit un `NaN` qui traverse le TPI, l'offset, la consigne et arrive intact à
 * `setCapabilityValue` — que Homey rejette EN SILENCE. La capability est alors morte pour toute la
 * durée de vie de l'app, sans une ligne de journal. D'où la règle unique de ce fichier : devant
 * n'importe quelle valeur inattendue, on retombe sur le défaut, jamais sur la valeur lue.
 *
 * Pur : aucune référence à Homey, aucune lecture d'horloge (`nowMs` est toujours un paramètre).
 */

import type {
  Preset, RegulationState, TimedPreset, VThermLastWrite, VThermPersistentState,
  VThermState, VThermStateDefaults, VThermVolatileState, WindowMemento, WindowPhase, WindowState,
} from './types.mjs';
import type { DutyCycleState } from './dutyCycle.mjs';
import { REGULATION_RESET_AFTER_SEC, SETPOINT_MAX, SETPOINT_MIN } from './constants.mjs';
import { createDutyCycleState } from './dutyCycle.mjs';
import { createMotionState } from './presetResolver.mjs';
import { createRegulationState } from './selfRegulation.mjs';
import { createSlopeState } from './slope.mjs';
import { createWindowState } from './windowDetector.mjs';

const PRESETS: readonly string[] = ['frost', 'eco', 'comfort', 'boost', 'none', 'activity'];
const WINDOW_PHASES: readonly string[] = ['closed', 'pending_open', 'open', 'pending_close'];

// --- Validateurs élémentaires ----------------------------------------------
//
// Tous suivent la même forme : ils rendent une valeur du bon type ou le défaut, jamais `undefined`.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `NaN` et `Infinity` sont des `number` pour `typeof` : c'est exactement le piège à fermer ici. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPreset(value: unknown): value is Preset {
  return typeof value === 'string' && PRESETS.includes(value);
}

function clampSetpoint(value: number): number {
  return Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, value));
}

// --- Validateurs de tranches d'état ----------------------------------------

/**
 * Un preset temporisé n'a de sens que complet : preset, échéance et preset à restaurer. Un seul
 * champ douteux et on l'abandonne — un preset temporisé fantôme changerait la consigne sans que
 * rien dans l'interface ne l'explique.
 */
function parseTimedPreset(value: unknown): TimedPreset | null {
  if (!isRecord(value)) return null;

  const untilMs = finiteOrNull(value.untilMs);
  if (untilMs === null || !isPreset(value.preset) || !isPreset(value.previous)) return null;

  return { preset: value.preset, untilMs, previous: value.previous };
}

function parseWindowState(value: unknown): WindowState {
  if (!isRecord(value)) return createWindowState();
  if (typeof value.phase !== 'string' || !WINDOW_PHASES.includes(value.phase)) {
    return createWindowState();
  }

  return {
    phase: value.phase as WindowPhase,
    phaseSinceMs: finiteOrNull(value.phaseSinceMs),
    openSinceMs: finiteOrNull(value.openSinceMs),
    // Absent d'un état écrit par une version antérieure : armé, ce qui est le comportement normal.
    autoDisarmed: value.autoDisarmed === true,
  };
}

function parseWindowMemento(value: unknown): WindowMemento | null {
  if (!isRecord(value)) return null;

  const setpoint = finiteOrNull(value.setpoint);
  if (setpoint === null || typeof value.onoff !== 'boolean' || !isPreset(value.preset)) return null;

  return { onoff: value.onoff, preset: value.preset, setpoint: clampSetpoint(setpoint) };
}

function parseRegulationState(value: unknown): RegulationState {
  if (!isRecord(value)) return createRegulationState();

  return {
    accumulatedError: finiteOr(value.accumulatedError, 0),
    // Absent d'un état écrit par une version antérieure : la boucle repart d'une période pleine.
    lastRegulationAtMs: finiteOrNull(value.lastRegulationAtMs),
  };
}

/**
 * Découpage temporel du mode interrupteur.
 *
 * Un `cycleStartMs` illisible retombe sur `null`, ce que `stepDutyCycle` interprète comme « aucun
 * cycle en cours » : le prochain pas en ouvre un neuf. C'est le seul repli sûr — un début de cycle
 * inventé ferait croire à un temps de marche déjà consommé, ou jamais consommé.
 */
function parseDutyCycleState(value: unknown): DutyCycleState {
  if (!isRecord(value) || typeof value.commanded !== 'boolean') return createDutyCycleState();

  return { cycleStartMs: finiteOrNull(value.cycleStartMs), commanded: value.commanded };
}

// --- Constructeurs ---------------------------------------------------------

export function createPersistentState(
  nowMs: number,
  defaults: VThermStateDefaults,
): VThermPersistentState {
  return {
    version: 1,
    preset: defaults.preset,
    manualSetpoint: clampSetpoint(defaults.manualSetpoint),
    timedPreset: null,
    window: createWindowState(),
    windowMemento: null,
    regulation: createRegulationState(),
    dutyCycle: createDutyCycleState(),
    lastRunAtMs: nowMs,
    lastOnPercent: 0,
    // `null` et non `nowMs` : aucune mesure n'a encore été vue. Dater l'origine du compte à
    // rebours du mode sécurité sur un démarrage d'app le remettrait à zéro à chaque mise à jour.
    lastGoodReadingAtMs: null,
  };
}

export function createVolatileState(): VThermVolatileState {
  // `switchOn` à `null` : rien n'a encore été commandé sur le relais depuis ce démarrage, donc le
  // premier pas doit écrire même si le cycle relu dit que l'état est déjà le bon.
  const lastWrite: VThermLastWrite = {
    valvePercent: null, setpoint: null, switchOn: null, atMs: 0,
  };

  return {
    slope: createSlopeState(),
    motion: createMotionState(),
    lastWrite,
    // Tout à `null` : au premier pas, rien n'a jamais été publié, donc aucun Flow ne part.
    lastPublished: {
      sensorQuiet: null,
      stateLabel: null, preset: null, windowOpen: null, demandActive: null,
    },
  };
}

export function createVThermState(nowMs: number, defaults: VThermStateDefaults): VThermState {
  return {
    persistent: createPersistentState(nowMs, defaults),
    volatile: createVolatileState(),
  };
}

/**
 * Relit l'état durable du `store`.
 *
 * Contrat : ne lève jamais, ne rend jamais un `NaN`, ne rend jamais un champ manquant. Devant une
 * version inconnue — donc un format qu'on ne sait pas interpréter — on repart entièrement des
 * défauts : deviner champ par champ produirait un état à moitié d'une version et à moitié d'une
 * autre, le pire des trois.
 */
export function migratePersistentState(
  raw: unknown,
  nowMs: number,
  defaults: VThermStateDefaults,
): VThermPersistentState {
  if (!isRecord(raw) || raw.version !== 1) {
    return createPersistentState(nowMs, defaults);
  }

  const lastRunAtMs = finiteOr(raw.lastRunAtMs, nowMs);
  let regulation = parseRegulationState(raw.regulation);

  // SPEC §11 : l'app arrêtée plus d'une heure, l'intégrale n'a plus de sens.
  // Valeur absolue : une horloge qui recule (changement d'heure, resynchronisation NTP) invalide
  // l'accumulation autant qu'un arrêt, et laisser passer ce cas rouvrirait la porte au NaN.
  if (Math.abs(nowMs - lastRunAtMs) > REGULATION_RESET_AFTER_SEC * 1000) {
    regulation = createRegulationState();
  }

  return {
    version: 1,
    preset: isPreset(raw.preset) ? raw.preset : defaults.preset,
    manualSetpoint: clampSetpoint(finiteOr(raw.manualSetpoint, defaults.manualSetpoint)),
    timedPreset: parseTimedPreset(raw.timedPreset),
    window: parseWindowState(raw.window),
    windowMemento: parseWindowMemento(raw.windowMemento),
    regulation,
    dutyCycle: parseDutyCycleState(raw.dutyCycle),
    lastRunAtMs,
    lastOnPercent: readFraction(raw.lastOnPercent),
    lastGoodReadingAtMs: finiteOrNull(raw.lastGoodReadingAtMs),
  };
}

/** Recompose l'état complet au démarrage : durable relu du `store`, volatile toujours neuf. */
export function restoreVThermState(
  raw: unknown,
  nowMs: number,
  defaults: VThermStateDefaults,
): VThermState {
  return {
    persistent: migratePersistentState(raw, nowMs, defaults),
    volatile: createVolatileState(),
  };
}

/**
 * Une fraction 0..1 relue du `store`.
 *
 * Comme partout dans cette migration : devant `undefined`, `NaN`, un type inattendu ou une valeur
 * hors bornes, on repart de zéro. Un `NaN` glissé ici traverserait le calcul de puissance et
 * finirait dans `setCapabilityValue`, que Homey rejette en silence.
 */
function readFraction(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}
