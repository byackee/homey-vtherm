import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepVTherm } from '../lib/step.mjs';
import { createVThermState, migratePersistentState, createVolatileState } from '../lib/state.mjs';
import {
  DEFAULT_AWAY_TEMPS, DEFAULT_EXPERT_REGULATION, DEFAULT_PRESET_TEMPS, DEFAULT_SLOPE,
  DEFAULT_SAFETY,
} from '../lib/constants.mjs';
import type {
  Reading, VThermConfig, VThermInputs, VThermState, VThermStateDefaults,
} from '../lib/types.mjs';

// --- Fixtures ---------------------------------------------------------------

const DEFAULTS: VThermStateDefaults = { preset: 'comfort', manualSetpoint: 19 };

/** Presets : hors-gel 7, éco 17, confort 19, boost 21. Absence : éco/confort/boost à 17. */
const CONFIG: VThermConfig = {
  tpi: {
    coefInt: 0.6, coefExt: 0.01, thresholdHigh: 0, thresholdLow: 0,
  },
  slope: DEFAULT_SLOPE,
  window: {
    mode: 'sensor',
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

function config(overrides: Partial<VThermConfig> = {}): VThermConfig {
  return { ...CONFIG, ...overrides };
}

function reading<T>(value: T, atMs = 0, stale = false): Reading<T> {
  return { value, atMs, stale };
}

/** Pièce à 18 °C, extérieur à 5 °C, pilotage par vanne, rien d'autre de branché. */
function inputs(overrides: Partial<VThermInputs> = {}): VThermInputs {
  return {
    roomTemp: reading(18),
    // Un capteur est désigné. Le passer à faux, c'est un thermostat sans thermomètre ; le laisser
    // vrai avec `roomTemp: null`, c'est un capteur désigné qui ne répond plus — deux cas distincts.
    roomSensorBound: true,
    outdoorTemp: reading(5),
    windowContact: null,
    motion: null,
    presence: null,
    emitterHeating: null,
    emitterMode: 'valve',
    centralMode: 'auto',
    onoff: true,
    windowBypass: false,
    ...overrides,
  };
}

function freshState(overrides: Partial<VThermState['persistent']> = {}): VThermState {
  const base = createVThermState(0, DEFAULTS);
  return { persistent: { ...base.persistent, ...overrides }, volatile: base.volatile };
}

function near(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} ≉ ${expected}`);
}

// --- Cas nominal ------------------------------------------------------------

test('cas nominal : confort à 19 °C dans une pièce à 18 °C, la vanne s\'ouvre et la demande part', () => {
  const { outputs } = stepVTherm(freshState(), inputs(), CONFIG, 0);

  // 0,6 × (19 − 18) + 0,01 × (19 − 5) = 0,74
  near(outputs.onPercent, 0.74);
  assert.equal(outputs.valvePercent, 74);
  assert.equal(outputs.setpointToEmitter, 19, 'en mode vanne, la consigne brute part pour l\'affichage');
  assert.deepEqual(outputs.demand, { kind: 'active', percent: 74 });
  assert.equal(outputs.stateLabel, 'heating');
  assert.equal(outputs.warning, null);
  assert.equal(outputs.wakeUpAtMs, null, 'rien en attente');
});

test('le réducteur ne mute ni son état ni ses entrées', () => {
  const state = freshState();
  const snapshot = structuredClone(state);
  const world = inputs({ windowContact: reading(true) });
  const worldSnapshot = structuredClone(world);

  stepVTherm(state, world, CONFIG, 1_000);

  assert.deepEqual(state, snapshot);
  assert.deepEqual(world, worldSnapshot);
});

// --- Priorités : fenêtre, mode central, absence -----------------------------

test('la fenêtre prime sur le preset : confirmée, elle ferme la vanne et coupe la demande', () => {
  let state = freshState();

  // t=0 : contact ouvert, délai non écoulé, la chauffe continue.
  let result = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 0);
  assert.equal(result.outputs.stateLabel, 'heating');
  assert.equal(result.outputs.valvePercent, 74);
  state = result.nextState;

  // t=30 s : confirmée. L'action `turn_off` ferme réellement la vanne.
  result = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 30_000);
  assert.equal(result.outputs.stateLabel, 'window');
  assert.equal(result.outputs.valvePercent, 0);
  assert.equal(result.outputs.setpointToEmitter, 7, 'consigne hors-gel');
  assert.deepEqual(result.outputs.demand, { kind: 'inactive' });
  // Le preset choisi, lui, n'a pas bougé (SPEC §6.3).
  assert.equal(result.outputs.capabilities.vtherm_preset, 'comfort');
});

test('action fenêtre `eco` : la consigne change, la régulation CONTINUE', () => {
  // Correction du pseudo-code SPEC §3 : sortir avant la régulation ne réguleraient jamais vers
  // la consigne de l'action.
  const cfg = config({ window: { ...CONFIG.window, action: 'eco' } });
  let state = freshState();

  state = stepVTherm(state, inputs({ roomTemp: reading(15), windowContact: reading(true) }), cfg, 0).nextState;
  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(15), windowContact: reading(true) }), cfg, 30_000);

  assert.equal(outputs.stateLabel, 'window');
  // 0,6 × (17 − 15) + 0,01 × (17 − 5) = 1,32 → borné à 1. On lit l'ouverture COMMANDÉE et non
  // `valvePercent`, qui vaut `null` parce que la vanne était déjà à 100 % au pas précédent.
  assert.equal(outputs.capabilities.vtherm_valve_open, 100);
  assert.deepEqual(outputs.demand, { kind: 'active', percent: 100 });
  assert.equal(outputs.setpointToEmitter, 17, 'température ÉCO du preset, pas sa variante absence');
});

test('le mode central prime sur la fenêtre', () => {
  // Pièce froide : sous `frost` la régulation doit CONTINUER vers 7 °C, ce qui la distingue
  // sans ambiguïté de l'action fenêtre `turn_off` qui, elle, fermerait la vanne.
  const world = inputs({
    roomTemp: reading(5), outdoorTemp: reading(0), windowContact: reading(true), centralMode: 'frost',
  });
  let state = freshState();

  state = stepVTherm(state, world, CONFIG, 0).nextState;
  const { outputs } = stepVTherm(state, world, CONFIG, 30_000);

  assert.equal(outputs.stateLabel, 'central');
  // 0,6 × (7 − 5) + 0,01 × (7 − 0) = 1,27 → borné à 1. L'action fenêtre `turn_off`, elle,
  // aurait fermé la vanne : c'est ce qui distingue sans ambiguïté les deux priorités.
  assert.equal(outputs.capabilities.vtherm_valve_open, 100);
  assert.deepEqual(outputs.demand, { kind: 'active', percent: 100 });
  assert.equal(outputs.regulatedSetpoint, 7, 'on régule vers le hors-gel, on ne s\'arrête pas');
});

test('mode central `stopped` : arrêt complet, vanne fermée', () => {
  const { outputs } = stepVTherm(freshState(), inputs({ centralMode: 'stopped' }), CONFIG, 0);

  assert.equal(outputs.stateLabel, 'central');
  assert.equal(outputs.valvePercent, 0);
  assert.equal(outputs.setpointToEmitter, 7);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
});

test('mode central `heat_only` : régulation nominale, seule l\'étiquette change', () => {
  const { outputs } = stepVTherm(freshState(), inputs({ centralMode: 'heat_only' }), CONFIG, 0);

  assert.equal(outputs.stateLabel, 'central');
  assert.equal(outputs.valvePercent, 74, 'la régulation ne s\'arrête pas');
  assert.deepEqual(outputs.demand, { kind: 'active', percent: 74 });
});

test('un device qui n\'obéit pas au mode central l\'ignore entièrement', () => {
  const cfg = config({ useCentralMode: false });
  const { outputs } = stepVTherm(freshState(), inputs({ centralMode: 'stopped' }), cfg, 0);

  assert.equal(outputs.stateLabel, 'heating');
  assert.equal(outputs.valvePercent, 74);
});

test('l\'absence ne change PAS le preset affiché mais change la consigne', () => {
  const { outputs } = stepVTherm(freshState(), inputs({ presence: reading(false) }), CONFIG, 0);

  assert.equal(outputs.capabilities.vtherm_preset, 'comfort', 'le preset choisi reste affiché');
  assert.equal(outputs.stateLabel, 'away');
  // Confort en absence = 17 °C, donc plus aucune demande dans une pièce à 18 °C.
  assert.equal(outputs.capabilities.target_temperature, 17);
  assert.equal(outputs.valvePercent, 0);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
});

// --- Arrêt de l'appareil ----------------------------------------------------

test('onoff false ferme réellement la vanne et ne demande rien', () => {
  const { outputs } = stepVTherm(freshState(), inputs({ onoff: false }), CONFIG, 0);

  assert.equal(outputs.stateLabel, 'off');
  assert.equal(outputs.valvePercent, 0, 'la vanne est fermée, pas laissée en l\'état');
  assert.equal(outputs.setpointToEmitter, 7, 'consigne hors-gel');
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
  assert.equal(outputs.warning, null, 'un appareil éteint n\'a rien à signaler');
});

test('onoff false s\'applique même sans capteur de pièce : fermer une vanne n\'a besoin d\'aucune mesure', () => {
  const { outputs } = stepVTherm(freshState(), inputs({ onoff: false, roomTemp: null }), CONFIG, 0);

  assert.equal(outputs.stateLabel, 'off');
  assert.equal(outputs.valvePercent, 0);
  assert.equal(outputs.setpointToEmitter, 7);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
});

test('onoff false prime sur le mode central et sur la fenêtre', () => {
  const world = inputs({ onoff: false, centralMode: 'heat_only', windowContact: reading(true) });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.equal(outputs.stateLabel, 'off');
  assert.equal(outputs.valvePercent, 0);
});

// --- Capteurs muets : le cœur de la sûreté ---------------------------------

test('capteur de pièce absent : aucune demande, aucune écriture, avertissement', () => {
  const { outputs, nextState } = stepVTherm(freshState(), inputs({ roomTemp: null }), CONFIG, 0);

  assert.deepEqual(outputs.demand, { kind: 'unknown' }, 'jamais inactive : on ne SAIT pas');
  assert.equal(outputs.setpointToEmitter, null);
  assert.equal(outputs.valvePercent, null);
  assert.equal(outputs.regulatedSetpoint, null);
  assert.ok(outputs.warning !== null);

  // Sortie gelée : les capabilities calculées sont ABSENTES, donc inchangées côté Homey.
  assert.equal('vtherm_power_percent' in outputs.capabilities, false);
  assert.equal('vtherm_valve_open' in outputs.capabilities, false);
  assert.equal('vtherm_regulated_setpoint' in outputs.capabilities, false);
  assert.equal('measure_temperature' in outputs.capabilities, false);

  // Rien n'a été écrit, donc rien n'a été mémorisé comme écrit.
  assert.equal(nextState.volatile.lastWrite.valvePercent, null);
  assert.equal(nextState.volatile.lastWrite.setpoint, null);
});

test('capteur périmé alors que la pièce chauffait : le mode sécurité prend le relais', () => {
  // Avant le mode sécurité, ce cas gelait la sortie : la demande devenait inconnue, donc la
  // chaudière s'éteignait, et une pièce qui chauffait à 74 % se retrouvait sans rien. Une pile
  // morte une nuit de janvier suffisait.
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;
  assert.equal(state.volatile.lastWrite.valvePercent, 74);
  assert.equal(state.persistent.lastOnPercent, 0.74, 'la dernière puissance vivante est mémorisée');

  const result = stepVTherm(state, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 300_000);

  assert.equal(result.outputs.stateLabel, 'safety');
  assert.equal(result.outputs.onPercent, 0.1, 'puissance de repli, pas la dernière connue');
  assert.equal(result.outputs.valvePercent, 10);
  assert.equal(result.outputs.demand.kind, 'active', 'la chaudière doit rester sollicitée');
  assert.ok(result.outputs.warning !== null, 'et l\'utilisateur doit le savoir');
  assert.equal(result.nextState.persistent.lastOnPercent, 0.74,
    'la puissance de secours n\'écrase pas la dernière valeur vivante');
});

test('le mode sécurité publie ce qu\'il commande : l\'écran ne ment pas', () => {
  // La garde du gel de sortie taisait ces trois capabilities pendant la sécurité. Elles gardaient
  // donc la dernière valeur vivante : 74 % affichés pour 10 % réellement commandés, un facteur
  // 7,4 gravé dans les Insights, et personne pour voir ce que l'app fait vraiment.
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;

  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 300_000);

  assert.equal(outputs.stateLabel, 'safety');
  assert.equal(outputs.capabilities.vtherm_power_percent, 10);
  assert.equal(outputs.capabilities.vtherm_valve_open, 10);
  assert.equal(outputs.capabilities.vtherm_regulated_setpoint, 19);
  assert.equal('measure_temperature' in outputs.capabilities, false,
    'la température, elle, n\'est pas connue : on n\'en invente pas');
});

test('capteur périmé alors que la pièce ne chauffait presque pas : on ne fait rien', () => {
  // Elle n'était pas en danger. Déclencher ferait tourner la chaudière longtemps, sans plus rien
  // pour dire d'arrêter.
  let state = freshState();
  // Pièce déjà à la consigne : le TPI rend une puissance faible.
  state = stepVTherm(state, inputs({ roomTemp: reading(19.5) }), CONFIG, 0).nextState;
  assert.ok(state.persistent.lastOnPercent < CONFIG.safety.minOnPercent);

  const result = stepVTherm(state, inputs({ roomTemp: reading(19.5, 0, true) }), CONFIG, 300_000);

  assert.deepEqual(result.outputs.demand, { kind: 'unknown' });
  assert.equal(result.outputs.valvePercent, null, 'sortie gelée, aucune écriture');
  assert.notEqual(result.outputs.stateLabel, 'safety');
});

test('aucun capteur désigné : jamais de sécurité', () => {
  // C'est un défaut de configuration, pas une panne. Chauffer une pièce dont on ignore tout
  // serait pire que de ne rien faire, et l'avertissement le signale déjà.
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;

  const result = stepVTherm(state, inputs({ roomTemp: null, roomSensorBound: false }), CONFIG, 300_000);

  assert.notEqual(result.outputs.stateLabel, 'safety');
  assert.deepEqual(result.outputs.demand, { kind: 'unknown' });
});

test('mode consigne : la sécurité impose une consigne de repli, pas une puissance', () => {
  /*
   * Ce cas était exclu de la sécurité. Or le mode consigne est le SEUL disponible sans dorsale
   * MQTT : la sécurité n'était donc jamais armée dans la configuration standalone, c'est-à-dire
   * dans la panne qu'elle existe pour couvrir. Et l'émetteur laissé à lui-même régule sur son
   * propre thermomètre, collé au radiateur : il lit chaud, ferme, et la pièce refroidit.
   *
   * Une puissance n'a nulle part où aller sur un émetteur qu'on pilote par consigne — c'est donc
   * une consigne de secours qu'on lui impose.
   */
  let state = freshState();
  state = stepVTherm(state, inputs({ emitterMode: 'setpoint' }), CONFIG, 0).nextState;
  assert.ok(state.persistent.lastOnPercent >= CONFIG.safety.minOnPercent);

  const cfg = config({ safety: { ...CONFIG.safety, fallbackSetpoint: 20 } });
  const result = stepVTherm(
    state, inputs({ emitterMode: 'setpoint', roomTemp: reading(18, 0, true) }), cfg, 300_000);

  assert.equal(result.outputs.stateLabel, 'safety');
  assert.equal(result.outputs.setpointToEmitter, 20, 'la consigne de repli part réellement');
  assert.equal(result.outputs.capabilities.vtherm_regulated_setpoint, 20,
    'et elle est affichée : la sécurité ne doit pas mentir sur ce qu\'elle commande');
  assert.equal(result.outputs.warning, 'sensor_stale_safety');
});

test('mode consigne : la sécurité ne s\'arme pas sur une pièce qui ne chauffait presque pas', () => {
  let state = freshState();
  state = stepVTherm(state, inputs({ emitterMode: 'setpoint', roomTemp: reading(19.5) }), CONFIG, 0).nextState;
  assert.ok(state.persistent.lastOnPercent < CONFIG.safety.minOnPercent);

  const result = stepVTherm(
    state, inputs({ emitterMode: 'setpoint', roomTemp: reading(19.5, 0, true) }), CONFIG, 300_000);

  assert.notEqual(result.outputs.stateLabel, 'safety');
  assert.equal(result.outputs.setpointToEmitter, null, 'sortie gelée');
});

test('liaison orpheline : traitée comme un capteur muet, pas comme une absence de capteur', () => {
  // Un capteur ré-appairé change d'identifiant : la liaison ne rend plus rien, exactement comme
  // s'il n'y en avait jamais eu. Le déduire de la lecture privait de sécurité le seul cas où l'on
  // ne peut plus rien attendre du capteur.
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;

  const orphan = inputs({ roomTemp: null, roomSensorBound: true });
  const result = stepVTherm(state, orphan, CONFIG, 300_000);

  assert.equal(result.outputs.stateLabel, 'safety');
  assert.equal(result.outputs.warning, 'sensor_stale_safety', 'et non « aucun capteur »');
});

test('mode sécurité désactivé : la sortie reste gelée', () => {
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;

  const result = stepVTherm(state, inputs({ roomTemp: reading(18, 0, true) }),
    config({ safety: { ...CONFIG.safety, enabled: false } }), 300_000);

  assert.notEqual(result.outputs.stateLabel, 'safety');
  assert.equal(result.outputs.valvePercent, null);
});

test('retour du capteur : la régulation normale reprend', () => {
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;
  state = stepVTherm(state, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 300_000).nextState;

  const back = stepVTherm(state, inputs(), CONFIG, 600_000);
  assert.equal(back.outputs.stateLabel, 'heating');
  near(back.outputs.onPercent, 0.74);
});

test('capteur de pièce muet : l\'intégrale est GELÉE, pas remise à zéro ni alimentée', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true) });
  let state = freshState();

  state = stepVTherm(state, world, CONFIG, 0).nextState;
  state = stepVTherm(state, world, CONFIG, 300_000).nextState;
  const accumulated = state.persistent.regulation.accumulatedError;
  assert.ok(accumulated > 0, 'un cycle complet a bien chargé l\'intégrale');

  const result = stepVTherm(state, { ...world, roomTemp: null }, CONFIG, 600_000);
  assert.equal(result.nextState.persistent.regulation.accumulatedError, accumulated);
});

test('une valeur NaN déguisée en lecture fraîche est refusée comme un capteur muet', () => {
  // Une capability Homey absente se lit `null`, et `null` en arithmétique vaut 0 : une pièce à
  // 0 °C ouvrirait la vanne en grand. Le filtre est sur la valeur, pas seulement sur l'âge.
  const { outputs } = stepVTherm(freshState(), inputs({ roomTemp: reading(Number.NaN) }), CONFIG, 0);

  assert.deepEqual(outputs.demand, { kind: 'unknown' });
  assert.equal(outputs.valvePercent, null);
});

test('capteur extérieur muet : la régulation continue, sans le terme externe', () => {
  const withExt = stepVTherm(freshState(), inputs(), CONFIG, 0).outputs;
  const withoutExt = stepVTherm(freshState(), inputs({ outdoorTemp: null }), CONFIG, 0).outputs;
  const staleExt = stepVTherm(freshState(), inputs({ outdoorTemp: reading(5, 0, true) }), CONFIG, 0).outputs;

  near(withExt.onPercent, 0.74);
  near(withoutExt.onPercent, 0.6, 'le terme coefExt vaut 0, pas une valeur inventée');
  near(staleExt.onPercent, 0.6);

  assert.equal(withoutExt.valvePercent, 60);
  assert.deepEqual(withoutExt.demand, { kind: 'active', percent: 60 });
  assert.equal(withoutExt.warning, null, 'non bloquant');
});

test('capteur extérieur muet en mode consigne : VT suspend l\'auto-régulation, sans bloquer', () => {
  // Différence assumée avec le mode vanne : le TPI met simplement son terme externe à 0, tandis que
  // l'auto-régulation par offset est suspendue en entier (voir `computeOffset`). Réguler avec une
  // moitié de formule reviendrait à inventer un offset.
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true), outdoorTemp: null });
  const { outputs, nextState } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.equal(outputs.regulatedSetpoint, 19, 'la consigne brute part, sans offset');
  assert.equal(outputs.setpointToEmitter, 19);
  assert.equal(outputs.warning, null, 'non bloquant');
  assert.equal(nextState.persistent.regulation.accumulatedError, 0, 'l\'intégrale n\'accumule pas');
});

test('contact de fenêtre périmé : traité fermé, on continue à chauffer', () => {
  // Un « ouvert » périmé gèlerait le logement : le repli sûr est l'inverse de l'intuition.
  const world = inputs({ windowContact: reading(true, 0, true) });
  let state = freshState();

  state = stepVTherm(state, world, CONFIG, 0).nextState;
  const { outputs, nextState } = stepVTherm(state, world, CONFIG, 120_000);

  assert.equal(nextState.persistent.window.phase, 'closed');
  assert.equal(outputs.stateLabel, 'heating');
  assert.equal(outputs.capabilities.alarm_contact, false);
  assert.deepEqual(outputs.demand, { kind: 'active', percent: 74 });
});

test('mouvement et présence périmés : repli sur présent et sans mouvement', () => {
  const cfg = config({ motion: { ...CONFIG.motion, enabled: true } });
  const state = freshState({ preset: 'activity' });
  const world = inputs({
    presence: reading(false, 0, true),
    motion: reading(true, 0, true),
  });

  const { outputs } = stepVTherm(state, world, cfg, 0);

  // Présent (donc pas d'absence) et sans mouvement (donc `noMotionPreset` = éco à 17 °C).
  assert.notEqual(outputs.stateLabel, 'away');
  assert.equal(outputs.capabilities.target_temperature, 17);
  assert.equal(outputs.capabilities.alarm_motion, false);
});

// --- Mode consigne et demande inconnue -------------------------------------

test('mode consigne : l\'offset part vers l\'émetteur, la demande se lit sur l\'émetteur', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true) });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  // medium : kp 0,3 ki 0,05 kExt 0,1 → 0,3×1 + 0,05×1 + 0,1×14 = 1,75 → 19 + 1,75 = 20,75 → pas de 0,5
  assert.equal(outputs.regulatedSetpoint, 20.5);
  assert.equal(outputs.setpointToEmitter, 20.5);
  assert.equal(outputs.valvePercent, null, 'aucune vanne en mode consigne');
  assert.equal(outputs.demand.kind, 'active');
});

test('mode consigne, état de chauffe de l\'émetteur inconnu : la demande est unknown', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: null });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.deepEqual(outputs.demand, { kind: 'unknown' });
  // La régulation, elle, n'est pas bloquée pour autant.
  assert.equal(outputs.setpointToEmitter, 20.5);
});

test('mode consigne, émetteur périmé : demande unknown, régulation poursuivie', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true, 0, true) });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.deepEqual(outputs.demand, { kind: 'unknown' });
  assert.equal(outputs.setpointToEmitter, 20.5);
});

test('mode consigne, émetteur au repos : demande inactive et non unknown', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(false) });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.deepEqual(outputs.demand, { kind: 'inactive' });
});

test('un NaN relu du store ne traverse JAMAIS le calcul jusqu\'à la consigne', () => {
  const persistent = migratePersistentState(
    { version: 1, preset: 'comfort', regulation: { accumulatedError: Number.NaN } },
    0,
    DEFAULTS,
  );
  const state: VThermState = { persistent, volatile: createVolatileState() };
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true) });

  const { outputs } = stepVTherm(state, world, CONFIG, 0);

  assert.ok(outputs.setpointToEmitter !== null);
  assert.equal(Number.isFinite(outputs.setpointToEmitter), true);
  assert.equal(Number.isFinite(outputs.onPercent), true);
});

// --- Déduplication des écritures -------------------------------------------

test('une variation de vanne sous le seuil n\'est pas réécrite', () => {
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState; // 74 %

  // 18,02 °C → 0,6 × 0,98 + 0,14 = 0,728 → 73 %, soit 1 point d'écart, sous le seuil de 3.
  const small = stepVTherm(state, inputs({ roomTemp: reading(18.02, 1) }), CONFIG, 60_000);
  assert.equal(small.outputs.valvePercent, null, 'écriture retenue');
  assert.equal(small.nextState.volatile.lastWrite.valvePercent, 74);

  // 19 °C → 0,6 × 0 + 0,14 = 0,14 → 14 %, largement au-dessus du seuil.
  const big = stepVTherm(state, inputs({ roomTemp: reading(19, 1) }), CONFIG, 60_000);
  assert.equal(big.outputs.valvePercent, 14);
});

test('une fermeture commandée n\'est jamais retenue par le seuil de variation', () => {
  const cfg = config({ regulationThreshold: 50 });
  let state = freshState();

  // Ouverture à 14 % puis arrêt : avec un seuil de 50, un simple écart ne suffirait pas.
  state = stepVTherm(state, inputs({ roomTemp: reading(19) }), cfg, 0).nextState;
  assert.equal(state.volatile.lastWrite.valvePercent, 14);

  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(19), onoff: false }), cfg, 60_000);
  assert.equal(outputs.valvePercent, 0, 'la sûreté prime sur l\'économie d\'appels');
});

test('mode consigne : la période minimale entre deux écritures est respectée', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true) });
  let state = freshState();

  state = stepVTherm(state, world, CONFIG, 0).nextState;
  assert.equal(state.volatile.lastWrite.setpoint, 20.5);

  // Écart largement suffisant, mais 1 minute seulement s'est écoulée sur les 5 exigées.
  const early = stepVTherm(state, { ...world, roomTemp: reading(10, 1) }, CONFIG, 60_000);
  assert.equal(early.outputs.setpointToEmitter, null);
  assert.ok(early.outputs.regulatedSetpoint !== null, 'la valeur est calculée et publiée malgré tout');

  const late = stepVTherm(state, { ...world, roomTemp: reading(10, 1) }, CONFIG, 300_000);
  assert.ok(late.outputs.setpointToEmitter !== null);
});

// --- Preset temporisé -------------------------------------------------------

test('preset temporisé : il masque le preset choisi, puis le restaure à l\'échéance', () => {
  let state = freshState({
    timedPreset: { preset: 'boost', untilMs: 600_000, previous: 'comfort' },
  });

  let result = stepVTherm(state, inputs(), CONFIG, 0);
  assert.equal(result.outputs.capabilities.vtherm_preset, 'boost');
  assert.equal(result.outputs.capabilities.target_temperature, 21);
  assert.equal(result.outputs.wakeUpAtMs, 600_000);
  state = result.nextState;

  result = stepVTherm(state, inputs(), CONFIG, 600_000);
  assert.equal(result.outputs.capabilities.vtherm_preset, 'comfort');
  assert.equal(result.outputs.capabilities.target_temperature, 19);
  assert.equal(result.nextState.persistent.timedPreset, null);
  assert.equal(result.nextState.persistent.preset, 'comfort');
  assert.equal(result.outputs.wakeUpAtMs, null);
  assert.deepEqual(result.outputs.events.filter((e) => e.kind === 'preset_changed'),
    [{ kind: 'preset_changed', preset: 'comfort' }]);
});

// --- wakeUpAtMs -------------------------------------------------------------

test('wakeUpAtMs vaut null quand rien n\'est en attente', () => {
  assert.equal(stepVTherm(freshState(), inputs(), CONFIG, 12_345).outputs.wakeUpAtMs, null);
});

test('wakeUpAtMs annonce la fin du délai de confirmation d\'ouverture', () => {
  const { outputs } = stepVTherm(freshState(), inputs({ windowContact: reading(true) }), CONFIG, 1_000);
  assert.equal(outputs.wakeUpAtMs, 31_000);
});

test('wakeUpAtMs annonce la fin du délai de confirmation de fermeture', () => {
  let state = freshState();
  state = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 0).nextState;
  state = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 30_000).nextState;

  const { outputs } = stepVTherm(state, inputs({ windowContact: reading(false) }), CONFIG, 40_000);
  assert.equal(outputs.wakeUpAtMs, 70_000);
});

test('wakeUpAtMs annonce la durée maximale de détection auto, et seulement en mode auto', () => {
  const auto = config({ window: { ...CONFIG.window, mode: 'auto' } });
  let state = freshState();

  // Chute de 0,6 °C par 10 min, soit −3,6 °C/h : au-delà du seuil de 3 °C/h, mais il faut
  // quatre points avant que la pente soit publiée et puisse déclencher quoi que ce soit.
  for (const [index, temp] of [20, 19.4, 18.8, 18.2].entries()) {
    const at = index * 600_000;
    state = stepVTherm(state, inputs({ roomTemp: reading(temp, at) }), auto, at).nextState;
  }
  assert.equal(state.persistent.window.phase, 'pending_open');

  // Confirmation après le délai, sur la même mesure.
  state = stepVTherm(state, inputs({ roomTemp: reading(18.2, 1_800_000) }), auto, 1_830_000).nextState;
  assert.equal(state.persistent.window.phase, 'open');

  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(18.2, 1_800_000) }), auto, 1_840_000);
  assert.equal(outputs.wakeUpAtMs, 1_830_000 + 1_800_000);
});

test('wakeUpAtMs annonce la confirmation de mouvement', () => {
  const cfg = config({ motion: { ...CONFIG.motion, enabled: true } });
  const { outputs } = stepVTherm(freshState({ preset: 'activity' }), inputs({ motion: reading(true) }), cfg, 5_000);

  assert.equal(outputs.wakeUpAtMs, 35_000, '5 s + motion_delay de 30 s');
});

test('wakeUpAtMs annonce la déconfirmation de mouvement, avec son délai propre', () => {
  const cfg = config({ motion: { ...CONFIG.motion, enabled: true } });
  let state = freshState({ preset: 'activity' });

  state = stepVTherm(state, inputs({ motion: reading(true) }), cfg, 0).nextState;
  state = stepVTherm(state, inputs({ motion: reading(true) }), cfg, 30_000).nextState;
  assert.equal(state.volatile.motion.confirmed, true);

  const { outputs } = stepVTherm(state, inputs({ motion: reading(false) }), cfg, 40_000);
  assert.equal(outputs.wakeUpAtMs, 40_000 + 300_000, 'motion_off_delay de 300 s');
});

test('wakeUpAtMs retient toujours l\'échéance la plus proche', () => {
  const state = freshState({
    timedPreset: { preset: 'boost', untilMs: 100_000, previous: 'comfort' },
  });

  // Fenêtre en attente à t=1 000 → 31 000, preset temporisé → 100 000.
  const near1 = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 1_000);
  assert.equal(near1.outputs.wakeUpAtMs, 31_000);

  // Preset temporisé rapproché : c'est lui qui l'emporte.
  const state2 = freshState({
    timedPreset: { preset: 'boost', untilMs: 20_000, previous: 'comfort' },
  });
  const near2 = stepVTherm(state2, inputs({ windowContact: reading(true) }), CONFIG, 1_000);
  assert.equal(near2.outputs.wakeUpAtMs, 20_000);
});

test('détection fenêtre désactivée : aucun réveil réclamé même contact ouvert', () => {
  const cfg = config({ window: { ...CONFIG.window, mode: 'off' } });
  const { outputs } = stepVTherm(freshState(), inputs({ windowContact: reading(true) }), cfg, 0);

  assert.equal(outputs.wakeUpAtMs, null);
  assert.equal(outputs.stateLabel, 'heating');
});

// --- Événements -------------------------------------------------------------

test('aucun événement au tout premier pas : pas de Flow fantôme au démarrage de l\'app', () => {
  const { outputs } = stepVTherm(freshState(), inputs(), CONFIG, 0);
  assert.deepEqual(outputs.events, []);
});

test('les événements partent une seule fois sur un changement, pas à chaque pas', () => {
  const world = inputs({ windowContact: reading(true) });
  let state = freshState();

  state = stepVTherm(state, world, CONFIG, 0).nextState;

  // Confirmation : la fenêtre s'ouvre, l'état change, la demande s'arrête.
  const opening = stepVTherm(state, world, CONFIG, 30_000);
  assert.deepEqual(opening.outputs.events.map((e) => e.kind).sort(), [
    'demand_stopped', 'state_changed', 'window_opened',
  ]);
  state = opening.nextState;

  // Pas suivants, entrées identiques : plus rien ne part.
  for (const t of [60_000, 90_000, 120_000]) {
    const next = stepVTherm(state, world, CONFIG, t);
    assert.deepEqual(next.outputs.events, [], `pas à t=${t}`);
    state = next.nextState;
  }

  // Fermeture confirmée : les événements symétriques partent, une seule fois.
  const closed = inputs({ windowContact: reading(false) });
  state = stepVTherm(state, closed, CONFIG, 130_000).nextState;
  const closing = stepVTherm(state, closed, CONFIG, 160_000);
  assert.deepEqual(closing.outputs.events.map((e) => e.kind).sort(), [
    'demand_started', 'state_changed', 'window_closed',
  ]);

  assert.deepEqual(stepVTherm(closing.nextState, closed, CONFIG, 190_000).outputs.events, []);
});

test('demand_started porte le pourcentage réellement commandé', () => {
  let state = freshState();
  state = stepVTherm(state, inputs({ roomTemp: reading(25) }), CONFIG, 0).nextState;

  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(18, 1) }), CONFIG, 60_000);
  assert.deepEqual(outputs.events.filter((e) => e.kind === 'demand_started'),
    [{ kind: 'demand_started', percent: 74 }]);
});

test('une demande qui devient inconnue arrête la demande : jamais de chaudière sur de l\'inconnu', () => {
  let state = freshState();
  state = stepVTherm(state, inputs(), CONFIG, 0).nextState;

  // Aucun capteur DÉSIGNÉ : rien à secourir, la demande devient inconnue. Un capteur désigné qui
  // se tait, lui, passe désormais par le mode sécurité — c'est un autre cas, testé plus haut.
  const world = inputs({ roomTemp: null, roomSensorBound: false });
  const { outputs } = stepVTherm(state, world, CONFIG, 60_000);
  assert.deepEqual(outputs.demand, { kind: 'unknown' });
  assert.ok(outputs.events.some((e) => e.kind === 'demand_stopped'));
});

test('le bypass neutralise l\'action fenêtre sans effacer la détection', () => {
  let state = freshState();
  const open = inputs({ windowContact: reading(true), windowBypass: true });

  state = stepVTherm(state, open, CONFIG, 0).nextState;
  const { outputs, nextState } = stepVTherm(state, open, CONFIG, 30_000);

  assert.equal(nextState.persistent.window.phase, 'open', 'la machine à états suit le capteur');
  assert.equal(outputs.stateLabel, 'heating', 'mais l\'action est neutralisée');
  assert.equal(outputs.valvePercent, null, '74 % déjà écrit au pas précédent');
  assert.deepEqual(outputs.demand, { kind: 'active', percent: 74 });
  // Le déclencheur Flow suit la détection, pas l'action.
  assert.ok(outputs.events.some((e) => e.kind === 'window_opened'));
});

// --- Mémento fenêtre --------------------------------------------------------

test('le mémento capture l\'état d\'avant l\'ouverture et se vide à la fermeture', () => {
  let state = freshState();
  const open = inputs({ windowContact: reading(true) });

  state = stepVTherm(state, open, CONFIG, 0).nextState;
  assert.equal(state.persistent.windowMemento, null, 'rien tant que la détection n\'est pas confirmée');

  state = stepVTherm(state, open, CONFIG, 30_000).nextState;
  assert.deepEqual(state.persistent.windowMemento, { onoff: true, preset: 'comfort', setpoint: 19 });

  const closed = inputs({ windowContact: reading(false) });
  state = stepVTherm(state, closed, CONFIG, 40_000).nextState;
  assert.notEqual(state.persistent.windowMemento, null, 'encore en confirmation de fermeture');

  state = stepVTherm(state, closed, CONFIG, 70_000).nextState;
  assert.equal(state.persistent.windowMemento, null);
});

// --- Capabilities -----------------------------------------------------------

test('les capabilities publient la consigne CHOISIE, pas celle envoyée à l\'émetteur', () => {
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true) });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.equal(outputs.capabilities.target_temperature, 19, 'ce que l\'utilisateur a demandé');
  assert.equal(outputs.capabilities.vtherm_regulated_setpoint, 20.5, 'ce qui part réellement');
});

test('alarm_contact et alarm_motion ne sont publiées que si la source existe', () => {
  const bare = stepVTherm(freshState(), inputs(), CONFIG, 0).outputs;
  assert.equal('alarm_contact' in bare.capabilities, false);
  assert.equal('alarm_motion' in bare.capabilities, false);

  const cfg = config({ motion: { ...CONFIG.motion, enabled: true } });
  const wired = stepVTherm(freshState(), inputs({ windowContact: reading(false) }), cfg, 0).outputs;
  assert.equal(wired.capabilities.alarm_contact, false);
  assert.equal(wired.capabilities.alarm_motion, false);
});

/** Série de mesures régulières à +0,6 °C/h : quatre points, le minimum pour publier une pente. */
function climb(state: VThermState): VThermState {
  let current = state;
  for (const [index, temp] of [18, 18.1, 18.2, 18.3].entries()) {
    const at = index * 600_000;
    current = stepVTherm(current, inputs({ roomTemp: reading(temp, at) }), CONFIG, at).nextState;
  }
  return current;
}

test('la pente n\'est publiée qu\'après assez de mesures, puis gelée quand le capteur se tait', () => {
  let state = freshState();

  // Trois premiers points : une pente calculée sur si peu est du bruit de capteur, pas une tendance.
  for (const [index, temp] of [18, 18.1, 18.2].entries()) {
    const at = index * 600_000;
    const step = stepVTherm(state, inputs({ roomTemp: reading(temp, at) }), CONFIG, at);
    assert.equal(step.outputs.slopePerHour, null, `point ${index + 1}`);
    assert.equal('vtherm_slope' in step.outputs.capabilities, false);
    state = step.nextState;
  }

  const fourth = stepVTherm(state, inputs({ roomTemp: reading(18.3, 1_800_000) }), CONFIG, 1_800_000);
  assert.equal(fourth.outputs.slopePerHour, 0.6, '+0,1 °C par 10 min = 0,6 °C/h');
  assert.equal(fourth.outputs.capabilities.vtherm_slope, 0.6);
  state = fourth.nextState;

  const mute = stepVTherm(state, inputs({ roomTemp: null }), CONFIG, 1_860_000);
  assert.equal(mute.outputs.slopePerHour, 0.6, 'dernière pente connue, pas une remise à zéro');
});

test('deux pas sur la MÊME mesure ne fabriquent pas de pente', () => {
  const state = climb(freshState());

  // Même lecture rejouée : la pente ne doit pas se diluer vers zéro.
  const replay = stepVTherm(state, inputs({ roomTemp: reading(18.3, 1_800_000) }), CONFIG, 1_900_000);
  assert.equal(replay.outputs.slopePerHour, 0.6);
});

// --- Bornes -----------------------------------------------------------------

test('la course mécanique de la vanne est parcourue entièrement, et se ferme sur demande nulle', () => {
  const cfg = config({ minOpeningDegree: 20, maxOpeningDegree: 80 });

  // on_percent = 0,6 × 0,1 + 0,01 × 14 = 0,2 → 20 + (80 − 20) × 0,2 = 32 %.
  // Un simple bornage rendrait 20 % et n'utiliserait qu'une fraction de la course.
  const small = stepVTherm(freshState(), inputs({ roomTemp: reading(18.9) }), cfg, 0).outputs;
  assert.equal(small.valvePercent, 32);

  // Demande saturée : exactement le plafond.
  const large = stepVTherm(freshState(), inputs({ roomTemp: reading(10) }), cfg, 0).outputs;
  assert.equal(large.valvePercent, 80);

  // Demande nulle : la vanne ferme complètement, le plancher ne s'applique pas.
  const none = stepVTherm(freshState(), inputs({ roomTemp: reading(25) }), cfg, 0).outputs;
  assert.equal(none.valvePercent, 0);
  assert.deepEqual(none.demand, { kind: 'inactive' });
});

test('opening_threshold ferme la vanne et retire la demande, sur l\'échelle de on_percent', () => {
  // Le seuil est une fraction 0..1, pas des points de pourcentage d'ouverture.
  const cfg = config({ openingThreshold: 0.25 });

  // on_percent = 0,2, sous le seuil de 0,25.
  const { outputs } = stepVTherm(freshState(), inputs({ roomTemp: reading(18.9) }), cfg, 0);
  assert.equal(outputs.valvePercent, 0);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
  assert.equal(outputs.stateLabel, 'idle');

  // Au-dessus du seuil, la demande repart. on_percent = 0,6 × 1 + 0,14 = 0,74.
  const above = stepVTherm(freshState(), inputs(), cfg, 0).outputs;
  assert.equal(above.demand.kind, 'active');
});

test('sous le seuil, un maxClosingDegree abaissé laisse le filet d\'ouverture voulu', () => {
  // La vanne garde 10 % d'ouverture, mais elle ne compte toujours pas pour la chaudière :
  // un filet d'antigel n'est pas une demande de chaleur.
  const cfg = config({ openingThreshold: 0.25, maxClosingDegree: 90 });
  const { outputs } = stepVTherm(freshState(), inputs({ roomTemp: reading(18.9) }), cfg, 0);

  assert.equal(outputs.valvePercent, 10);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
});

test('la consigne envoyée est bornée et alignée sur le pas de 0,5 °C', () => {
  const cfg = config({ presetTemps: { ...DEFAULT_PRESET_TEMPS, comfort: 19.3 } });
  const world = inputs({ emitterMode: 'setpoint', emitterHeating: reading(true), roomTemp: reading(19.3) });

  const { outputs } = stepVTherm(freshState(), world, cfg, 0);
  assert.ok(outputs.setpointToEmitter !== null);
  assert.equal((outputs.setpointToEmitter * 2) % 1, 0, 'multiple de 0,5');
});

// --- Capteur de pièce muet : l'événement qui prévient l'utilisateur -----------

test('capteur de pièce muet : sensor_quiet part une seule fois, puis sensor_recovered au retour', () => {
  // Premier pas nominal : il ne publie aucun événement (rien n'a encore été publié), mais il amorce
  // l'instantané. C'est ce qui évite les Flows fantômes au démarrage de l'app.
  const first = stepVTherm(freshState(), inputs(), CONFIG, 0);
  assert.deepEqual(first.outputs.events, [], 'aucun Flow au premier pas');

  // La pile du capteur meurt : la mesure devient périmée.
  const quiet = stepVTherm(first.nextState, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 60_000);
  assert.ok(quiet.outputs.events.some((e) => e.kind === 'sensor_quiet'),
    'le capteur qui se tait doit être annonçable par un Flow');
  // La pièce chauffait franchement : le mode sécurité prend le relais plutôt que de la laisser
  // sans rien. L'événement part quand même — signaler ET secourir, pas l'un ou l'autre.
  assert.equal(quiet.outputs.stateLabel, 'safety');
  assert.equal(quiet.outputs.demand.kind, 'active');
  assert.ok(quiet.outputs.warning !== null, 'avec un avertissement sur l\'appareil');

  // Pas suivant, toujours muet : l'événement ne se répète pas.
  const stillQuiet = stepVTherm(quiet.nextState, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 120_000);
  assert.ok(!stillQuiet.outputs.events.some((e) => e.kind === 'sensor_quiet'),
    'un capteur toujours muet ne réémet pas à chaque pas');

  // La pile est remplacée.
  const back = stepVTherm(stillQuiet.nextState, inputs(), CONFIG, 180_000);
  assert.ok(back.outputs.events.some((e) => e.kind === 'sensor_recovered'));
  assert.equal(back.outputs.warning, null);
  assert.equal(back.outputs.demand.kind, 'active', 'la régulation reprend');
});

test('capteur muet sur un thermostat éteint : rien à annoncer', () => {
  // Un appareil éteint dont la pile est vide n'a aucune décision à prendre. Un bandeau permanent
  // serait un bandeau que l'utilisateur apprendrait à ignorer, y compris quand il compte.
  const first = stepVTherm(freshState(), inputs({ onoff: false }), CONFIG, 0);
  const quiet = stepVTherm(
    first.nextState,
    inputs({ onoff: false, roomTemp: reading(18, 0, true) }),
    CONFIG,
    60_000,
  );
  assert.ok(!quiet.outputs.events.some((e) => e.kind === 'sensor_quiet'));
  assert.equal(quiet.outputs.warning, null);
});

test('aucun capteur de pièce lié du tout : traité comme muet', () => {
  const first = stepVTherm(freshState(), inputs(), CONFIG, 0);
  const none = stepVTherm(first.nextState, inputs({ roomTemp: null, roomSensorBound: false }), CONFIG, 60_000);
  assert.ok(none.outputs.events.some((e) => e.kind === 'sensor_quiet'));
  assert.equal(none.outputs.demand.kind, 'unknown');
  assert.equal(none.outputs.setpointToEmitter, null, 'et aucune écriture ne part');
  assert.equal(none.outputs.valvePercent, null);
});

// --- Avertissement : une clé, et trois cas distincts -------------------------
//
// L'ancien texte annonçait « régulation suspendue, aucune commande envoyée » exactement dans le
// cas où le mode sécurité en envoyait une. Un avertissement qui dit le contraire de ce que fait
// l'app est pire que pas d'avertissement.

test('aucun capteur lié : la clé le dit, et ce n\'est pas la même que « périmé »', () => {
  const first = stepVTherm(freshState(), inputs(), CONFIG, 0);
  const none = stepVTherm(first.nextState, inputs({ roomTemp: null, roomSensorBound: false }), CONFIG, 60_000);
  assert.equal(none.outputs.warning, 'no_sensor');
});

test('capteur périmé sans sécurité : régulation suspendue, rien n\'est envoyé', () => {
  // La pièce ne chauffait pas assez pour que le mode sécurité s'applique.
  const state = freshState({ lastOnPercent: 0.1, lastGoodReadingAtMs: 0 });
  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 60_000);
  assert.equal(outputs.warning, 'sensor_stale');
  assert.equal(outputs.valvePercent, null, 'et l\'avertissement dit vrai : rien ne part');
});

test('capteur périmé avec sécurité : la clé ne prétend pas que rien n\'est envoyé', () => {
  const state = freshState({ lastOnPercent: 0.9, lastGoodReadingAtMs: 0 });
  const { outputs } = stepVTherm(state, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 60_000);
  assert.equal(outputs.warning, 'sensor_stale_safety');
  assert.equal(outputs.stateLabel, 'safety');
  assert.notEqual(outputs.valvePercent, null, 'une commande part bel et bien');
});

test('l\'avertissement est une clé de traduction, jamais une phrase', () => {
  // `lib/` est pur : il ne connaît aucune langue. Une phrase française en dur ferait échouer la
  // revue Athom dans une app trilingue, et se lirait telle quelle par un utilisateur néerlandais.
  const state = freshState({ lastOnPercent: 0.9, lastGoodReadingAtMs: 0 });
  for (const world of [inputs({ roomTemp: null }), inputs({ roomTemp: reading(18, 0, true) })]) {
    const warning = stepVTherm(state, world, CONFIG, 60_000).outputs.warning;
    assert.ok(warning !== null);
    assert.match(warning, /^[a-z_]+$/, `« ${warning} » n'est pas un identifiant de clé`);
  }
});

