/**
 * Pilotage d'un émetteur par interrupteur (`over_switch` de VT).
 *
 * Le découpage temporel lui-même est couvert par `test/dutyCycle.test.mts`. Ce qui se joue ici est
 * la COMPOSITION : que le TPI, le découpage, les priorités (arrêt, fenêtre, capteur muet), les
 * réveils et l'état durable s'emboîtent correctement — c'est-à-dire tout ce qu'un test du seul
 * `stepDutyCycle` laisse passer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepVTherm } from '../lib/step.mjs';
import { createVThermState, migratePersistentState, restoreVThermState } from '../lib/state.mjs';
import { createDutyCycleState } from '../lib/dutyCycle.mjs';
import {
  DEFAULT_AWAY_TEMPS, DEFAULT_EXPERT_REGULATION, DEFAULT_PRESET_TEMPS, DEFAULT_SAFETY,
  DEFAULT_SLOPE,
} from '../lib/constants.mjs';
import type {
  Reading, VThermConfig, VThermInputs, VThermState, VThermStateDefaults,
} from '../lib/types.mjs';

// --- Fixtures ---------------------------------------------------------------

const DEFAULTS: VThermStateDefaults = { preset: 'comfort', manualSetpoint: 19 };

/** Cycle de 5 min = 300 000 ms, gardes à 30 s. Presets : confort 19, hors-gel 7. */
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

const CYCLE_MS = 300_000;

/** Borne de durée du mode sécurité : 24 h, la valeur par défaut. */
const DAY_MS = 24 * 60 * 60 * 1000;

function config(overrides: Partial<VThermConfig> = {}): VThermConfig {
  return { ...CONFIG, ...overrides };
}

function reading<T>(value: T, atMs = 0, stale = false): Reading<T> {
  return { value, atMs, stale };
}

