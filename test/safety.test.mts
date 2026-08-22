/**
 * Mode sécurité, isolé de tout le reste.
 *
 * Le scénario qui justifie ce module : une pile de capteur meurt une nuit de janvier. La
 * régulation refuse — à raison — de calculer sur une mesure figée, la demande de chaleur devient
 * inconnue, la chaudière s'éteint. La vanne garde son ouverture, mais sans eau chaude dedans elle
 * ne chauffe rien. La pièce refroidit jusqu'au matin, en silence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSafety, type SafetyInput, type SafetyParams } from '../lib/safety.mjs';
import { DEFAULT_SAFETY } from '../lib/constants.mjs';

const PARAMS: SafetyParams = { ...DEFAULT_SAFETY };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Le cas nominal : capteur muet, pièce qui chauffait franchement, pilotage par vanne. */
function input(overrides: Partial<SafetyInput> = {}): SafetyInput {
  return {
    sensorStale: true,
    sensorBound: true,
    emitterMode: 'valve',
    lastOnPercent: 0.74,
    onoff: true,
    // Le capteur s'est tu il y a une heure : bien en deçà de la borne de 24 h.
    lastGoodReadingAtMs: 0,
    nowMs: HOUR_MS,
    ...overrides,
  };
}

test('capteur muet et pièce qui chauffait : puissance de repli', () => {
  const result = evaluateSafety(input(), PARAMS);
  assert.equal(result.active, true);
  assert.equal(result.onPercent, 0.1, 'la puissance de repli, pas la dernière connue');
});

test('la pièce ne chauffait presque pas : on ne fait rien', () => {
  // Elle n'était pas en danger. Déclencher ferait tourner une chaudière longtemps, sans plus
  // rien pour dire d'arrêter — le capteur est justement celui qui est muet.
  assert.equal(evaluateSafety(input({ lastOnPercent: 0.49 }), PARAMS).active, false);
  assert.equal(evaluateSafety(input({ lastOnPercent: 0 }), PARAMS).active, false);
});

test('exactement au seuil : la sécurité s\'applique', () => {
  assert.equal(evaluateSafety(input({ lastOnPercent: 0.5 }), PARAMS).active, true);
});

test('capteur vivant : rien à secourir', () => {
  assert.equal(evaluateSafety(input({ sensorStale: false }), PARAMS).active, false);
});

test('aucun capteur désigné : ce n\'est pas une panne, c\'est une configuration incomplète', () => {
  // Chauffer une pièce dont on ignore tout serait pire que de ne rien faire, et l'avertissement
  // de l'appareil signale déjà le problème.
  assert.equal(evaluateSafety(input({ sensorBound: false }), PARAMS).active, false);
});

test('mode consigne : la sécurité s\'applique, avec une CONSIGNE de repli', () => {
  /*
   * Ce cas était exclu, au motif que l'émetteur « régule tout seul sur son propre thermomètre ».
   * C'est précisément le problème : le thermomètre d'une TRVZB est collé au radiateur, livrée à
   * elle-même elle lit chaud, ferme la vanne, et la pièce refroidit. Pire, le mode consigne est le
   * SEUL disponible sans dorsale MQTT — la sécurité ne s'armait donc jamais dans la configuration
   * standalone, c'est-à-dire dans la panne exacte qu'elle a été écrite pour couvrir.
   */
  const result = evaluateSafety(input({ emitterMode: 'setpoint' }), PARAMS);
  assert.equal(result.active, true);
  assert.equal(result.setpoint, DEFAULT_SAFETY.fallbackSetpoint, 'la consigne de repli, en degrés');
});

test('mode interrupteur : jamais de sécurité', () => {
  // Sur un relais, le repli sûr n'est pas de chauffer un peu, c'est de COUPER : il a sa propre
  // source d'énergie et rien ne l'arrêterait. C'est `lib/step.mts` qui s'en charge.
  assert.equal(evaluateSafety(input({ emitterMode: 'switch' }), PARAMS).active, false);
});

test('la consigne de repli est celle des réglages, pas une constante', () => {
  const params: SafetyParams = { ...PARAMS, fallbackSetpoint: 21 };
  assert.equal(evaluateSafety(input({ emitterMode: 'setpoint' }), params).setpoint, 21);
});

test('appareil éteint : rien', () => {
  assert.equal(evaluateSafety(input({ onoff: false }), PARAMS).active, false);
});

test('fonction désactivée : rien', () => {
  assert.equal(evaluateSafety(input(), { ...PARAMS, enabled: false }).active, false);
});