// --- Origine du compte à rebours du mode sécurité ----------------------------

test('l\'instant de la dernière mesure vivante est mémorisé', () => {
  const { nextState } = stepVTherm(freshState(), inputs(), CONFIG, 42_000);
  assert.equal(nextState.persistent.lastGoodReadingAtMs, 42_000);
});

test('capteur muet : l\'instant ne bouge plus, sinon la borne ne serait jamais atteinte', () => {
  const first = stepVTherm(freshState(), inputs(), CONFIG, 10_000);
  const quiet = stepVTherm(first.nextState, inputs({ roomTemp: reading(18, 0, true) }), CONFIG, 90_000);
  assert.equal(quiet.nextState.persistent.lastGoodReadingAtMs, 10_000);
});

test('mode sécurité : au-delà de 24 h de silence, il abandonne et la chaudière reste éteinte', () => {
  // C'est le cas de la pile morte en février : sans borne, la vanne resterait à 10 % et la
  // chaudière tournerait des semaines sur une mesure morte.
  const day = 24 * 60 * 60 * 1000;
  const state = freshState({ lastOnPercent: 0.9, lastGoodReadingAtMs: 0 });
  const world = inputs({ roomTemp: reading(18, 0, true) });

  const within = stepVTherm(state, world, CONFIG, day - 1_000);
  assert.equal(within.outputs.stateLabel, 'safety');
  assert.equal(within.outputs.demand.kind, 'active');

  const beyond = stepVTherm(state, world, CONFIG, day + 1_000);
  assert.notEqual(beyond.outputs.stateLabel, 'safety');
  assert.equal(beyond.outputs.demand.kind, 'unknown', 'et `unknown` laisse la chaudière éteinte');
  assert.equal(beyond.outputs.warning, 'sensor_stale', 'l\'avertissement cesse de promettre une chauffe');
});

