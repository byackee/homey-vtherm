/**
 * `runtime/emitter.mts` — la détection du mode, l'anti-écho, et la sortie propre.
 *
 * PANNES EMPÊCHÉES :
 *  - une consigne écrite sur `target_temperature` nu alors que l'appareil ne l'accepte QUE sur
 *    `target_temperature.local` : l'app écrit dans le vide et la vanne ne reçoit jamais rien ;
 *  - l'écho de notre propre `consigne + offset` repris pour une consigne utilisateur, réapplication
 *    de l'offset par-dessus, et la vanne monte jusqu'à sa butée de 35 °C ;
 *  - une vanne rendue « figée » sans que personne le sache, ou un convecteur laissé ALLUMÉ par une
 *    app qui ne le pilote plus.
 *
 * Ce qui est assertionné est ce qui part vers le matériel, pas l'état interne de l'adaptateur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HomeyEmitterAdapter, ECHO_WINDOW_MS, type EmitterFreshness } from '../runtime/emitter.mjs';
import { FakeHub, summaryOf } from './fakes/hub.mjs';
import { FakeValveBackend } from './fakes/valveBackend.mjs';

const FRESHNESS: EmitterFreshness = {
  heatingMs: 2 * 60 * 60_000,
  batteryMs: 24 * 60 * 60_000,
  localTempMs: 2 * 60 * 60_000,
};

const DEVICE_ID = 'emitter-1';

function adapter(hub: FakeHub, backend: FakeValveBackend | null = null): HomeyEmitterAdapter {
  return new HomeyEmitterAdapter({
    hub: hub.asHub(),
    deviceId: DEVICE_ID,
    freshness: FRESHNESS,
    backend,
  });
}

// --- Détection du mode --------------------------------------------------------

test('la consigne part sur la SOUS-capability quand c\'est la seule inscriptible', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature', 'target_temperature.local', 'measure_temperature'],
    // Le cas de l'installation de référence : l'identifiant nu est présent mais en lecture seule.
    setable: ['target_temperature.local'],
  });

  const emitter = adapter(hub);
  await emitter.detect(0);
  assert.equal(emitter.mode, 'setpoint');

  await emitter.applySetpoint(20.5, 0);

  assert.equal(hub.binding('target_temperature.local')?.lastWrite?.value, 20.5, 'la vanne a reçu 20,5');
  assert.equal(hub.binding('target_temperature'), undefined, 'rien n\'est parti dans le vide');
});

test('un appareil sans consigne inscriptible mais dont l\'`onoff` s\'écrit est un INTERRUPTEUR', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    deviceClass: 'socket',
    capabilities: ['onoff', 'measure_power'],
    setable: ['onoff'],
  });

  const emitter = adapter(hub);
  await emitter.detect(0);
  assert.equal(emitter.mode, 'switch');
  assert.equal(emitter.caps.switch, true);
  assert.equal(emitter.caps.setpoint, false);

  await emitter.applySwitch([true], 0);
  assert.equal(hub.binding('onoff')?.lastWrite?.value, true, 'le convecteur est ALLUMÉ');
});

test('une vanne qui expose aussi `onoff` reste une vanne : elle sait recevoir une consigne', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local', 'onoff'],
    setable: ['target_temperature.local', 'onoff'],
  });

  const emitter = adapter(hub);
  await emitter.detect(0);

  assert.notEqual(emitter.mode, 'switch', 'la piloter en temps de marche gâcherait sa régulation');
  await emitter.applySetpoint(19, 0);
  assert.equal(hub.binding('target_temperature.local')?.lastWrite?.value, 19);
});

test('la dorsale débloque le mode vanne ; sans elle on régule par consigne', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local'],
    setable: ['target_temperature.local'],
  });

  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);
  assert.equal(emitter.mode, 'valve');

  // La dorsale tombe : le mode retombe sur la consigne, ce qui est un fonctionnement complet.
  backend.available = false;
  assert.equal(emitter.mode, 'setpoint');
  assert.equal(emitter.caps.valve, false);
});

test('la détection se REJOUE : un device ré-annoncé peut avoir changé de capabilities', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature'],
    setable: ['target_temperature'],
  });

  const emitter = adapter(hub);
  await emitter.detect(0);
  await emitter.applySetpoint(19, 0);
  assert.equal(hub.binding('target_temperature')?.lastWrite?.value, 19);

  // L'app Zigbee2MQTT redémarre, l'appareil revient avec sa consigne rangée ailleurs.
  hub.summary = summaryOf({
    capabilities: ['target_temperature', 'target_temperature.local'],
    setable: ['target_temperature.local'],
  });
  emitter.invalidateDetection();
  assert.equal(emitter.detectionDue(1_000), true);
  await emitter.detect(1_000);

  await emitter.applySetpoint(21, 1_000);
  assert.equal(hub.binding('target_temperature.local')?.lastWrite?.value, 21, 'la vanne reçoit 21');
  assert.equal(
    hub.binding('target_temperature')?.lastWrite?.value, 19,
    'l\'ancien canal n\'a plus rien reçu',
  );
});

// --- Ouverture de vanne : ce qui n'est pas parti n'est pas mémorisé -----------

test('l\'ouverture est arrondie AVANT comparaison : deux consignes voisines font une écriture', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local'], setable: ['target_temperature.local'],
  });
  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);

  await emitter.applyValve(42.4, 0);
  await emitter.applyValve(41.8, 1_000);

  assert.deepEqual(backend.openings.map((o) => o.percent), [42], 'la vanne n\'a été sollicitée qu\'une fois');
});

test('une ouverture qui n\'est pas partie laisse le DOUTE, et la suivante repart', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local'], setable: ['target_temperature.local'],
  });
  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);

  backend.succeeds = false;
  await emitter.applyValve(80, 0);
  assert.deepEqual(backend.openings, [], 'la vanne n\'a pas bougé');
  assert.equal(emitter.valveUnconfirmed, true, 'la demande de chaleur doit être dégradée');

  // Rien n'a été mémorisé : la même consigne doit repartir, sinon la vanne resterait à sa
  // position précédente pendant toute l'heure du rafraîchissement forcé.
  backend.succeeds = true;
  await emitter.applyValve(80, 1_000);
  assert.equal(backend.lastOpening, 80, 'la vanne est ouverte à 80 %');
  assert.equal(emitter.valveUnconfirmed, false, 'le doute est levé');
});

// --- Anti-écho (SPEC §5.4) ----------------------------------------------------

test('une valeur relue égale à la dernière envoyée est notre propre écho, pas une consigne', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local'], setable: ['target_temperature.local'],
  });
  const emitter = adapter(hub);
  await emitter.detect(0);

  await emitter.applySetpoint(20.5, 0);
  const binding = hub.binding('target_temperature.local');
  assert.ok(binding !== undefined);

  binding.setReading(20.5, 0);
  assert.equal(emitter.readSetpoint(1_000), null, 'c\'est ce que nous venons d\'écrire');

  // Valeur différente, mais dans la fenêtre d'écho : l'appareil n'a pas fini de digérer.
  binding.setReading(21, 5_000);
  assert.equal(emitter.readSetpoint(5_000), null);

  // Passée la fenêtre, une valeur différente est bien une consigne posée par quelqu'un d'autre.
  binding.setReading(21, ECHO_WINDOW_MS + 1_000);
  assert.equal(emitter.readSetpoint(ECHO_WINDOW_MS + 1_000)?.value, 21);
});

// --- Rendre la vanne quand la dorsale disparaît -------------------------------

test('aucune ouverture jamais commandée : il n\'y a rien à rendre, donc rien à signaler', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local'], setable: ['target_temperature.local'],
  });
  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);

  assert.equal(await emitter.releaseValve(0), true);
  assert.deepEqual(backend.openings, []);
});

test('la vanne est rendue OUVERTE à 100 %, sur son propre capteur, sans calibrage', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local', 'measure_temperature'],
    setable: ['target_temperature.local'],
  });
  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);

  // Une journée de régulation : la vanne a été ramenée à 12 % et bascule sur le capteur externe.
  await emitter.applyValve(12, 0);
  await emitter.pushRoomTemperature(19.4, 'external', 0);
  assert.deepEqual(backend.sensorSelects, ['external']);

  assert.equal(await emitter.releaseValve(60_000), true);

  assert.equal(backend.lastOpening, 100, 'la vanne est GRANDE OUVERTE : la pièce peut remonter');
  assert.deepEqual(backend.sensorSelects, ['external', 'internal'], 'elle régule sur son thermomètre');
});

test('une vanne qu\'on n\'a PAS pu rendre le dit : c\'est elle qui déclenche l\'avertissement', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local'], setable: ['target_temperature.local'],
  });
  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);

  await emitter.applyValve(12, 0);
  // La dorsale vient justement de tomber : la publication ne part pas.
  backend.succeeds = false;

  assert.equal(await emitter.releaseValve(60_000), false, 'la vanne est restée figée à 12 %');
});

// --- Remise en état sûr (SPEC §11.1) ------------------------------------------

test('un émetteur de type interrupteur est ÉTEINT, et rien d\'autre ne lui est envoyé', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    deviceClass: 'socket', capabilities: ['onoff'], setable: ['onoff'],
  });
  const emitter = adapter(hub);
  await emitter.detect(0);

  await emitter.applySwitch([true], 0);
  assert.equal(hub.binding('onoff')?.lastWrite?.value, true);

  await emitter.restoreSafeState(19);

  assert.equal(
    hub.binding('onoff')?.lastWrite?.value, false,
    'le convecteur est ÉTEINT : une pièce chauffée sans personne pour couper est le seul vrai danger',
  );
});

test('une vanne est rendue avant que la consigne utilisateur BRUTE ne lui soit posée', async () => {
  const hub = new FakeHub();
  hub.summary = summaryOf({
    capabilities: ['target_temperature.local', 'system_mode'],
    setable: ['target_temperature.local', 'system_mode'],
  });
  const backend = new FakeValveBackend();
  const emitter = adapter(hub, backend);
  await emitter.detect(0);

  await emitter.applyValve(12, 0);
  await emitter.applySetpoint(17, 0);

  await emitter.restoreSafeState(19);

  assert.equal(backend.lastOpening, 100, 'la vanne est OUVERTE : une vanne à 12 % ne chauffe rien');
  assert.deepEqual(backend.calibrations, [], 'aucun calibrage n\'avait été posé, rien à annuler');
  assert.equal(hub.binding('system_mode')?.lastWrite?.value, 'auto');
  assert.equal(
    hub.binding('target_temperature.local')?.lastWrite?.value, 19,
    'la consigne utilisateur, sans le décalage de l\'auto-régulation',
  );
});
