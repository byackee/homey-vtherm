/**
 * `runtime/scheduler.mts` — l'unique timer de l'app.
 *
 * PANNES EMPÊCHÉES :
 *  - une rafale d'événements qui produirait un tick chacun, donc une chaudière qui pulse et des
 *    piles de vannes usées pour rien ;
 *  - un participant dont l'échéance est illisible et qui emporterait l'ordonnanceur de tout le
 *    logement, laissant la régulation périodique s'arrêter en silence ;
 *  - un `stop()` qui rendrait la main avant la fin du pas en vol : les écritures restantes
 *    atterrissent alors APRÈS la remise en état sûr, et le convecteur qu'on vient d'éteindre est
 *    rallumé par un pas déjà lancé ;
 *  - une minuterie laissée armée après l'arrêt, qui survit au rechargement de l'app.
 *
 * Le temps est manuel : rien ici n'attend réellement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type Homey from 'homey';
import { Scheduler, type Tickable } from '../runtime/scheduler.mjs';
import { FakeEmitter } from './fakes/emitter.mjs';
import { FakeHomey } from './fakes/homey.mjs';

type HomeyInstance = Homey.App['homey'];

const BASE_MS = 10_000;
const COALESCE_MS = 5_000;

/** Un participant qui note l'instant de chacun de ses pas et rien d'autre. */
class Recorder implements Tickable {
  readonly ticks: number[] = [];
  /** Échéance annoncée. `-Infinity` = toujours dû, `+Infinity` = rien en attente. */
  due: number = Number.NEGATIVE_INFINITY;

  constructor(readonly tickId: string) {}

  dueAtMs(): number {
    return this.due;
  }

  async tick(nowMs: number): Promise<void> {
    this.ticks.push(nowMs);
  }
}

function newScheduler(homey: FakeHomey): Scheduler {
  return new Scheduler(homey as unknown as HomeyInstance, {
    baseMs: BASE_MS,
    coalesceMs: COALESCE_MS,
    now: () => homey.now(),
  });
}

// --- Battement de base et échéances -----------------------------------------

test('le battement de base réveille les participants dus, et eux seuls', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);

  const salon = new Recorder('salon');
  const chambre = new Recorder('chambre');
  chambre.due = Number.POSITIVE_INFINITY; // rien en attente : il ne doit pas être réveillé.

  scheduler.register(salon);
  scheduler.register(chambre);

  scheduler.start();
  await FakeHomey.flush();
  assert.deepEqual(salon.ticks, [0], 'un pas immédiat au démarrage');
  assert.deepEqual(chambre.ticks, [], 'la chambre n\'attend rien');

  homey.advance(BASE_MS);
  await FakeHomey.flush();
  assert.deepEqual(salon.ticks, [0, BASE_MS]);
  assert.deepEqual(chambre.ticks, []);

  // L'échéance de la chambre arrive : elle rejoint la ronde suivante.
  chambre.due = 2 * BASE_MS;
  homey.advance(BASE_MS);
  await FakeHomey.flush();
  assert.deepEqual(chambre.ticks, [2 * BASE_MS], 'la chambre est réveillée à son échéance');

  await scheduler.stop();
});

test('une rafale de `requestTick` ne produit QU\'UN tick', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);
  const salon = new Recorder('salon');
  salon.due = Number.POSITIVE_INFINITY; // rien de dû : seul un tick FORCÉ peut le réveiller.
  scheduler.register(salon);

  scheduler.start();
  await FakeHomey.flush();
  assert.deepEqual(salon.ticks, [], 'le pas de démarrage ne force personne');

  // Consigne changée, nouvelle mesure, fenêtre, mouvement, mode central : cinq événements, un tick.
  for (const reason of ['setpoint', 'measure', 'window', 'motion', 'central']) {
    scheduler.requestTick(reason);
  }
  homey.advance(COALESCE_MS);
  await FakeHomey.flush();

  assert.deepEqual(salon.ticks, [COALESCE_MS], 'un seul recalcul pour toute la rafale');

  await scheduler.stop();
});

test('un tick demandé force TOUT le monde, même ceux qui n\'attendaient rien', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);
  const salon = new Recorder('salon');
  const chambre = new Recorder('chambre');
  salon.due = Number.POSITIVE_INFINITY;
  chambre.due = Number.POSITIVE_INFINITY;
  scheduler.register(salon);
  scheduler.register(chambre);

  scheduler.start();
  await FakeHomey.flush();

  scheduler.requestTick('central-mode');
  homey.advance(COALESCE_MS);
  await FakeHomey.flush();

  assert.equal(salon.ticks.length, 1);
  assert.equal(chambre.ticks.length, 1, 'le comptage des demandes porte sur le même instant');

  await scheduler.stop();
});

// --- Robustesse aux échéances illisibles -------------------------------------

