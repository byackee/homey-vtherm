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

/** Le cas nominal : capteur muet, pièce qui chauffait franchement, pilotage par vanne. */
function input(overrides: Partial<SafetyInput> = {}): SafetyInput {
  return {
    sensorStale: true,
    sensorBound: true,
    emitterMode: 'valve',
    lastOnPercent: 0.74,
    onoff: true,
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

test('mode consigne : jamais de sécurité', () => {
  // Privé de nos écritures, un émetteur en mode consigne tient sa dernière consigne sur son
  // propre thermomètre : il continue de réguler tout seul. Forcer une puissance reviendrait à se
  // substituer à un régulateur qui fonctionne. C'est le choix de VT, pour la même raison.
  assert.equal(evaluateSafety(input({ emitterMode: 'setpoint' }), PARAMS).active, false);
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
