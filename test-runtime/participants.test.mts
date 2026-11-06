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

import { FRESHNESS, VThermParticipant, type VThermSourceBindings } from '../runtime/participants.mjs';
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

function world(
  mode: 'valve' | 'setpoint' | 'switch',
  extra: Partial<VThermSourceBindings> = {},
  requestTick: (reason: string) => void = () => undefined,
): World {
  const host = new FakeDeviceHost('salon');
  const emitter = new FakeEmitter('emetteur-salon');
  emitter.mode = mode;
  // Un capteur est bien DÉSIGNÉ : sans lecture, c'est un capteur muet, pas un thermostat sans
  // thermomètre — et les deux ne se corrigent pas de la même façon.
  const room = new FakeBinding();

  const participant = new VThermParticipant({
    host,
    emitter,
    sources: { ...noSources(room), ...extra },
    config: CONFIG,
    syncMode: 'off',
    controlsBoiler: true,
    centralMode: () => 'auto',
    requestTick,
    defaults: DEFAULTS,
    nowMs: 0,
  });

  return {
    host, emitter, room, participant,
  };
}

// --- Publication -------------------------------------------------------------

test('une capability ajoutée APRÈS un pas reçoit sa valeur au pas suivant, même inchangée', async () => {
  const { host, participant } = world('valve');
  host.missingCapabilities.add('vtherm_presence');

  await participant.tick(0);
  assert.equal(host.getCapabilityValue('vtherm_presence'), null, 'écriture ignorée faute de tuile');

  // La migration d'un thermostat existant : la tuile arrive, la présence, elle, n'a pas bougé.
  host.missingCapabilities.delete('vtherm_presence');
  await participant.tick(60_000);
  assert.equal(
    host.getCapabilityValue('vtherm_presence'), true,
    'mémoriser l\'écriture ignorée laissait la tuile vide jusqu\'au prochain changement',
  );
});

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

// --- Mode interrupteur : la commande n'est pas partie ---------------------------

test('bascule perdue : la demande devient INCONNUE, la chaudière n\'est pas sollicitée', async () => {
  const { emitter, room, participant } = world('switch');

  // Pièce chaude : le relais reste éteint, la chaudière n'est pas sollicitée pour cette pièce.
  room.setReading(30, 0);
  await participant.tick(0);
  assert.equal(emitter.lastSwitch, false, 'relais éteint');
  assert.equal(participant.demand.kind, 'inactive');

  // La prise est ré-appairée : nouvel identifiant Homey, la liaison ne résout plus rien. La pièce
  // refroidit, le noyau veut donc VRAIMENT commuter — et la commande ne part pas.
  emitter.switchWriteFails = true;
  const later = 30 * 60_000;
  room.setReading(12, later);
  await participant.tick(later);

  assert.equal(
    participant.demand.kind, 'unknown',
    'en mode interrupteur la demande vient de NOTRE découpage temporel, pas d\'une lecture de '
    + 'l\'émetteur : sans ce doute elle restait `active`, la pièce ne chauffait pas, et la '
    + 'chaudière tournait sur un circuit qui ne consomme rien',
  );
});

// --- La fenêtre détectée sans capteur ------------------------------------------

test('vanne qui ne sait pas dire si elle chauffe : la puissance calculée sollicite la chaudière', async () => {
  // Le cas réel : une TRVZB appairée sur le Zigbee de Homey, sans aucune capability d'état de
  // chauffe. Avant, sa demande restait `unknown` pour toujours et la chaudière ne démarrait jamais.
  const { emitter, room, participant } = world('setpoint');
  room.setReading(12, 0);

  await participant.tick(0);

  assert.equal(emitter.caps.heatingState, false);
  assert.equal(participant.demand.kind, 'active');
});

test('la puissance ne remplace PAS un état de chauffe qui existe mais s\'est tu', async () => {
  const { emitter, room, participant } = world('setpoint');
  emitter.caps.heatingState = true;
  room.setReading(12, 0);

  await participant.tick(0);

  assert.equal(participant.demand.kind, 'unknown', 'une lecture muette reste de l\'ignorance');
});

