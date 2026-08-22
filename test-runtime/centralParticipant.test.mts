/**
 * `runtime/participants.mts` — `CentralParticipant`, le pilotage du relais de chaudière.
 *
 * PANNE EMPÊCHÉE : la chaudière jamais recommandée. Au démarrage, la liaison au relais n'est pas
 * encore résolue quand la première demande arrive. `stepBoiler` ne produit un ordre que sur
 * CHANGEMENT : un ordre perdu au démarrage n'était jamais réémis, la maison restait froide toute
 * la journée et la tuile affichait « en marche ».
 *
 * Chaque assertion regarde le relais, pas l'agrégateur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BoilerParams, Demand } from '../lib/types.mjs';
import { CentralParticipant } from '../runtime/participants.mjs';
import { FakeBinding } from './fakes/binding.mjs';
import { FakeDeviceHost } from './fakes/deviceHost.mjs';

/** Seuil à un émetteur, aucun délai d'activation, garde-fou anti-pulsation à 60 s. */
const PARAMS: BoilerParams = {
  threshold: 1, activationDelaySec: 0, minDwellSec: 60, keepAliveSec: 0,
};

const ACTIVE: Demand = { kind: 'active', percent: 80 };
const INACTIVE: Demand = { kind: 'inactive' };
const UNKNOWN: Demand = { kind: 'unknown' };

interface World {
  host: FakeDeviceHost;
  relay: FakeBinding;
  central: CentralParticipant;
}

function world(params: Partial<BoilerParams> = {}): World {
  const host = new FakeDeviceHost('central');
  const relay = new FakeBinding();
  relay.deviceId = 'relay-1';
  relay.capabilityId = 'onoff';

  const central = new CentralParticipant({
    host,
    boiler: relay,
    params: { ...PARAMS, ...params },
    mode: 'auto',
    requestTick: () => undefined,
    nowMs: 0,
  });

  return { host, relay, central };
}

/** L'état RÉEL du relais : la dernière valeur qui lui est parvenue, `undefined` si jamais rien. */
function relayState(relay: FakeBinding): boolean | undefined {
  const last = relay.lastWrite;
  return last === undefined ? undefined : last.value === true;
}

// --- Le scénario qui pouvait laisser une maison froide une journée ----------

test('un ordre perdu sur une liaison non résolue est REJOUÉ au tick suivant', async () => {
  const { host, relay, central } = world();

  // Premier tick : le hub monte encore, la liaison n'a pas d'appareil. L'écriture lève.
  relay.unresolve();
  await central.applyBoiler([ACTIVE], 0);

  assert.equal(relayState(relay), undefined, 'rien n\'est arrivé au relais');
  assert.equal(
    host.lastPublished('vtherm_boiler_active'), false,
    'la tuile ne prétend pas que la chaudière tourne',
  );
  assert.ok(host.errors.length > 0, 'l\'échec est journalisé, pas avalé');

  // Second tick, la liaison est là. C'est ICI que tout se joue : sans retour en arrière de l'état,
  // `stepBoiler` ne verrait aucun changement et n'émettrait plus jamais d'ordre.
  relay.acceptWrites();
  await central.applyBoiler([ACTIVE], 10_000);

  assert.equal(relayState(relay), true, 'la chaudière est ALLUMÉE');
  assert.equal(host.lastPublished('vtherm_boiler_active'), true);
  assert.deepEqual(host.flowKinds(), ['boiler_started'], 'et le Flow part une seule fois');
});

test('le garde-fou anti-pulsation ne bloque pas le rattrapage : il n\'y a eu aucune commutation', async () => {
  const { relay, central } = world();

  relay.unresolve();
  await central.applyBoiler([ACTIVE], 0);
  relay.acceptWrites();

  // Une seconde plus tard seulement — bien en deçà des 60 s. L'ordre perdu n'était pas une
  // commutation : rien ne doit retarder celui qui le remplace.
  await central.applyBoiler([ACTIVE], 1_000);
  assert.equal(relayState(relay), true, 'la chaudière est ALLUMÉE dès la seconde suivante');
});

