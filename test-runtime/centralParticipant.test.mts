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