// --- Le mode sécurité et les décisions qui abaissent la consigne -------------
//
// PANNE EMPÊCHÉE : une chaudière qui tourne contre une décision explicite de l'utilisateur.
// Le mode sécurité ne consultait que `roomTemp === null`. Les deux cas qui abaissent la consigne
// SANS couper la chauffe — hors-gel de vacances, action fenêtre `frost`/`eco` — lui échappaient
// donc entièrement : il remontait la pièce à sa consigne de secours, chaudière comprise, jusqu'à
// vingt-quatre heures, pendant que la tuile affichait `central` ou `window`.

const WINDOW_OPEN = { phase: 'open' as const, phaseSinceMs: 0, openSinceMs: 0, autoDisarmed: false };

/** Capteur mort, mais une puissance mémorisée assez haute pour armer la sécurité. */
function armedButMute(overrides: Partial<VThermState['persistent']> = {}): VThermState {
  return freshState({ lastOnPercent: 0.74, lastGoodReadingAtMs: 0, ...overrides });
}

test('sécurité : le hors-gel de vacances n\'est PAS renversé par un capteur mort', () => {
  const { outputs } = stepVTherm(
    armedButMute(), inputs({ roomTemp: null, centralMode: 'frost' }), CONFIG, 60_000,
  );

  // `unknown` et non `inactive` : sortie gelée faute de mesure. Ce qui compte est que
  // l'agrégateur ne compte QUE `active` — la chaudière reste donc éteinte pour cette pièce.
  assert.notEqual(outputs.demand.kind, 'active', 'la chaudière ne part pas');
  assert.notEqual(outputs.valvePercent, 10, 'aucune ouverture de secours');
  assert.equal(outputs.warning, 'sensor_stale', 'et l\'avertissement ne promet pas un minimum');
});