test('une puissance de repli aberrante est bornée, jamais propagée', () => {
  // Un réglage relu d'un `store` corrompu ne doit pas ouvrir une vanne à 400 %, ni y injecter
  // un NaN que Homey rejetterait en silence.
  assert.equal(evaluateSafety(input(), { ...PARAMS, defaultOnPercent: 4 }).onPercent, 1);
  assert.equal(evaluateSafety(input(), { ...PARAMS, defaultOnPercent: -1 }).onPercent, 0);
  assert.equal(evaluateSafety(input(), { ...PARAMS, defaultOnPercent: Number.NaN }).onPercent, 0);
});

test('la fonction est pure : deux appels identiques donnent le même résultat', () => {
  const a = evaluateSafety(input(), PARAMS);
  const b = evaluateSafety(input(), PARAMS);
  assert.deepEqual(a, b);
});

// --- Borne de durée ---------------------------------------------------------
//
// Le scénario que ferme cette borne : une pile morte en février. Sans elle, la sécurité force
// 10 % de chauffe indéfiniment — des semaines de chaudière sur une mesure morte, ce qui est un
// risque plus grand que le gel qu'on voulait éviter.

test('sous la borne de 24 h : la sécurité tient', () => {
  const result = evaluateSafety(input({ lastGoodReadingAtMs: 0, nowMs: DAY_MS - 1 }), PARAMS);
  assert.equal(result.active, true);
  assert.equal(result.expired, false);
});

test('exactement à la borne : la sécurité tient encore', () => {
  // Strictement au-delà, pas « à partir de » : une borne inclusive couperait une seconde trop tôt
  // et rendrait le réglage impossible à raisonner.
  assert.equal(evaluateSafety(input({ lastGoodReadingAtMs: 0, nowMs: DAY_MS }), PARAMS).active, true);
});

test('au-delà de la borne : la sécurité s\'efface et le dit', () => {
  const result = evaluateSafety(input({ lastGoodReadingAtMs: 0, nowMs: DAY_MS + 1 }), PARAMS);
  assert.equal(result.active, false, 'une chaudière ne tourne pas des semaines sur un capteur mort');
  assert.equal(result.onPercent, 0);
  assert.equal(result.expired, true, 'et ce n\'est pas la même chose que « jamais déclenchée »');
});

test('une semaine de silence : toujours effacée, jamais relancée', () => {
  const week = 7 * DAY_MS;
  assert.equal(evaluateSafety(input({ lastGoodReadingAtMs: 0, nowMs: week }), PARAMS).active, false);
});

test('horloge qui recule : la borne s\'applique quand même', () => {
  // Un `nowMs` antérieur à la dernière mesure (changement d'heure, resynchronisation NTP) ne doit
  // pas remettre le compteur à zéro et offrir un tour de plus à la sécurité.
  const result = evaluateSafety(input({ lastGoodReadingAtMs: 2 * DAY_MS, nowMs: 0 }), PARAMS);
  assert.equal(result.active, false);
  assert.equal(result.expired, true);
});

test('aucune mesure jamais vue : pas d\'origine, donc pas de borne', () => {
  // `lastGoodReadingAtMs` à `null` signifie que rien n'a encore été mesuré. Faire expirer sur une
  // origine inventée couperait la sécurité au premier pas suivant une mise à jour de l'app.
  const result = evaluateSafety(input({ lastGoodReadingAtMs: null, nowMs: 10 * DAY_MS }), PARAMS);
  assert.equal(result.active, true);
  assert.equal(result.expired, false);
});

test('borne à zéro : durée illimitée, comme avant', () => {
  const params: SafetyParams = { ...PARAMS, maxDurationMs: 0 };
  assert.equal(evaluateSafety(input({ lastGoodReadingAtMs: 0, nowMs: 30 * DAY_MS }), params).active, true);
});

test('borne non finie relue d\'un réglage corrompu : traitée comme illimitée, jamais comme zéro', () => {
  // Le repli dangereux serait l'inverse : une borne `NaN` comparée « supérieure à » rendrait
  // toujours faux et couperait la sécurité en permanence, sans que rien ne le dise.
  const params: SafetyParams = { ...PARAMS, maxDurationMs: Number.NaN };
  assert.equal(evaluateSafety(input({ lastGoodReadingAtMs: 0, nowMs: 30 * DAY_MS }), params).active, true);
});

test('la borne ne ressuscite rien : capteur vivant, elle ne change rien', () => {
  const result = evaluateSafety(
    input({ sensorStale: false, lastGoodReadingAtMs: 0, nowMs: 30 * DAY_MS }),
    PARAMS,
  );
  assert.equal(result.active, false);
  assert.equal(result.expired, false, 'expiré ne veut pas dire « aurait pu s\'appliquer »');
});