test('un participant qui annonce `NaN` ne tue pas l\'ordonnanceur du logement', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);

  const empoisonne = new Recorder('empoisonne');
  empoisonne.due = Number.NaN;
  const salon = new Recorder('salon');

  scheduler.register(empoisonne);
  scheduler.register(salon);

  scheduler.start();
  await FakeHomey.flush();
  homey.advance(BASE_MS);
  await FakeHomey.flush();
  homey.advance(BASE_MS);
  await FakeHomey.flush();

  assert.equal(salon.ticks.length, 3, 'la régulation périodique continue pour tout le monde');
  assert.equal(scheduler.active, true, 'l\'ordonnanceur bat toujours');

  await scheduler.stop();
});

test('une échéance qui LÈVE fait tiquer : mieux vaut réguler une fois de trop que jamais', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);

  const cassé: Tickable = {
    tickId: 'casse',
    dueAtMs: () => { throw new Error('échéance illisible'); },
    tick: async () => { ticks += 1; },
  };
  let ticks = 0;

  scheduler.register(cassé);
  scheduler.start();
  await FakeHomey.flush();

  assert.equal(ticks, 1);

  await scheduler.stop();
});

test('un pas qui échoue n\'emporte ni les autres, ni le timer', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);

  const salon = new Recorder('salon');
  scheduler.register({
    tickId: 'casse',
    dueAtMs: () => Number.NEGATIVE_INFINITY,
    tick: async () => { throw new Error('émetteur injoignable'); },
  });
  scheduler.register(salon);

  scheduler.start();
  await FakeHomey.flush();
  homey.advance(BASE_MS);
  await FakeHomey.flush();

  assert.equal(salon.ticks.length, 2, 'le salon continue d\'être régulé');
  assert.equal(scheduler.active, true);

  await scheduler.stop();
});

// --- Les deux courses à l'arrêt ----------------------------------------------

test('`stop()` REND la promesse du pas en vol : rien n\'écrit après la remise en état sûr', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);

  const convecteur = new FakeEmitter('convecteur-salon');
  const reprendre = convecteur.pause();

  scheduler.register({
    tickId: 'salon',
    dueAtMs: () => Number.NEGATIVE_INFINITY,
    // Le pas allume le convecteur ; il restera bloqué dans cette écriture.
    tick: async () => { await convecteur.applySwitch([true], homey.now()); },
  });

  scheduler.start();
  await FakeHomey.flush();
  assert.equal(convecteur.switches.length, 0, 'le pas est bien en vol');

  let rendu = false;
  const arret = scheduler.stop().then(() => { rendu = true; });
  await FakeHomey.flush();
  assert.equal(rendu, false, '`stop()` n\'a pas rendu la main pendant que le pas écrit encore');

  reprendre();
  await arret;
  assert.equal(rendu, true);

  // Ordre de `onUninit` : l'attente D'ABORD, la remise en état sûr ensuite.
  await convecteur.applySwitch([false], homey.now());

  assert.deepEqual(
    convecteur.switches.map((s) => s.on), [true, false],
    'le pas en vol est allé au bout, puis la coupure — jamais l\'inverse',
  );
  assert.equal(convecteur.lastSwitch, false, 'le convecteur est ÉTEINT à la fin');
});

test('un pas en vol n\'en laisse pas démarrer un second : les deux écriraient deux instantanés', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);

  const convecteur = new FakeEmitter('convecteur-salon');
  const reprendre = convecteur.pause();
  let entrees = 0;

  scheduler.register({
    tickId: 'salon',
    dueAtMs: () => Number.NEGATIVE_INFINITY,
    tick: async () => {
      entrees += 1;
      await convecteur.applySwitch([true], homey.now());
    },
  });

  scheduler.start();
  await FakeHomey.flush();
  assert.equal(entrees, 1);

  // Le pas dépasse plusieurs battements de base. Aucun ne doit s'empiler par-dessus.
  homey.advance(3 * BASE_MS);
  await FakeHomey.flush();
  assert.equal(entrees, 1, 'aucun second pas n\'a démarré sur le même participant');

  reprendre();
  await FakeHomey.flush();
  assert.equal(convecteur.switches.length, 1, 'une seule commande est partie');

  await scheduler.stop();
});

test('`stop()` ne laisse AUCUNE minuterie armée', async () => {
  const homey = new FakeHomey();
  const scheduler = newScheduler(homey);
  scheduler.register(new Recorder('salon'));

  scheduler.start();
  await FakeHomey.flush();
  assert.equal(homey.pending, 1, 'le battement de base est armé');

  // Une demande hors cycle arme en plus la minuterie de coalescence.
  scheduler.requestTick('setpoint');
  assert.equal(homey.pending, 2);

  await scheduler.stop();
  assert.equal(homey.pending, 0, 'rien ne survivra au rechargement de l\'app');
  assert.equal(scheduler.active, false);

  // Et plus rien ne repart : un ordonnanceur arrêté est arrêté.
  scheduler.requestTick('trop-tard');
  assert.equal(homey.pending, 0);
});