test('sécurité : le hors-gel de vacances n\'est pas renversé non plus par consigne', () => {
  const { outputs } = stepVTherm(
    armedButMute(),
    inputs({ roomTemp: null, centralMode: 'frost', emitterMode: 'setpoint', emitterHeating: reading(false) }),
    CONFIG, 60_000,
  );

  assert.notEqual(outputs.setpointToEmitter, 19, 'la consigne de secours ne remonte pas la pièce');
  assert.notEqual(outputs.demand.kind, 'active');
});

test('sécurité : une fenêtre ouverte n\'est pas renversée par un capteur mort', () => {
  const { outputs } = stepVTherm(
    armedButMute({ window: WINDOW_OPEN }), inputs({ roomTemp: null }),
    config({ window: { ...CONFIG.window, action: 'frost' } }), 60_000,
  );

  assert.notEqual(outputs.demand.kind, 'active');
  assert.equal(outputs.warning, 'sensor_stale');
});

test('sécurité : elle agit toujours quand RIEN n\'a abaissé la consigne', () => {
  // La contrepartie indispensable : brider la sécurité ne doit pas la désarmer dans son cas nominal.
  const { outputs } = stepVTherm(armedButMute(), inputs({ roomTemp: null }), CONFIG, 60_000);

  assert.equal(outputs.demand.kind, 'active', 'la pièce reçoit son minimum');
  assert.equal(outputs.warning, 'sensor_stale_safety');
});