test('un émetteur injoignable ne voit pas sa demande déduite de la puissance', async () => {
  const { emitter, room, participant } = world('setpoint');
  emitter.available = false;
  room.setReading(12, 0);

  await participant.tick(0);

  assert.equal(participant.demand.kind, 'unknown', 'la consigne n\'arrive nulle part : rien ne chauffe');
});

test('mode « chute de température » : la condition Flow suit la détection RÉELLE, pas la capability', async () => {
  const host = new FakeDeviceHost('salon');
  const emitter = new FakeEmitter('emetteur-salon');
  emitter.mode = 'setpoint';
  const room = new FakeBinding();

  // Aucun contact fenêtre n'est désigné : en mode `auto`, la détection vient de la pente seule.
  // C'est le cas que le réglage annonce — « Temperature-drop detection needs no sensor at all ».
  const participant = new VThermParticipant({
    host,
    emitter,
    sources: noSources(room),
    config: { ...CONFIG, window: { ...CONFIG.window, mode: 'auto' } },
    syncMode: 'off',
    controlsBoiler: true,
    centralMode: () => 'auto',
    requestTick: () => undefined,
    defaults: DEFAULTS,
    nowMs: 0,
  });

  // Chute de 0,6 °C par 10 min, soit −3,6 °C/h : au-delà du seuil de 3 °C/h, mais il faut
  // quatre points avant que la pente soit publiée et puisse déclencher quoi que ce soit.
  for (const [index, temp] of [20, 19.4, 18.8, 18.2].entries()) {
    const at = index * 600_000;
    room.setReading(temp, at);
    await participant.tick(at);
  }
  // Confirmation après le délai, sur la même mesure.
  room.setReading(18.2, 1_800_000);
  await participant.tick(1_830_000);

  assert.equal(
    participant.windowOpen, true,
    'l\'ouverture est détectée, et c\'est elle qui a fait partir le déclencheur `window_opened`',
  );
  assert.equal(
    host.getCapabilityValue('alarm_contact'), null,
    'et `alarm_contact` n\'existe même pas : une condition qui la lirait répondrait « fermée » '
    + 'juste derrière le déclencheur qui vient de partir',
  );
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
  assert.equal(host.lastWarning, null, 'rien à signaler : le repli a fonctionné');
});

