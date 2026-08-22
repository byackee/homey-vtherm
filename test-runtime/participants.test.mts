/**
 * `runtime/participants.mts` — `VThermParticipant`, l'adhérence entre le noyau et l'appareil.
 *
 * PANNES EMPÊCHÉES :
 *  - un convecteur laissé ALLUMÉ sur une mesure morte, parce que le gel de sortie — bon repli pour
 *    une vanne passive — est un très mauvais repli pour un relais qui a sa propre énergie ;
 *  - un relais coupé par quelqu'un d'autre et jamais rallumé : à puissance saturée l'état commandé
 *    ne change jamais, donc plus aucune écriture ne partait et la pièce restait froide toute la
 *    journée pendant que l'app affichait « en chauffe » ;
 *  - une vanne figée sur son ouverture de nuit après une coupure de dorsale, sans que rien ne
 *    l'annonce à l'utilisateur ;
 *  - deux pas concurrents sur le même appareil, qui s'écrasent mutuellement l'état.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VThermParticipant, type VThermSourceBindings } from '../runtime/participants.mjs';
import { CONFIG, DEFAULTS } from './fixtures.mjs';
import { FakeBinding } from './fakes/binding.mjs';
import { FakeDeviceHost } from './fakes/deviceHost.mjs';
import { FakeEmitter } from './fakes/emitter.mjs';
import { FakeHomey } from './fakes/homey.mjs';

interface World {
  host: FakeDeviceHost;
  emitter: FakeEmitter;
  room: FakeBinding;
  participant: VThermParticipant;
}

function noSources(room: FakeBinding): VThermSourceBindings {
  return {
    room, outdoor: null, windowContact: null, motion: null, presence: null,
  };
}

function world(mode: 'valve' | 'setpoint' | 'switch'): World {
  const host = new FakeDeviceHost('salon');
  const emitter = new FakeEmitter('emetteur-salon');
  emitter.mode = mode;
  // Un capteur est bien DÉSIGNÉ : sans lecture, c'est un capteur muet, pas un thermostat sans
  // thermomètre — et les deux ne se corrigent pas de la même façon.
  const room = new FakeBinding();

  const participant = new VThermParticipant({
    host,
    emitter,
    sources: noSources(room),
    config: CONFIG,
    syncMode: 'off',
    controlsBoiler: true,
    centralMode: () => 'auto',
    requestTick: () => undefined,
    defaults: DEFAULTS,
    nowMs: 0,
  });

  return {
    host, emitter, room, participant,
  };
}

// --- Le convecteur : capteur muet ---------------------------------------------

test('capteur muet en mode interrupteur : le relais est COUPÉ, pas figé', async () => {
  const { host, emitter, participant } = world('switch');

  await participant.tick(0);

  assert.equal(emitter.lastSwitch, false, 'le convecteur est ÉTEINT');
  assert.equal(
    emitter.readHeating(0)?.value, false,
    'et il l\'est réellement : un relais laissé dans son état est un convecteur allumé pour toujours',
  );
  assert.equal(participant.demand.kind, 'inactive', 'la chaudière n\'est pas sollicitée pour lui');
  assert.equal(host.lastWarning, 'device.warning.sensor_stale', 'l\'utilisateur en est averti');
});

test('capteur muet en mode vanne : la sortie est GELÉE, on ne commande rien', async () => {
  const { emitter, participant } = world('valve');

  await participant.tick(0);

  assert.deepEqual(emitter.valves, [], 'aucune ouverture inventée sur une mesure morte');
  assert.equal(emitter.lastSwitch, undefined, 'et surtout aucun relais touché');
});

// --- Le convecteur : relais dévié par quelqu'un d'autre -----------------------

test('relais coupé par quelqu\'un d\'autre à puissance saturée : l\'app le RALLUME', async () => {
  const { emitter, room, participant } = world('switch');

  // Pièce à 10 °C pour une consigne de 19 : le TPI sature, l'état commandé ne changera plus.
  room.setReading(10, 0);
  await participant.tick(0);
  assert.equal(emitter.lastSwitch, true, 'le convecteur est ALLUMÉ');

  // Micro-coupure Zigbee : la prise revient sur son `power_on_behavior`, c'est-à-dire OFF.
  emitter.setRealHeating(false);

  room.setReading(10, 60_000);
  await participant.tick(60_000);

  assert.equal(emitter.lastSwitch, true);
  assert.equal(emitter.switches.length, 2, 'une seconde commande est bien partie');
  assert.equal(
    emitter.readHeating(60_000)?.value, true,
    'le convecteur chauffe de nouveau : sans réaffirmation sur divergence, il serait resté coupé',
  );
});

test('sans divergence, aucune commutation n\'est gaspillée', async () => {
  const { emitter, room, participant } = world('switch');

  room.setReading(10, 0);
  await participant.tick(0);
  room.setReading(10, 60_000);
  await participant.tick(60_000);

  assert.equal(emitter.switches.length, 1, 'un contacteur a une durée de vie en commutations');
});

// --- La vanne après une coupure de dorsale ------------------------------------

test('dorsale perdue : la vanne est rendue, et rien n\'est signalé si elle l\'a bien été', async () => {
  const { host, emitter, participant } = world('valve');

  await participant.onValveBackendAvailability(false, 60_000);

  assert.deepEqual(emitter.valveReleases, [60_000], 'la vanne a été reprise en main');
  assert.equal(emitter.lastValve, 100, 'elle est GRANDE OUVERTE : la pièce peut encore remonter');
  assert.deepEqual(host.warnings, [], 'rien à signaler : le repli a fonctionné');
});

test('vanne restée FIGÉE : un avertissement paraît, et il disparaît au retour de la dorsale', async () => {
  const { host, emitter, participant } = world('valve');

  // C'est justement la dorsale qui tombe : la publication ne part pas.
  emitter.releaseSucceeds = false;
  await participant.onValveBackendAvailability(false, 60_000);

  assert.equal(
    host.lastWarning, 'device.warning.valve_stuck',
    'une vanne à 12 % ne chauffe pas, quelle que soit la consigne écrite ensuite',
  );

  await participant.onValveBackendAvailability(true, 120_000);
  assert.equal(host.lastWarning, null, 'la vanne est reprise en main : plus rien à signaler');
});

test('capteur muet ET vanne figée : UN seul bandeau, et c\'est le capteur qui prime', async () => {
  const { host, emitter, participant } = world('valve');

  // Le capteur se tait : c'est le repli qui SUSPEND la régulation, il passe devant.
  await participant.tick(0);
  assert.equal(host.lastWarning, 'device.warning.sensor_stale');

  emitter.releaseSucceeds = false;
  await participant.onValveBackendAvailability(false, 60_000);

  assert.equal(host.warnings.length, 1, 'l\'appareil n\'a qu\'un bandeau : le second effacerait le premier');
  assert.equal(host.lastWarning, 'device.warning.sensor_stale');
});

test('le capteur revenu, la vanne figée prend la parole à son tour', async () => {
  const { host, emitter, room, participant } = world('valve');

  await participant.tick(0);
  emitter.releaseSucceeds = false;
  await participant.onValveBackendAvailability(false, 60_000);
  assert.equal(host.lastWarning, 'device.warning.sensor_stale');

  room.setReading(18, 120_000);
  await participant.tick(120_000);

  assert.equal(
    host.lastWarning, 'device.warning.valve_stuck',
    'le seul repli de l\'app qui échouait autrefois en silence',
  );
});

// --- Garde de réentrance -------------------------------------------------------

test('un pas en vol n\'en laisse pas démarrer un second sur le même appareil', async () => {
  const { host, emitter, room, participant } = world('switch');

  room.setReading(10, 0);
  const reprendre = emitter.pause();

  const premier = participant.tick(0);
  await FakeHomey.flush();
  assert.equal(emitter.switches.length, 0, 'le pas est bloqué dans son écriture');

  // Le délai de garde de l'app a expiré et l'ordonnanceur relance. La mesure a changé au point
  // que ce second pas commanderait l'inverse : les deux se marcheraient dessus.
  room.setReading(25, 10_000);
  await participant.tick(10_000);
  assert.ok(
    host.logs.some((line) => line.includes('abandonné')),
    'le second pas renonce plutôt que d\'écraser l\'état du premier',
  );

  reprendre();
  await premier;

  assert.equal(emitter.switches.length, 1, 'une seule commande est partie');
  assert.equal(emitter.lastSwitch, true, 'celle du pas qui avait commencé');
});

// --- Sortie propre ---------------------------------------------------------------

test('à l\'arrêt, la consigne rendue est celle que l\'utilisateur a choisie', async () => {
  const { emitter, room, participant } = world('setpoint');

  room.setReading(18, 0);
  await participant.tick(0);

  await participant.restoreSafeState();
  assert.deepEqual(emitter.safeStates, [19], 'la consigne CHOISIE, pas la consigne décalée');
});

test('`destroy()` relâche l\'émetteur et toutes les liaisons de sources', () => {
  const { emitter, room, participant } = world('setpoint');

  participant.destroy();

  assert.equal(emitter.destroyed, true);
  assert.equal(room.destroyed, true, 'sans quoi un capteur ré-appairé garderait un abonné fantôme');
});