test('sécurité : `heat_only` régule normalement, donc elle agit encore', () => {
  // `heat_only` n'abaisse rien — seule l'étiquette change. La brider là serait une régression.
  const { outputs } = stepVTherm(
    armedButMute(), inputs({ roomTemp: null, centralMode: 'heat_only' }), CONFIG, 60_000,
  );

  assert.equal(outputs.demand.kind, 'active');
  assert.equal(outputs.warning, 'sensor_stale_safety');
});

// --- La mémoire de puissance, que le mode sécurité interroge -----------------

test('un pas à consigne abaissée n\'efface PAS la mémoire de puissance', () => {
  // C'est le chemin de la maison froide : une fenêtre ouverte dix minutes remettait la mémoire à
  // zéro, et le mode sécurité restait désarmé pour toutes les pannes de capteur suivantes.
  const cases: ReadonlyArray<readonly [string, VThermState, VThermInputs, VThermConfig]> = [
    ['fenêtre ouverte (turn_off)', armedButMute({ window: WINDOW_OPEN }), inputs(), CONFIG],
    ['fenêtre ouverte (frost)', armedButMute({ window: WINDOW_OPEN }), inputs(),
      config({ window: { ...CONFIG.window, action: 'frost' } })],
    ['hors-gel de vacances', armedButMute(), inputs({ centralMode: 'frost' }), CONFIG],
    ['thermostat éteint un seul pas', armedButMute(), inputs({ onoff: false }), CONFIG],
  ];

  for (const [label, state, input, cfg] of cases) {
    const { nextState } = stepVTherm(state, input, cfg, 60_000);
    assert.equal(nextState.persistent.lastOnPercent, 0.74, label);
  }
});