test('un avertissement laissé par le démarrage précédent est effacé au premier pas', async () => {
  // Homey garde le bandeau d'un démarrage à l'autre : le premier pas ne doit pas le croire vide.
  const { host, room, participant } = world('valve');
  room.setReading(18, 0);

  await participant.tick(0);

  assert.deepEqual(host.warnings, [null], 'le « mesure périmée » d\'avant le redémarrage disparaît');
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

test('émetteur joignable mais muet depuis des semaines : un bandeau le dit', async () => {
  // La TRVZB du salon sous le pilote Sonoff officiel : vue sur le Zigbee à la minute, température
  // figée depuis six semaines, consignes perdues. La tuile affichait une régulation normale.
  const { host, emitter, room, participant } = world('setpoint');
  const nowMs = 43 * DAY_MS;
  emitter.reportedAtMs = 0;
  room.setReading(18, nowMs);

  await participant.tick(nowMs);

  assert.equal(host.lastWarning, 'device.warning.emitter_silent');
});

test('émetteur silencieux depuis quelques heures seulement : rien à signaler', async () => {
  // Homey ne date une mesure qu'à son changement : huit heures de silence dans une pièce stable,
  // c'est une vanne en parfaite santé.
  const { host, emitter, room, participant } = world('setpoint');
  const nowMs = 3 * DAY_MS;
  emitter.reportedAtMs = nowMs - 8 * 60 * 60_000;
  room.setReading(18, nowMs);

  await participant.tick(nowMs);

  assert.equal(host.lastWarning, null);
});

test('émetteur sans aucune mesure datée : pas de verdict, pas de bandeau', async () => {
  // Un relais n'a rien à remonter : son silence n'est pas une panne.
  const { host, emitter, room, participant } = world('switch');
  const nowMs = 43 * DAY_MS;
  emitter.reportedAtMs = null;
  room.setReading(18, nowMs);

  await participant.tick(nowMs);

  assert.equal(host.lastWarning, null);
});

test('le bandeau de l\'émetteur muet disparaît dès qu\'il remonte une mesure', async () => {
  const { host, emitter, room, participant } = world('setpoint');
  emitter.reportedAtMs = 0;
  room.setReading(18, 3 * DAY_MS);
  await participant.tick(3 * DAY_MS);
  assert.equal(host.lastWarning, 'device.warning.emitter_silent');

  emitter.reportedAtMs = 3 * DAY_MS + 60_000;
  room.setReading(18, 3 * DAY_MS + 120_000);
  await participant.tick(3 * DAY_MS + 120_000);

  assert.equal(host.lastWarning, null, 'la tête réappairée répond : plus rien à signaler');
});

test('émetteur muet : la chaudière n\'est plus sollicitée pour un radiateur qui ne reçoit rien', async () => {
  // Pièce à 12 °C, puissance saturée : sans la garde, la demande serait `active`.
  const { emitter, room, participant } = world('setpoint');
  const nowMs = 43 * DAY_MS;
  emitter.reportedAtMs = 0;
  emitter.newestReportedAtMs = 0;
  room.setReading(12, nowMs);

  await participant.tick(nowMs);

  assert.equal(participant.demand.kind, 'unknown');
});

test('une tête muette dans un groupe qui répond : la pièce garde sa demande, le bandeau prévient', async () => {
  const { host, emitter, room, participant } = world('setpoint');
  const nowMs = 43 * DAY_MS;
  emitter.reportedAtMs = 0;
  emitter.newestReportedAtMs = nowMs - 60_000;
  room.setReading(12, nowMs);

  await participant.tick(nowMs);

  assert.equal(participant.demand.kind, 'active', 'les autres radiateurs ont besoin de la chaudière');
  assert.equal(host.lastWarning, 'device.warning.emitter_silent');
});

test('capteur de pièce muet ET émetteur muet : le capteur prime', async () => {
  const { host, emitter, participant } = world('setpoint');
  emitter.reportedAtMs = 0;

  await participant.tick(3 * DAY_MS);

  assert.equal(host.lastWarning, 'device.warning.sensor_stale');
});

test('mode consigne : sans nouvelle consigne, la tête est contrôlée à chaque pas', async () => {
  const { emitter, room, participant } = world('setpoint');
  room.setReading(19, 0);
  await participant.tick(0);
  const writes = emitter.setpoints.length;

  room.setReading(19, 60_000);
  await participant.tick(60_000);

  assert.equal(emitter.setpoints.length, writes, 'consigne inchangée : le noyau n\'écrit rien');
  assert.deepEqual(emitter.reasserts.slice(-1), [60_000], 'mais la tête est vérifiée');
});

test('mode vanne : la consigne n\'est qu\'un affichage, rien à réaffirmer', async () => {
  const { emitter, room, participant } = world('valve');
  room.setReading(19, 0);
  await participant.tick(0);
  room.setReading(19, 60_000);
  await participant.tick(60_000);

  assert.deepEqual(emitter.reasserts, []);
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

test('un pas abandonné pendant une écriture lente est relancé, la fenêtre n\'attend pas le cycle', async () => {
  const contact = new FakeBinding();
  const ticks: string[] = [];
  const { host, emitter, room, participant } = world('switch', { windowContact: contact }, (reason) => ticks.push(reason));
  participant.updateConfig({ ...CONFIG, window: { ...CONFIG.window, mode: 'sensor', delaySec: 0 } });
  ticks.length = 0;
  contact.setReading(false, 0);
  room.setReading(10, 0);

  const reprendre = emitter.pause();
  const premier = participant.tick(0);
  await FakeHomey.flush();

  // La fenêtre s'ouvre pendant que le relais met du temps à répondre : son pas est abandonné.
  contact.setReading(true, 10_000);
  await participant.tick(10_000);
  assert.ok(host.logs.some((line) => line.includes('abandonné')));
  assert.deepEqual(ticks, [], 'rien à relancer tant que l\'écriture n\'a pas rendu la main');

  reprendre();
  await premier;
  assert.deepEqual(ticks, ['window-after-abandoned-tick'], 'la fenêtre est revue tout de suite');

  // Les pas qui suivent voient la fenêtre, et n'en réclament pas d'autre : pas de boucle.
  await participant.tick(11_000);
  await participant.tick(12_000);
  assert.equal(participant.windowOpen, true);
  assert.deepEqual(ticks, ['window-after-abandoned-tick']);
});

test('un pas abandonné sans fenêtre qui bouge ne relance rien : une vanne morte n\'est pas réécrite', async () => {
  const contact = new FakeBinding();
  const ticks: string[] = [];
  const { emitter, room, participant } = world('switch', { windowContact: contact }, (reason) => ticks.push(reason));
  contact.setReading(false, 0);
  room.setReading(10, 0);

  const reprendre = emitter.pause();
  const premier = participant.tick(0);
  await FakeHomey.flush();

  room.setReading(11, 10_000);
  await participant.tick(10_000);

  reprendre();
  await premier;
  assert.deepEqual(ticks, []);
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

// --- L'ouverture qui n'est jamais rejouée -------------------------------------
//
// PANNE EMPÊCHÉE : pièce froide, chaudière éteinte, sans sortie. Il y a DEUX mémoires d'écriture.
// Celle de l'émetteur n'enregistre que ce qui est réellement parti, pour qu'une même valeur puisse
// être retentée. Celle du noyau enregistre ce qu'il a DÉCIDÉ, et c'est elle qui garde la porte —
// sans `maxIntervalMs`, une valeur inchangée n'y repasse jamais. L'émetteur n'avait donc plus
// jamais l'occasion de réessayer, et `lastWrite` étant volatile, seul un redémarrage y mettait fin.

test('une ouverture non envoyée est REJOUÉE au pas suivant', async () => {
  const { emitter, room, participant } = world('valve');
  room.setReading(14, 0); // pièce franchement froide : la puissance sature

  emitter.valveUnconfirmed = true;   // la dorsale a hoqueté : l'ouverture n'est pas partie
  await participant.tick(0);
  const afterFirst = emitter.valves.length;
  assert.ok(afterFirst > 0, 'une ouverture a bien été tentée');
  assert.equal(participant.demand.kind, 'unknown', 'la chaudière n\'est pas sollicitée sur du doute');

  // La dorsale revient. La cible n'a pas bougé d'un pouce — puissance saturée — donc c'est
  // exactement le cas que la déduplication du noyau bloquait.
  emitter.valveUnconfirmed = false;
  await participant.tick(300_000);

  assert.ok(emitter.valves.length > afterFirst, 'l\'ouverture est repartie');
  assert.equal(participant.demand.kind, 'active', 'et la chaudière est de nouveau sollicitée');
});

test('une ouverture bien envoyée n\'est PAS rejouée : la déduplication reste entière', async () => {
  // La contrepartie. Rejouer une écriture qui a réussi userait le quota d'API pour rien.
  const { emitter, room, participant } = world('valve');
  room.setReading(14, 0);

  await participant.tick(0);
  const afterFirst = emitter.valves.length;

  await participant.tick(300_000);
  assert.equal(emitter.valves.length, afterFirst, 'aucune réécriture d\'une valeur déjà en place');
});

// --- Seuils de fraîcheur : ce que chacun protège --------------------------------

/**
 * PANNE EMPÊCHÉE : une tuile de pile perpétuellement vide sur du matériel qui va bien.
 *
 * Le seuil de la pile était calqué sur celui des autres sources — 24 h — alors que le raisonnement
 * est inverse. Réguler sur une température figée est dangereux ; une charge de pile de deux
 * semaines, elle, reste une information juste. Or une TRVZB ne rapporte la sienne que tous les
 * plusieurs jours : sur l'installation de référence, deux vannes sur trois avaient une lecture
 * vieille de sept jours, donc jamais publiée. Une tuile qui ne s'affiche jamais ne prévient de
 * rien — c'est pourtant sa seule raison d'être.
 */

const DAY_MS = 24 * 60 * 60_000;

test('la pile d\'une vanne silencieuse depuis une semaine reste affichable', () => {
  assert.ok(
    FRESHNESS.emitterBatteryMs > 7 * DAY_MS,
    'sept jours est la cadence RÉELLE de rapport des vannes de référence, pas une marge de confort',
  );
});

test('logement vide depuis une nuit : la présence virtuelle muette reste « absent »', async () => {
  const presence = new FakeBinding(false, 0);
  const { host, room, participant } = world('valve', { presence });

  // Une présence pilotée par Flow ne publie rien entre le départ et le retour.
  const nextMorningMs = 12 * 60 * 60_000;
  room.setReading(19, nextMorningMs);
  await participant.tick(nextMorningMs);

  assert.equal(
    host.getCapabilityValue('vtherm_presence'), false,
    'à 2 h de fraîcheur, l\'« absent » devenait périmé, donc « présent » : tous les thermostats '
    + 'remettaient la consigne de présence dans un logement vide',
  );
});

// --- Délai avant absence ------------------------------------------------------

test('un radar immobile depuis dix minutes ne vide pas le logement, et le réveil tombe à l\'échéance', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  // Le radar sert de présence : il retombe à faux dès que personne ne bouge.
  const presence = new FakeBinding(false, nowMs - 10 * MIN);
  presence.capabilityId = 'alarm_motion';
  const { host, room, participant } = world('valve', { presence });

  room.setReading(19, nowMs);
  await participant.tick(nowMs);

  assert.equal(host.getCapabilityValue('vtherm_presence'), true, 'un salon calme n\'est pas un logement vide');
  assert.equal(participant.isSomeoneHome(nowMs), true, 'la condition Flow dit la même chose que la régulation');
  assert.ok(
    participant.dueAtMs() <= nowMs + 50 * MIN,
    'sans réveil, l\'absence n\'arriverait qu\'au cycle suivant, après l\'échéance',
  );

  await participant.tick(nowMs + 50 * MIN);
  assert.equal(host.getCapabilityValue('vtherm_presence'), false, 'au bout d\'une heure sans détection, l\'absence s\'applique');
  assert.equal(participant.isSomeoneHome(nowMs + 50 * MIN), false);
});

test('un vrai capteur de présence (géofence virtuelle, mmWave) déclare l\'absence sans délai', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const presence = new FakeBinding(false, nowMs - MIN);
  presence.capabilityId = 'alarm_presence';
  const { host, room, participant } = world('valve', { presence });

  room.setReading(19, nowMs);
  await participant.tick(nowMs);

  assert.equal(
    host.getCapabilityValue('vtherm_presence'), false,
    'seul un détecteur de MOUVEMENT retombe dès que personne ne bouge ; une présence fiable ne doit pas attendre une heure',
  );
});

test('la présence de Homey déclare l\'absence sans délai', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const presence = new FakeBinding(false, nowMs - MIN);
  presence.confirmedAbsence = true;
  const { host, room, participant } = world('valve', { presence });

  room.setReading(19, nowMs);
  await participant.tick(nowMs);

  assert.equal(host.getCapabilityValue('vtherm_presence'), false, 'la géolocalisation est déjà une absence confirmée');
});

test('personne de géolocalisé mais la nounou bouge dans la chambre : pas d\'absence', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const presence = new FakeBinding(false, nowMs);
  presence.confirmedAbsence = true;
  const host = new FakeDeviceHost('salon');
  const room = new FakeBinding(19, nowMs);
  let activityAtMs: number | null = nowMs - 20 * MIN;
  const participant = new VThermParticipant({
    host,
    emitter: new FakeEmitter('emetteur-salon'),
    sources: { ...noSources(room), presence },
    config: CONFIG,
    syncMode: 'off',
    controlsBoiler: true,
    centralMode: () => 'auto',
    requestTick: () => undefined,
    defaults: DEFAULTS,
    nowMs: 0,
    houseActivityAtMs: () => activityAtMs,
  });

  await participant.tick(nowMs);
  assert.equal(host.getCapabilityValue('vtherm_presence'), true, 'les parents partis, la maison n\'est pas vide');
  assert.equal(participant.followsHouseActivity, true);
  assert.ok(participant.dueAtMs() <= nowMs + 40 * MIN, 'réveil quand la maison sera calme depuis le délai');

  await participant.tick(nowMs + 40 * MIN);
  assert.equal(host.getCapabilityValue('vtherm_presence'), false, 'une heure de calme : l\'absence s\'applique');

  // La nounou revient dans le salon : la présence revient sans attendre les parents.
  activityAtMs = nowMs + 41 * MIN;
  await participant.tick(nowMs + 41 * MIN);
  assert.equal(host.getCapabilityValue('vtherm_presence'), true);

  // Sans aucun détecteur dans la maison, la géolocalisation décide seule.
  activityAtMs = null;
  await participant.tick(nowMs + 42 * MIN);
  assert.equal(host.getCapabilityValue('vtherm_presence'), false);
});

test('un détecteur illisible garde sa dernière activité, et un détecteur jamais lu compte à la création', () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const motion = new FakeBinding(false, nowMs - 5 * MIN);
  const { participant } = world('valve', { motion });
  assert.equal(participant.lastActivityAtMs(nowMs), nowMs - 5 * MIN);

  // Coupure Zigbee : plus aucune lecture. La nounou n'est pas partie pour autant.
  motion.silence();
  assert.equal(participant.lastActivityAtMs(nowMs + MIN), nowMs - 5 * MIN);

  // Démarrage : la liaison n'est pas encore rattachée, aucune lecture n'a jamais eu lieu.
  const fresh = new FakeBinding();
  const { participant: booting } = world('valve', { motion: fresh });
  assert.equal(booting.lastActivityAtMs(nowMs), 0, 'compte comme actif à la création (nowMs: 0 dans `world`)');
});

test('un détecteur bloqué sur « quelqu\'un » ne retient la maison que douze heures', () => {
  const HOUR = 60 * 60_000;
  const nowMs = 100 * HOUR;
  const motion = new FakeBinding(true, nowMs - 2 * HOUR);
  motion.capabilityId = 'alarm_motion';
  const { participant } = world('valve', { motion });
  assert.equal(participant.lastActivityAtMs(nowMs), nowMs, 'deux heures de présence : actif maintenant');

  const stuck = new FakeBinding(true, nowMs - 3 * 24 * HOUR);
  stuck.capabilityId = 'alarm_motion';
  const { participant: other } = world('valve', { motion: stuck });
  assert.equal(
    other.lastActivityAtMs(nowMs), nowMs - 3 * 24 * HOUR + 12 * HOUR,
    'pile morte ou chat : sans borne, la famille partie en congé chaufferait au Confort une semaine',
  );
});

test('un détecteur figé qui RE-RAPPORTE la même valeur est quand même vu figé', () => {
  const HOUR = 60 * 60_000;
  const t0 = 100 * HOUR;
  const motion = new FakeBinding(true, t0);
  motion.capabilityId = 'alarm_motion';
  const { participant } = world('valve', { motion });

  // `lastUpdated` avance à chaque rapport, la valeur ne change jamais ; on regarde à chaque pas.
  for (let atMs = t0; atMs < t0 + 13 * HOUR; atMs += 20 * 60_000) {
    motion.setReading(true, atMs);
    participant.lastActivityAtMs(atMs);
  }
  motion.setReading(true, t0 + 13 * HOUR - 60_000);
  assert.equal(
    participant.lastActivityAtMs(t0 + 13 * HOUR), t0 + 12 * HOUR,
    'compté depuis le premier « vrai » vu, pas depuis le dernier rapport',
  );
});

test('un vrai capteur de présence à vrai toute la nuit reste de l\'activité', () => {
  const HOUR = 60 * 60_000;
  const nowMs = 100 * HOUR;
  const radar = new FakeBinding(true, nowMs - 20 * HOUR);
  radar.capabilityId = 'alarm_presence';
  const { participant } = world('valve', { presence: radar });
  assert.equal(participant.lastActivityAtMs(nowMs), nowMs, 'la nounou endormie devant le mmWave');
});

test('un détecteur qu\'on n\'a pas regardé ne paraît pas figé, et la mémoire ne recule pas', () => {
  const HOUR = 60 * 60_000;
  const t0 = 100 * HOUR;
  const motion = new FakeBinding(true, t0);
  motion.capabilityId = 'alarm_motion';
  const { participant } = world('valve', { motion });
  participant.lastActivityAtMs(t0);

  // Une semaine sans le regarder, puis quelqu'un passe : il vient de rapporter, il n'est pas figé.
  const later = t0 + 7 * 24 * HOUR;
  motion.setReading(true, later - 60_000);
  assert.equal(participant.lastActivityAtMs(later), later);

  // Une lecture datée d'avant ne réécrit pas la mémoire.
  motion.setReading(false, later - 2 * HOUR);
  participant.lastActivityAtMs(later - HOUR);
  motion.setReading(true, later + 60_000);
  assert.equal(participant.lastActivityAtMs(later + 2 * 60_000), later + 2 * 60_000);
});

test('un détecteur re-désigné repart de zéro', () => {
  const MIN = 60_000;
  const nowMs = 300 * MIN;
  const old = new FakeBinding(false, nowMs - 5 * MIN);
  const { participant } = world('valve', { motion: old });
  assert.equal(participant.lastActivityAtMs(nowMs), nowMs - 5 * MIN);

  // Réparer remplace la liaison ; la nouvelle n'a encore rien lu.
  (participant as unknown as { sources: { motion: FakeBinding } }).sources.motion = new FakeBinding();
  assert.equal(participant.lastActivityAtMs(nowMs + MIN), 0, 'pas l\'historique de l\'appareil retiré');
});

test('présence par détecteur de mouvement figé : l\'absence vient douze heures plus le délai après', async () => {
  const HOUR = 60 * 60_000;
  const t0 = 100 * HOUR;
  const presence = new FakeBinding(true, t0);
  presence.capabilityId = 'alarm_motion';
  const { host, room, participant } = world('valve', { presence });

  room.setReading(19, t0);
  await participant.tick(t0);
  assert.equal(host.getCapabilityValue('vtherm_presence'), true);
  assert.ok(participant.dueAtMs() <= t0 + 12 * HOUR, 'réveil à la borne du figé');

  room.setReading(19, t0 + 12 * HOUR + 45 * 60_000);
  await participant.tick(t0 + 12 * HOUR + 45 * 60_000);

  room.setReading(19, t0 + 13 * HOUR + 60_000);
  presence.setReading(true, t0 + 13 * HOUR);
  await participant.tick(t0 + 13 * HOUR + 60_000);
  assert.equal(
    host.getCapabilityValue('vtherm_presence'), false,
    'figé depuis 13 h : retombé à 12 h, puis une heure de délai — une semaine de chauffe sinon',
  );
});

test('une caméra en `alarm_motion.person` a aussi droit au délai', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const presence = new FakeBinding(false, nowMs - 10 * MIN);
  presence.capabilityId = 'alarm_motion.person';
  const { host, room, participant } = world('valve', { presence });

  room.setReading(19, nowMs);
  await participant.tick(nowMs);
  assert.equal(host.getCapabilityValue('vtherm_presence'), true);
});