// --- Cas nominal -------------------------------------------------------------

test('allumage, puis extinction IMMÉDIATE, puis rallumage retenu 60 s', async () => {
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  assert.equal(relayState(relay), true, 'la chaudière est ALLUMÉE');
  const afterStart = relay.writes.length;

  // Extinction : jamais différée. Faire tourner une chaudière sur un circuit fermé est une
  // surpression, pas une inélégance.
  await central.applyBoiler([INACTIVE], 10_000);
  assert.equal(relayState(relay), false, 'la chaudière est ÉTEINTE dix secondes plus tard');

  // Rallumage vingt secondes après la coupure : refusé, le relais reste coupé.
  await central.applyBoiler([ACTIVE], 30_000);
  assert.equal(relayState(relay), false, 'la chaudière est toujours ÉTEINTE');
  assert.equal(relay.writes.length, afterStart + 1, 'aucune commutation supplémentaire');

  // Passé les 60 s, la demande tient toujours : on rallume.
  await central.applyBoiler([ACTIVE], 71_000);
  assert.equal(relayState(relay), true, 'la chaudière est ALLUMÉE');
});

test('une demande inconnue n\'allume rien : on ne chauffe pas sur de l\'ignorance', async () => {
  const { relay, central } = world();

  await central.applyBoiler([UNKNOWN, UNKNOWN], 0);
  assert.notEqual(relayState(relay), true, 'la chaudière n\'est pas allumée');
});

// --- Déduplication : surtout pas un retour en arrière ------------------------

test('une écriture DÉDUPLIQUÉE ne fait pas revenir l\'état en arrière', async () => {
  const { host, relay, central } = world();

  // Le relais porte déjà `true` — après un redémarrage d'app, par exemple. Le hub déduplique.
  relay.dedupeWrites();
  await central.applyBoiler([ACTIVE], 0);

  assert.equal(host.lastPublished('vtherm_boiler_active'), true, 'la chaudière est en marche');
  assert.deepEqual(host.flowKinds(), ['boiler_started']);

  // Si l'état était revenu en arrière, ce tick réémettrait un ordre d'allumage. Il ne doit pas :
  // le relais est déjà dans le bon état, et un contacteur se compte en commutations.
  relay.acceptWrites();
  await central.applyBoiler([ACTIVE], 10_000);
  assert.equal(relay.writes.length, 0, 'aucun nouvel ordre : rien n\'avait été perdu');

  // Et la coupure, elle, part bien : l'état n'a pas été corrompu au passage.
  await central.applyBoiler([INACTIVE], 20_000);
  assert.equal(relayState(relay), false, 'la chaudière est ÉTEINTE');
});

// --- Sortie propre -----------------------------------------------------------