test('un pas de régulation normal met bien la mémoire à jour', () => {
  // La contrepartie : la mémoire doit rester vivante, sinon elle vieillit indéfiniment.
  const { nextState } = stepVTherm(armedButMute(), inputs(), CONFIG, 60_000);
  near(nextState.persistent.lastOnPercent, 0.74);

  const warmer = stepVTherm(armedButMute(), inputs({ roomTemp: reading(18.5) }), CONFIG, 60_000);
  near(warmer.nextState.persistent.lastOnPercent, 0.44);
});

test('le scénario de janvier, de bout en bout', () => {
  // Pièce en chauffe, fenêtre ouverte, pile de capteur qui meurt pendant l'aération, fenêtre
  // refermée. La sécurité doit prendre le relais — c'est exactement ce pour quoi elle existe.
  let state = armedButMute();
  ({ nextState: state } = stepVTherm(state, inputs(), CONFIG, 0));
  near(state.persistent.lastOnPercent, 0.74);

  // La fenêtre s'ouvre et est confirmée.
  state = { ...state, persistent: { ...state.persistent, window: WINDOW_OPEN } };
  ({ nextState: state } = stepVTherm(state, inputs(), CONFIG, 60_000));

  // Le capteur meurt pendant l'aération, puis la fenêtre se referme.
  ({ nextState: state } = stepVTherm(state, inputs({ roomTemp: null }), CONFIG, 120_000));
  state = { ...state, persistent: { ...state.persistent, window: createVThermState(0, DEFAULTS).persistent.window } };

  const { outputs } = stepVTherm(state, inputs({ roomTemp: null }), CONFIG, 300_000);
  assert.equal(outputs.demand.kind, 'active', 'la pièce n\'est pas laissée sans rien');
  assert.equal(outputs.warning, 'sensor_stale_safety');
});