test('l\'activité d\'un thermostat : maintenant si son détecteur voit, sinon l\'instant où il est retombé', () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const motion = new FakeBinding(false, nowMs - 5 * MIN);
  const { participant } = world('valve', { motion });
  assert.equal(participant.lastActivityAtMs(nowMs), nowMs - 5 * MIN);
  motion.setReading(true, nowMs - MIN);
  assert.equal(participant.lastActivityAtMs(nowMs), nowMs);

  const homey = new FakeBinding(true, nowMs);
  homey.confirmedAbsence = true;
  const { participant: other } = world('valve', { presence: homey });
  assert.equal(other.lastActivityAtMs(nowMs), null, 'la géolocalisation n\'est pas une activité dans la maison');
});

test('un délai de zéro rend le comportement d\'avant', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const presence = new FakeBinding(false, nowMs - MIN);
  presence.capabilityId = 'alarm_motion';
  const { host, room, participant } = world('valve', { presence });
  participant.updateConfig({ ...CONFIG, presenceOffDelayMin: 0 });

  room.setReading(19, nowMs);
  await participant.tick(nowMs);

  assert.equal(host.getCapabilityValue('vtherm_presence'), false);
});

test('le forçage par Flow ne subit pas le délai', async () => {
  const MIN = 60_000;
  const nowMs = 3 * 60 * MIN;
  const presence = new FakeBinding(true, nowMs - MIN);
  const { host, room, participant } = world('valve', { presence });
  participant.forcePresence('away');

  room.setReading(19, nowMs);
  await participant.tick(nowMs);

  assert.equal(host.getCapabilityValue('vtherm_presence'), false);
  assert.equal(participant.isSomeoneHome(nowMs), false);
});