test('à l\'arrêt de l\'app la chaudière est coupée, et l\'extinction est persistée', async () => {
  const { host, relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  assert.equal(relayState(relay), true);

  await central.restoreSafeState();

  assert.equal(relayState(relay), false, 'la chaudière est ÉTEINTE');
  const stored = host.getStoreValue('central.boiler') as { commanded?: unknown } | undefined;
  assert.equal(
    stored?.commanded, false,
    'au redémarrage on repart d\'éteinte : sinon la réaffirmation rallume quinze secondes plus tard',
  );
});

// --- Le relais qui dérive tout seul -----------------------------------------
//
// PANNE EMPÊCHÉE : le modèle dit ALLUMÉE, la maison reste froide. Un ordre avalé en route ne
// lève pas — l'app le croit parti — et `stepBoiler` ne réémet que sur CHANGEMENT. Sans lecture en
// retour, l'écart n'était jamais rattrapé.

test('un relais retombé à OFF tout seul est rallumé, sans carte Flow', async () => {
  const { host, relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  assert.equal(relayState(relay), true);
  const flowsAfterIgnition = host.flowKinds().length;

  // Micro-coupure : la prise revient sur son `power_on_behavior`, et le dit par le websocket.
  relay.setReading(false, 61_000);
  await central.applyBoiler([ACTIVE], 61_000);

  assert.equal(relay.writes.length, 2, 'le relais a été remis en accord');
  assert.equal(relayState(relay), true, 'la chaudière est RALLUMÉE');
  assert.equal(
    host.flowKinds().length, flowsAfterIgnition,
    'une correction n\'est pas une commutation : « la chaudière démarre » ne doit pas repartir',
  );
});

test('la correction FORCE l\'écriture : sans ça la déduplication l\'avalerait', async () => {
  // La valeur corrigée est identique à la dernière écrite. `shouldWrite` la supprimerait comme
  // « unchanged » — et la correction n'aurait servi à rien.
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  const request = relay.lastWrite;
  assert.ok(request !== undefined);

  relay.setReading(false, 61_000);
  await central.applyBoiler([ACTIVE], 61_000);

  assert.equal(relay.writes.length, 2);
  assert.equal(relay.writes[1]?.value, true);
});

test('un relais devenu indisponible n\'est pas corrigé', async () => {
  // `stale` ne dit pas « éteint », il dit « on ne sait pas ». Corriger sur une lecture périmée,
  // c'est commuter une chaudière sur de l'ignorance — exactement ce que le reste de l'app refuse.
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  relay.setReading(false, 61_000, true);
  await central.applyBoiler([ACTIVE], 61_000);

  assert.equal(relay.writes.length, 1, 'aucun ordre supplémentaire');
});

test('un relais resté ALLUMÉ après la coupure est recoupé immédiatement', async () => {
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  await central.applyBoiler([INACTIVE], 10_000);
  assert.equal(relayState(relay), false);

  // Le relais n'a pas obéi : il chauffe un circuit dont toutes les vannes sont fermées.
  relay.setReading(true, 11_000);
  await central.applyBoiler([INACTIVE], 11_000);

  assert.equal(relay.writes.length, 3, 'recoupé sans attendre le garde-fou');
  assert.equal(relayState(relay), false);
});

// --- Échéance annoncée pendant l'attente ------------------------------------

test('l\'échéance annoncée pendant une attente du garde-fou est son expiration EXACTE', async () => {
  // Avant, `dueAtMs()` rendait un instant déjà passé : le cycle complet du logement se jugeait dû
  // à chaque battement pendant toute la minute, pour un allumage qu'on savait refusé — et la
  // reprise avait lieu au battement suivant plutôt qu'à l'instant où le garde-fou expire.
  const { central } = world();

  await central.applyBoiler([ACTIVE], 0);
  await central.applyBoiler([INACTIVE], 5_000); // coupure immédiate, garde-fou armé à 5 s
  await central.applyBoiler([ACTIVE], 6_000);   // allumage refusé

  assert.equal(central.dueAtMs(), 5_000 + 60_000);
});

test('l\'attente du garde-fou est tracée une fois, à l\'entrée et à la sortie', async () => {
  // C'est la seule explication disponible du symptôme « je change ma consigne et la chaudière ne
  // change pas de statut ». Tracée à chaque pas, elle noierait le tampon de diagnostic.
  const { host, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  await central.applyBoiler([INACTIVE], 5_000);

  await central.applyBoiler([ACTIVE], 6_000);
  await central.applyBoiler([ACTIVE], 16_000);
  await central.applyBoiler([ACTIVE], 26_000);

  const blocked = host.logs.filter((line) => line.includes('diffère l\'allumage'));
  assert.equal(blocked.length, 1, 'une seule ligne pour toute l\'attente');
  assert.match(blocked[0] ?? '', /59 s/, 'le temps restant est annoncé');

  // L'attente qui débouche sur un allumage n'est pas annoncée deux fois : la commutation suit.
  await central.applyBoiler([ACTIVE], 65_000);
  assert.equal(host.logs.filter((line) => line.includes('abandonnée')).length, 0);
  assert.equal(host.logs.filter((line) => line.includes('ALLUMÉE')).length, 2);
});

test('une attente d\'allumage abandonnée est dite, sinon le journal ne se conclut jamais', async () => {
  const { host, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  await central.applyBoiler([INACTIVE], 5_000);
  await central.applyBoiler([ACTIVE], 6_000);   // différé par le garde-fou

  // La pièce a atteint sa consigne avant l'expiration : plus personne ne demande.
  await central.applyBoiler([INACTIVE], 20_000);

  assert.equal(
    host.logs.filter((line) => line.includes('Attente d\'allumage abandonnée')).length, 1,
  );
});

test('la correction survit à la déduplication RÉELLE, pas à un faux complaisant', async () => {
  // La valeur corrigée est identique à la dernière écrite : sans `maxIntervalMs`, `shouldWrite`
  // la supprime. Une revue a démontré le trou en retirant le forçage sans faire tomber un test.
  const { relay, central } = world();
  relay.policyWrites();

  await central.applyBoiler([ACTIVE], 0);
  assert.equal(relay.writes.length, 1);

  relay.setReading(false, 61_000);
  await central.applyBoiler([ACTIVE], 61_000);

  assert.equal(relay.writes.length, 2, 'la correction est bien PARTIE malgré la déduplication');
  assert.equal(relay.writes[1]?.opts.maxIntervalMs, 1, 'et c\'est le forçage qui l\'a fait passer');
});

test('un relais silencieux depuis des heures reste corrigible', async () => {
  // La lecture ignore l'ÂGE, et c'est le régime que la correction existe pour rattraper : un
  // relais qui ne bascule pas ne réémet rien. Un seuil de fraîcheur ordinaire la rendrait aveugle
  // exactement là où elle sert.
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  relay.setReading(false, 0); // dernière annonce à t=0…
  await central.applyBoiler([ACTIVE], 4 * 3_600_000); // …lue quatre heures plus tard

  assert.equal(relay.writes.length, 2);
  assert.equal(relayState(relay), true);
});

test('une correction qui ÉCHOUE n\'efface pas l\'espacement des retentatives', async () => {
  // Le cas qui fait échouer l'écriture est justement le quota d'API atteint. Rendre la marque au
  // retour arrière ferait retenter à chaque pas — l'app creuserait le trou où elle est tombée.
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  relay.setReading(false, 61_000);
  relay.failWrites();

  const before = relay.attempts.length;
  await central.applyBoiler([ACTIVE], 61_000);   // correction tentée, échouée
  await central.applyBoiler([ACTIVE], 66_000);
  await central.applyBoiler([ACTIVE], 71_000);
  await central.applyBoiler([ACTIVE], 76_000);

  // Compté en TENTATIVES : une écriture qui lève ne figure pas dans `writes`, et s'y fier laissait
  // passer un espacement entièrement supprimé.
  assert.equal(
    relay.attempts.length - before, 1,
    'une seule tentative en 15 s : l\'espacement compte les appels, pas les succès',
  );

  // Et il retente bien une fois l'espacement écoulé, sinon la correction serait perdue.
  await central.applyBoiler([ACTIVE], 95_000);
  assert.equal(relay.attempts.length - before, 2);
});

test('l\'échéance annoncée réveille une correction différée', async () => {
  // Sans elle, une correction repoussée attendait le pas d'un AUTRE participant — jusqu'à cinq
  // minutes pendant lesquelles un relais resté allumé continue de chauffer.
  const { relay, central } = world();

  await central.applyBoiler([ACTIVE], 0);
  relay.setReading(false, 61_000);
  await central.applyBoiler([ACTIVE], 61_000); // correction émise

  assert.equal(central.dueAtMs(), 61_000 + 30_000);
});