// --- La pente doit atteindre le TPI ------------------------------------------

test('la pente est bien transmise au TPI, et coupe la chauffe en dépassement', () => {
  // TROU DE COUVERTURE : toutes les fixtures d'intégration réglaient les deux seuils à 0, ce qui
  // court-circuite tout le bloc. Passer `slopePerHour: null` au calcul laissait la suite verte —
  // la SPEC §4 en fait pourtant une entrée OBLIGATOIRE, pas un raffinement.
  //
  // Le terme extérieur est volontairement dominant : sans lui, le dépassement seul ramènerait déjà
  // la puissance à zéro par saturation, et le test ne prouverait rien des seuils.
  const withThresholds = config({
    tpi: { coefInt: 0.6, coefExt: 0.1, thresholdHigh: 0.2, thresholdLow: 0.1 },
  });

  // Cinq mesures montantes : quatre pour rendre la pente publiable, la dernière en dépassement.
  let state = freshState();
  let last = stepVTherm(state, inputs({ roomTemp: reading(19.0, 0) }), withThresholds, 0);
  [19.1, 19.2, 19.3, 19.4].forEach((t, i) => {
    const at = (i + 1) * 60_000;
    state = last.nextState;
    last = stepVTherm(state, inputs({ roomTemp: reading(t, at) }), withThresholds, at);
  });

  assert.ok(last.outputs.slopePerHour !== null && last.outputs.slopePerHour > 0, 'la pièce monte');
  assert.equal(
    last.outputs.onPercent, 0,
    'pente montante + dépassement au-delà du seuil haut : la chauffe est coupée',
  );

  // Sans les seuils, la même situation chauffe à fond — c'est ce que la pente évite.
  const noThresholds = config({ tpi: { coefInt: 0.6, coefExt: 0.1, thresholdHigh: 0, thresholdLow: 0 } });
  const uncut = stepVTherm(state, inputs({ roomTemp: reading(19.4, 240_000) }), noThresholds, 240_000);
  assert.ok(uncut.outputs.onPercent > 0.9, 'la preuve que le seuil est bien ce qui a coupé');
});