test('le seuil de la pile est le plus large de la table, celui de la pièce le plus strict', () => {
  const regulation = [
    FRESHNESS.roomTempMs, FRESHNESS.outdoorTempMs, FRESHNESS.emitterHeatingMs,
    FRESHNESS.motionMs, FRESHNESS.presenceMs,
  ];

  for (const seuil of regulation) {
    assert.ok(
      FRESHNESS.emitterBatteryMs > seuil,
      'une pile n\'entre dans aucune décision de chauffe : rien ne justifie de la juger aussi vite '
      + 'qu\'une mesure dont dépend la régulation',
    );
    assert.ok(
      FRESHNESS.roomTempMs <= seuil,
      'la mesure de pièce commande tout : elle doit être la première déclarée périmée',
    );
  }
});

// --- Préchauffe (SPEC §14) ---------------------------------------------------

test('préchauffe, critère 15 : une cible posée est écrite dans le store au pas qui suit, sans attendre', async () => {
  const { host, room, participant } = world('valve');
  room.setReading(18, 0);
  await participant.tick(0);

  participant.addPreheatTarget('comfort', 10 * 3_600_000);
  await participant.tick(60_000);

  const stored = host.getStoreValue('vtherm.state') as { preheatTargets?: unknown } | undefined;
  assert.deepEqual(stored?.preheatTargets, [{ preset: 'comfort', atMs: 10 * 3_600_000 }],
    'l\'intervalle de 5 min aurait laissé un redémarrage perdre la cible');
});