/** Pièce à 18 °C, extérieur à 5 °C, émetteur piloté par interrupteur. */
function inputs(overrides: Partial<VThermInputs> = {}): VThermInputs {
  return {
    roomTemp: reading(18),
    roomSensorBound: true,
    outdoorTemp: reading(5),
    windowContact: null,
    motion: null,
    presence: null,
    emitterHeating: null,
    emitterMode: 'switch',
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

// --- TPI et découpage temporel ----------------------------------------------

test('le TPI rend la MÊME puissance qu\'en mode vanne, et elle devient du temps de marche', () => {
  const world = inputs();

  // 0,6 × (19 − 18) + 0,01 × (19 − 5) = 0,74 — identique au mode vanne, même entrée, même formule.
  const asValve = stepVTherm(freshState(), { ...world, emitterMode: 'valve' }, CONFIG, 0);
  const asSwitch = stepVTherm(freshState(), world, CONFIG, 0);

  near(asSwitch.outputs.onPercent, 0.74);
  near(asSwitch.outputs.onPercent, asValve.outputs.onPercent);

  // 74 % d'un cycle de 5 min : 222 s allumé, puis 78 s éteint.
  assert.equal(asSwitch.outputs.switchOn?.[0] ?? null, true);
  assert.equal(asSwitch.outputs.wakeUpAtMs, 222_000);
  assert.equal(asSwitch.outputs.valvePercent, null, 'aucune vanne à commander');
  assert.equal(asSwitch.outputs.setpointToEmitter, null, 'un interrupteur ne reçoit pas de consigne');
});

test('la bascule de fin de marche a lieu à l\'heure annoncée, pas au battement suivant', () => {
  let state = freshState();

  let result = stepVTherm(state, inputs(), CONFIG, 0);
  assert.equal(result.outputs.switchOn?.[0] ?? null, true);
  state = result.nextState;

  // Réveillé sur l'échéance annoncée : la période de marche est consommée, on coupe.
  result = stepVTherm(state, inputs(), CONFIG, 222_000);
  assert.equal(result.outputs.switchOn?.[0] ?? null, false);
  assert.equal(result.outputs.wakeUpAtMs, CYCLE_MS, 'prochaine échéance : la fin du cycle');
  state = result.nextState;

  // Fin du cycle : un nouveau démarre, le relais se rallume.
  result = stepVTherm(state, inputs(), CONFIG, CYCLE_MS);
  assert.equal(result.outputs.switchOn?.[0] ?? null, true);
  assert.equal(result.outputs.wakeUpAtMs, CYCLE_MS + 222_000);
});

test('le réveil du cycle se compose avec les autres échéances : la plus proche gagne', () => {
  // Preset temporisé qui expire à 60 s, bien avant la fin de la période de marche (222 s).
  const state = freshState({
    timedPreset: { preset: 'boost', untilMs: 60_000, previous: 'comfort' },
  });

  const { outputs } = stepVTherm(state, inputs(), CONFIG, 0);
  assert.equal(outputs.wakeUpAtMs, 60_000);
});

test('une demande trop faible n\'allume pas du tout : la garde de durée minimale de marche', () => {
  // 0,6 × (19 − 18,95) = 3 % du cycle, soit 9 s — sous les 30 s de `minActivationSec`.
  const world = inputs({ roomTemp: reading(18.95), outdoorTemp: null });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.equal(outputs.switchOn?.[0] ?? null, false);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
  assert.equal(outputs.stateLabel, 'idle');
});

test('une pause trop courte fait rester allumé tout le cycle : la garde de durée minimale d\'arrêt', () => {
  // 0,6 × (19 − 17,45) = 93 % du cycle : les 21 s d'arrêt restantes sont sous les 30 s.
  const world = inputs({ roomTemp: reading(17.45), outdoorTemp: null });
  const { outputs } = stepVTherm(freshState(), world, CONFIG, 0);

  assert.equal(outputs.switchOn?.[0] ?? null, true);
  assert.equal(outputs.wakeUpAtMs, CYCLE_MS, 'aucune coupure avant la fin du cycle');
});

// --- Écritures : seulement quand elles servent -------------------------------

test('`switchOn` reste `null` tant que rien ne change : un relais s\'use en commutations', () => {
  let state = freshState();

  const first = stepVTherm(state, inputs(), CONFIG, 0);
  assert.equal(first.outputs.switchOn?.[0] ?? null, true, 'première commande : elle doit partir');
  state = first.nextState;

  // Milieu de la période de marche : même décision, aucune écriture.
  const second = stepVTherm(state, inputs(), CONFIG, 100_000);
  assert.equal(second.outputs.switchOn?.[0] ?? null, null);
  assert.equal(second.outputs.demand.kind, 'active', 'la demande, elle, reste vivante');
});

test('la première commande part même si le cycle relu dit que le relais est déjà bon', () => {
  // Redémarrage de l'app : l'état durable dit « allumé », mais rien ne garantit que le relais n'a
  // pas été basculé à la main pendant l'arrêt.
  const state = restoreVThermState(
    { ...freshState().persistent, dutyCycle: { cycleStartMs: 0, commanded: [true] } },
    100_000,
    DEFAULTS,
  );

  const { outputs } = stepVTherm(state, inputs(), CONFIG, 100_000);
  assert.equal(outputs.switchOn?.[0] ?? null, true, 'réaffirmée : aucune commande n\'est encore partie');
});

test('un redémarrage ne relance pas un cycle neuf : le temps de marche n\'est pas doublé', () => {
  // Cycle commencé à t=0, redémarrage à t=100 s. Sans persistance, le cycle repartirait de 100 s
  // et le radiateur ferait 222 s de marche de plus — le double de ce qui était demandé.
  const state = restoreVThermState(
    { ...freshState().persistent, dutyCycle: { cycleStartMs: 0, commanded: [true] } },
    100_000,
    DEFAULTS,
  );

  const { outputs } = stepVTherm(state, inputs(), CONFIG, 100_000);
  assert.equal(outputs.wakeUpAtMs, 222_000, 'la coupure reste calée sur le cycle d\'origine');
});

// --- Priorités ---------------------------------------------------------------

test('arrêt commandé : l\'interrupteur est éteint', () => {
  let state = stepVTherm(freshState(), inputs(), CONFIG, 0).nextState;

  const { outputs, nextState } = stepVTherm(state, inputs({ onoff: false }), CONFIG, 60_000);
  assert.equal(outputs.switchOn?.[0] ?? null, false);
  assert.deepEqual(outputs.demand, { kind: 'inactive' });
  assert.equal(outputs.stateLabel, 'off');
  assert.deepEqual(nextState.persistent.dutyCycle.commanded, [false]);

  state = nextState;
  // Et il le reste, sans réécrire à chaque pas.
  assert.equal(stepVTherm(state, inputs({ onoff: false }), CONFIG, 120_000).outputs.switchOn?.[0] ?? null, null);
});

test('mode central `stopped` : l\'interrupteur est éteint', () => {
  const state = stepVTherm(freshState(), inputs(), CONFIG, 0).nextState;

  const { outputs } = stepVTherm(state, inputs({ centralMode: 'stopped' }), CONFIG, 60_000);
  assert.equal(outputs.switchOn?.[0] ?? null, false);
  assert.equal(outputs.stateLabel, 'central');
});

test('action fenêtre `turn_off` confirmée : l\'interrupteur est éteint', () => {
  let state = freshState();

  // t=0 : contact ouvert mais délai non écoulé, la chauffe continue.
  let result = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 0);
  assert.equal(result.outputs.switchOn?.[0] ?? null, true);
  state = result.nextState;

  // t=30 s : détection confirmée, le relais coupe.
  result = stepVTherm(state, inputs({ windowContact: reading(true) }), CONFIG, 30_000);
  assert.equal(result.outputs.stateLabel, 'window');
  assert.equal(result.outputs.switchOn?.[0] ?? null, false);
  assert.deepEqual(result.outputs.demand, { kind: 'inactive' });
});

test('capteur muet : le relais est COUPÉ, jamais laissé en l\'état', () => {
  // Le gel de sortie est le bon repli pour une vanne : passive, sans eau chaude dedans elle ne
  // chauffe rien. Transposé à un relais, il laissait un convecteur allumé indéfiniment sur une
  // mesure morte — un radiateur qui a sa propre source d'énergie et que plus rien n'arrête.
  const first = stepVTherm(freshState(), inputs(), CONFIG, 0);
  assert.equal(first.outputs.switchOn?.[0] ?? null, true);

  const world = inputs({ roomTemp: reading(18, 0, true) });
  const { outputs } = stepVTherm(first.nextState, world, CONFIG, 100_000);

  assert.equal(outputs.switchOn?.[0] ?? null, false, 'le convecteur doit s\'éteindre, pas rester allumé');
  assert.deepEqual(outputs.demand, { kind: 'inactive' }, 'décision délibérée, pas une ignorance');
  assert.equal(outputs.capabilities.vtherm_power_percent, 0,
    'et l\'écran le dit : 74 % affichés sur un convecteur éteint serait un mensonge');
});

test('capteur muet : la coupure ne se réécrit pas à chaque pas', () => {
  // Une fois coupé, le relais reste coupé sans qu'on use le contacteur à le redire.
  let state = stepVTherm(freshState(), inputs(), CONFIG, 0).nextState;
  const world = inputs({ roomTemp: reading(18, 0, true) });

  const cut = stepVTherm(state, world, CONFIG, 100_000);
  assert.equal(cut.outputs.switchOn?.[0] ?? null, false);
  state = cut.nextState;

  assert.equal(stepVTherm(state, world, CONFIG, 160_000).outputs.switchOn?.[0] ?? null, null);
});

test('le mode sécurité ne s\'étend pas à l\'interrupteur : on coupe, on ne chauffe pas à l\'aveugle', () => {
  // Une pièce qui chauffait fort, puis un capteur muet : en mode vanne la sécurité force une
  // ouverture minimale, en mode consigne une consigne de repli. Sur un relais il n'y a rien à
  // doser — le repli sûr est de couper, et c'est bien ce qui doit se produire.
  const cfg = config({
    safety: {
      enabled: true, minOnPercent: 0.5, defaultOnPercent: 0.1, fallbackSetpoint: 19, maxDurationMs: DAY_MS,
    },
  });
  const state = freshState({ lastOnPercent: 0.9, dutyCycle: { cycleStartMs: 0, commanded: [true] } });

  const world = inputs({ roomTemp: reading(18, 0, true) });
  const { outputs } = stepVTherm(state, world, cfg, 100_000);

  assert.equal(outputs.switchOn?.[0] ?? null, false);
  assert.notEqual(outputs.stateLabel, 'safety');
});

// --- Réaffirmation sur divergence --------------------------------------------

test('le relais revenu à OFF tout seul est rallumé, même à puissance saturée', () => {
  // À `on_percent >= 1` l'état commandé ne change JAMAIS : `changed` est éternellement faux et
  // plus aucune écriture ne partait. Une micro-coupure Zigbee (la prise revient sur son
  // `power_on_behavior`, souvent OFF), une coupure de courant ou une bascule à la main, et la
  // pièce restait froide toute la journée pendant que l'app s'affichait « en chauffe ».
  const world = inputs({ roomTemp: reading(10), outdoorTemp: null });

  const first = stepVTherm(freshState(), world, CONFIG, 0);
  assert.equal(first.outputs.switchOn?.[0] ?? null, true, 'puissance saturée : marche continue');

  // Le relais dit OFF alors qu'on le commande ON : divergence.
  const diverged = stepVTherm(
    first.nextState,
    { ...world, emitterHeating: reading(false, 100_000) },
    CONFIG,
    100_000,
  );
  assert.equal(diverged.outputs.switchOn?.[0] ?? null, true, 'réaffirmé sur divergence');
});

test('aucune réaffirmation tant que le relais est d\'accord avec nous', () => {
  const world = inputs({ roomTemp: reading(10), outdoorTemp: null });

  const first = stepVTherm(freshState(), world, CONFIG, 0);
  const agreed = stepVTherm(
    first.nextState,
    { ...world, emitterHeating: reading(true, 100_000) },
    CONFIG,
    100_000,
  );

  assert.equal(agreed.outputs.switchOn?.[0] ?? null, null, 'un contacteur se compte en commutations');
});

test('un état de relais périmé ne déclenche aucune réaffirmation', () => {
  // Une lecture périmée n'est pas une divergence : c'est une ignorance. Réaffirmer là-dessus
  // ferait claquer le contacteur sur une information qui date d'on ne sait quand.
  const world = inputs({ roomTemp: reading(10), outdoorTemp: null });

  const first = stepVTherm(freshState(), world, CONFIG, 0);
  const stale = stepVTherm(
    first.nextState,
    { ...world, emitterHeating: reading(false, 0, true) },
    CONFIG,
    100_000,
  );

  assert.equal(stale.outputs.switchOn?.[0] ?? null, null);
});

// --- Demande de chaleur ------------------------------------------------------

test('demande de chaleur = interrupteur commandé allumé', () => {
  let state = freshState();

  let result = stepVTherm(state, inputs(), CONFIG, 0);
  assert.deepEqual(result.outputs.demand, { kind: 'active', percent: 74 });
  state = result.nextState;

  // Période d'arrêt du cycle : plus aucune demande, l'émetteur ne consomme rien.
  result = stepVTherm(state, inputs(), CONFIG, 222_000);
  assert.deepEqual(result.outputs.demand, { kind: 'inactive' });
  assert.equal(result.outputs.stateLabel, 'idle');
});

test('la demande n\'attend AUCUNE lecture de l\'émetteur', () => {
  // En mode consigne, un émetteur qui ne rapporte pas son état de chauffe rend la demande
  // `unknown` et laisse la chaudière éteinte. Sur un relais, c'est nous qui commandons : il n'y a
  // rien à ignorer.
  const { outputs } = stepVTherm(freshState(), inputs({ emitterHeating: null }), CONFIG, 0);
  assert.equal(outputs.demand.kind, 'active');
});

// --- État durable ------------------------------------------------------------

test('l\'état du cycle est bien celui que le pas a produit', () => {
  const { nextState } = stepVTherm(freshState(), inputs(), CONFIG, 40_000);
  assert.deepEqual(nextState.persistent.dutyCycle, { cycleStartMs: 40_000, commanded: [true] });
});

test('l\'état du cycle survit à une migration, y compris au FORMAT d\'avant les groupes', () => {
  // `commanded` était un booléen nu avant que les têtes ne soient déphasées. Le lire comme
  // illisible remettrait le relais à « éteint » au premier pas suivant la mise à jour : une
  // commutation de contacteur gratuite sur chaque thermostat de la maison, à chaque version.
  const stored = { ...freshState().persistent, dutyCycle: { cycleStartMs: 12_345, commanded: true } };
  const migrated = migratePersistentState(stored, 12_345, DEFAULTS);

  assert.deepEqual(migrated.dutyCycle, { cycleStartMs: 12_345, commanded: [true] });
});

test('l\'état d\'un groupe se relit tête par tête', () => {
  const stored = {
    ...freshState().persistent,
    dutyCycle: { cycleStartMs: 12_345, commanded: [true, false, true] },
  };

  assert.deepEqual(
    migratePersistentState(stored, 12_345, DEFAULTS).dutyCycle.commanded,
    [true, false, true],
    'les têtes sont déphasées : les aplatir en un seul booléen les ferait toutes commuter ensemble',
  );
});

test('un état de cycle absent ou corrompu retombe sur le défaut', () => {
  const base = freshState().persistent;
  const migrate = (dutyCycle: unknown) =>
    migratePersistentState({ ...base, dutyCycle }, 0, DEFAULTS).dutyCycle;

  // Version antérieure du `store` : le champ n'existait pas.
  assert.deepEqual(migrate(undefined), createDutyCycleState());
  assert.deepEqual(migrate(null), createDutyCycleState());
  assert.deepEqual(migrate('allumé'), createDutyCycleState());
  // `commanded` illisible : l'état entier est douteux, on repart de zéro.
  assert.deepEqual(migrate({ cycleStartMs: 1_000, commanded: 'oui' }), createDutyCycleState());
  // Un début de cycle illisible devient `null` : le prochain pas ouvre un cycle neuf, plutôt que
  // de croire à un temps de marche déjà consommé.
  assert.deepEqual(migrate({ cycleStartMs: Number.NaN, commanded: true }),
    { cycleStartMs: null, commanded: [true] });
  assert.deepEqual(migrate({ cycleStartMs: 'hier', commanded: false }),
    { cycleStartMs: null, commanded: [false] });
  // Une entrée illisible DANS la liste vaut « éteint » plutôt que d'invalider tout le groupe :
  // ce n'est qu'une écriture de plus sur cette tête, là où tout jeter en coûterait une sur toutes.
  assert.deepEqual(migrate({ cycleStartMs: 1_000, commanded: [true, 'oui', false] }),
    { cycleStartMs: 1_000, commanded: [true, false, false] });
});

// --- Un thermostat, plusieurs convecteurs -------------------------------------
//
// Ce que la composition ajoute au déphasage déjà couvert par `test/dutyCycle.test.mts` : la demande
// de chaleur remontée à la chaudière, et la détection de divergence. Les deux se lisaient sur un
// booléen unique, et les deux deviennent faux sur un groupe si on ne change rien — la demande
// parce qu'un relais éteint parmi deux ne veut pas dire que la pièce ne chauffe pas, la divergence
// parce que comparer l'état d'une tête à l'ordre donné à une autre en invente une à chaque pas.

/**
 * Sans terme extérieur, pour que la puissance se lise à l'œil : 0,6 × (19 − 18,5) = 0,30.
 *
 * 30 % d'un cycle de 5 min = 90 s de marche, décalées de 150 s entre deux têtes. La n°1 chauffe de
 * 0 à 90 s, la n°2 de 150 à 240 s : elles ne se recouvrent jamais, et chaque instant du cycle dit
 * quelque chose de différent des deux — ce qu'une puissance au-dessus de 50 % ne permettrait pas.
 */
const CFG_2 = config({ tpi: { coefInt: 0.6, coefExt: 0, thresholdHigh: 0, thresholdLow: 0 } });

/** Pièce à 18,5 °C, deux convecteurs. */
function twoHeads(overrides: Partial<VThermInputs> = {}): VThermInputs {
  return inputs({ roomTemp: reading(18.5), emitterCount: 2, ...overrides });
}

test('deux convecteurs reçoivent chacun leur ordre, et ils diffèrent', () => {
  const { outputs } = stepVTherm(freshState(), twoHeads(), CFG_2, 0);

  near(outputs.onPercent, 0.3);
  assert.deepEqual(
    outputs.switchOn,
    [true, false],
    'un ordre unique les allumerait ensemble : deux fois la puissance appelée d\'un coup',
  );
  assert.equal(outputs.wakeUpAtMs, 90_000, 'la bascule la plus proche est celle de la n°1');
});

test('la pièce chauffe tant qu\'UN convecteur chauffe', () => {
  const first = stepVTherm(freshState(), twoHeads(), CFG_2, 0);
  assert.equal(first.outputs.demand.kind, 'active', 'la n°1 chauffe');

  // 90 s : la n°1 vient de couper, la n°2 n'a pas commencé. Personne ne chauffe.
  const creux = stepVTherm(first.nextState, twoHeads(), CFG_2, 90_000);
  assert.deepEqual(creux.outputs.switchOn, [false, null]);
  assert.equal(creux.outputs.demand.kind, 'inactive');

  // 150 s : la n°2 prend le relais. Lire la demande sur la seule n°1 éteindrait la chaudière
  // pendant que le second convecteur consomme.
  const relais = stepVTherm(creux.nextState, twoHeads(), CFG_2, 150_000);
  assert.deepEqual(relais.outputs.switchOn, [null, true]);
  assert.equal(relais.outputs.demand.kind, 'active');
});

test('la divergence se lit tête par tête, jamais sur l\'agrégat', () => {
  const first = stepVTherm(freshState(), twoHeads(), CFG_2, 0);

  // La n°1 est revenue à OFF toute seule — micro-coupure, `power_on_behavior`. La n°2 est éteinte
  // parce qu'on l'a voulu : les deux rapportent `false`, et une seule diverge.
  const world = twoHeads({
    emitterHeating: reading(false, 30_000),
    emitterHeatingHeads: [reading(false, 30_000), reading(false, 30_000)],
  });
  const { outputs } = stepVTherm(first.nextState, world, CFG_2, 30_000);

  assert.deepEqual(
    outputs.switchOn,
    [true, null],
    'la n°1 est réaffirmée, et elle seule : la n°2 fait exactement ce qu\'on lui a demandé',
  );
});

test('aucune réaffirmation quand chaque tête est d\'accord avec son propre ordre', () => {
  const first = stepVTherm(freshState(), twoHeads(), CFG_2, 0);

  const world = twoHeads({
    // L'agrégat vaut `true` — la n°1 chauffe. Le comparer à l'ordre donné à la n°2, qui est
    // éteinte à dessein, ferait voir une divergence à CHAQUE pas sur un groupe déphasé.
    emitterHeating: reading(true, 30_000),
    emitterHeatingHeads: [reading(true, 30_000), reading(false, 30_000)],
  });
  const { outputs } = stepVTherm(first.nextState, world, CFG_2, 30_000);

  assert.deepEqual(
    outputs.switchOn,
    [null, null],
    'un contacteur a une durée de vie qui se compte en commutations',
  );
});

test('sans état par tête, la divergence n\'est simplement pas détectée', () => {
  // Un groupe dont les têtes ne rapportent pas leur état : on écrit sur bascule réelle, comme
  // avant. C'est sûr, et c'est le comportement d'un émetteur muet.
  const first = stepVTherm(freshState(), twoHeads(), CFG_2, 0);
  const { outputs } = stepVTherm(
    first.nextState, twoHeads({ emitterHeating: reading(false, 30_000) }), CFG_2, 30_000,
  );

  assert.deepEqual(outputs.switchOn, [null, null]);
});

test('l\'état durable garde une entrée par tête', () => {
  const { nextState } = stepVTherm(freshState(), twoHeads(), CFG_2, 0);

  assert.deepEqual(nextState.persistent.dutyCycle.commanded, [true, false]);
});