test('préchauffe, critère 7 : la cinquième cible lève, et la liste reste à quatre', () => {
  const { participant } = world('valve');
  for (const hour of [1, 2, 3, 4]) participant.addPreheatTarget('comfort', hour * 3_600_000);
  assert.throws(() => participant.addPreheatTarget('boost', 5 * 3_600_000), /device\.preheat\.full/);
  assert.equal(participant.preheatTargets.length, 4);
});

test('préchauffe, critère 8 : un preset manuel à 05:30 annule la cible de 07:00, pas celui de 22:00 la veille', () => {
  const at7h = 31 * 3_600_000;
  const evening = world('valve').participant;
  evening.addPreheatTarget('comfort', at7h);
  evening.setPreset('eco', at7h - 9 * 3_600_000);
  assert.equal(evening.preheatTargets.length, 1);

  const early = world('valve').participant;
  early.addPreheatTarget('comfort', at7h);
  early.setManualSetpoint(18, at7h - 90 * 60_000);
  assert.equal(early.preheatTargets.length, 0);
});

test('préchauffe : le pas qui bascule déclenche la carte, et l\'apprentissage s\'affiche', async () => {
  const shown: number[] = [];
  const { host, room, participant } = world('valve');
  host.showPreheatStatus = async (learning) => { shown.push(learning.accepted); };
  // Confort à 19 °C, pièce à 17 : 15 + 2 × 60 = 135 min, plafonnés à 90 — la cible de +30 min est due.
  room.setReading(17, 0);
  // Le thermostat de test démarre en Confort : sans passage en Éco, la bascule ne changerait rien
  // et n'annoncerait donc rien.
  participant.setPreset('eco', 0);

  participant.addPreheatTarget('comfort', 30 * 60_000);
  await participant.tick(0);

  assert.ok(host.flows.some((event) => event.kind === 'preheat_started'));
  assert.deepEqual(shown, [0], 'affiché une fois, au premier pas, puis seulement s\'il change');
  await participant.tick(60_000);
  assert.deepEqual(shown, [0]);
});
