import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALIBRATION_ABS_MAX,
  EXTERNAL_TEMPERATURE_MAX,
  buildBridgeDevicesTopic,
  buildBrokerUrl,
  buildCalibrationPayload,
  buildExternalTemperaturePayload,
  buildSensorSelectPayload,
  buildSetTopic,
  buildValvePayload,
  clampCalibration,
  clampExternalTemperature,
  clampValveOpening,
  extractDeviceHint,
  parseBridgeDevices,
  resolveFriendlyName,
  validateBrokerConfig,
} from '../lib/mqttPayload.mjs';
import type { BridgeDevice } from '../lib/mqttPayload.mjs';

// --- Bornage de l'ouverture ---------------------------------------------------

test('ouverture : la plage nominale traverse sans être touchée', () => {
  assert.equal(clampValveOpening(0), 0);
  assert.equal(clampValveOpening(37), 37);
  assert.equal(clampValveOpening(100), 100);
});

test('ouverture : arrondie à l\'entier, le pas de la propriété est 1', () => {
  assert.equal(clampValveOpening(37.4), 37);
  assert.equal(clampValveOpening(37.5), 38);
  assert.equal(clampValveOpening(37.6), 38);
});

test('ouverture : hors plage, on borne au lieu de laisser Z2M rejeter en silence', () => {
  assert.equal(clampValveOpening(-5), 0);
  assert.equal(clampValveOpening(140), 100);
});

test('ouverture : une entrée non finie ne produit aucune valeur', () => {
  assert.equal(clampValveOpening(Number.NaN), null);
  assert.equal(clampValveOpening(Number.POSITIVE_INFINITY), null);
});

// --- Bornage de la température ------------------------------------------------

test('température : arrondie au dixième, c\'est le pas du TRVZB', () => {
  assert.equal(clampExternalTemperature(21.44), 21.4);
  assert.equal(clampExternalTemperature(21.45), 21.5);
  assert.equal(clampExternalTemperature(-0.04), 0);
});

test('température : la borne haute 99,9 tient même après arrondi', () => {
  // 99,96 s'arrondit à 100,0 : sans bornage APRÈS arrondi, le message partirait hors plage.
  assert.equal(clampExternalTemperature(99.96), EXTERNAL_TEMPERATURE_MAX);
  assert.equal(clampExternalTemperature(150), EXTERNAL_TEMPERATURE_MAX);
});

test('température : les négatives sont ramenées à 0, la propriété ne les accepte pas', () => {
  assert.equal(clampExternalTemperature(-12), 0);
});

test('température : arrondi propre, pas de résidu binaire', () => {
  // 0,1 + 0,2 = 0,30000000000000004 ; le payload JSON ne doit pas porter cette queue.
  assert.equal(clampExternalTemperature(0.1 + 0.2), 0.3);
});

// --- Bornage du calibrage -----------------------------------------------------

test('calibrage : borné à ±12,7, dans les deux sens', () => {
  assert.equal(clampCalibration(20), CALIBRATION_ABS_MAX);
  assert.equal(clampCalibration(-20), -CALIBRATION_ABS_MAX);
  assert.equal(clampCalibration(-3.25), -3.3);
});

test('calibrage : zéro est une valeur légitime, pas une absence', () => {
  assert.equal(clampCalibration(0), 0);
});

test('calibrage : l\'arrondi est symétrique autour de zéro', () => {
  // `Math.round` arrondit vers +∞ : sans correction, −3,25 donnerait −3,2 quand 3,25 donne 3,3.
  // Le calibrage étant incrémental, cette asymétrie dériverait d'un dixième par écriture.
  assert.equal(clampCalibration(3.25), 3.3);
  assert.equal(clampCalibration(-3.25), -3.3);
  assert.equal(Number(clampCalibration(1.15)) + Number(clampCalibration(-1.15)), 0);
});

// --- Payloads -----------------------------------------------------------------

test('vanne : ouverture et fermeture voyagent dans le même payload', () => {
  // SPEC §5.5 : une seule écriture Zigbee, ces vannes sont sur piles.
  assert.deepEqual(buildValvePayload(30), {
    valve_opening_degree: 30,
    valve_closing_degree: 70,
  });
});

test('vanne : la fermeture vaut toujours 100 − ouverture, aux bornes comprises', () => {
  for (const percent of [0, 1, 50, 99, 100]) {
    const payload = buildValvePayload(percent);
    assert.notEqual(payload, null);
    const opening = payload?.['valve_opening_degree'];
    const closing = payload?.['valve_closing_degree'];
    assert.equal(typeof opening, 'number');
    assert.equal(Number(opening) + Number(closing), 100);
  }
});

test('vanne : la fermeture est calculée sur la valeur BORNÉE, pas sur l\'entrée brute', () => {
  // 140 % borné à 100 doit donner une fermeture de 0, jamais −40 : Z2M rejetterait le message.
  assert.deepEqual(buildValvePayload(140), {
    valve_opening_degree: 100,
    valve_closing_degree: 0,
  });
});

test('vanne : entrée non finie, aucun payload — mieux vaut ne rien publier', () => {
  assert.equal(buildValvePayload(Number.NaN), null);
});

test('température externe : payload minimal, une seule propriété', () => {
  assert.deepEqual(buildExternalTemperaturePayload(21.37), { external_temperature_input: 21.4 });
  assert.equal(buildExternalTemperaturePayload(Number.NaN), null);
});

test('calibrage : payload minimal, une seule propriété', () => {
  assert.deepEqual(buildCalibrationPayload(1.55), { local_temperature_calibration: 1.6 });
  assert.equal(buildCalibrationPayload(Number.POSITIVE_INFINITY), null);
});

test('sélection du capteur : les deux sources acceptées', () => {
  assert.deepEqual(buildSensorSelectPayload('external'), { temperature_sensor_select: 'external' });
  assert.deepEqual(buildSensorSelectPayload('internal'), { temperature_sensor_select: 'internal' });
});

// --- Topics -------------------------------------------------------------------

test('topic : forme exacte publiée par l\'app Z2M', () => {
  assert.equal(buildSetTopic('zigbee2mqtt', 'Valve radiateur cuisine'), 'zigbee2mqtt/Valve radiateur cuisine/set');
});

test('topic : les slashes en trop sont absorbés, ceux du milieu sont conservés', () => {
  assert.equal(buildSetTopic('/maison/z2m/', 'Valve'), 'maison/z2m/Valve/set');
});

test('topic : un morceau vide ne produit pas de topic', () => {
  assert.equal(buildSetTopic('', 'Valve'), null);
  assert.equal(buildSetTopic('zigbee2mqtt', '   '), null);
});

test('topic : un joker MQTT est refusé, on ne publie pas sur un filtre', () => {
  assert.equal(buildSetTopic('zigbee2mqtt', 'Valve/#'), null);
  assert.equal(buildSetTopic('zigbee2mqtt', 'Valve+'), null);
  assert.equal(buildSetTopic('zig#bee', 'Valve'), null);
});

test('topic bridge/devices : dérivé du même base_topic', () => {
  assert.equal(buildBridgeDevicesTopic('zigbee2mqtt'), 'zigbee2mqtt/bridge/devices');
  assert.equal(buildBridgeDevicesTopic(' /zigbee2mqtt/ '), 'zigbee2mqtt/bridge/devices');
  assert.equal(buildBridgeDevicesTopic(''), null);
});

// --- Configuration du broker -----------------------------------------------------

test('config : une saisie complète et plausible passe', () => {
  assert.equal(
    validateBrokerConfig({ host: '192.168.1.50', port: 1883, baseTopic: 'zigbee2mqtt' }),
    null,
  );
});

test('config : chaque erreur de saisie a sa propre raison', () => {
  // « broker injoignable » après dix secondes n'aiderait personne à corriger un port à 0.
  assert.equal(validateBrokerConfig({ host: '  ', port: 1883, baseTopic: 'zigbee2mqtt' }), 'host_missing');
  assert.equal(validateBrokerConfig({ host: 'h', port: 0, baseTopic: 'zigbee2mqtt' }), 'port_invalid');
  assert.equal(validateBrokerConfig({ host: 'h', port: 70000, baseTopic: 'zigbee2mqtt' }), 'port_invalid');
  assert.equal(validateBrokerConfig({ host: 'h', port: 1883.5, baseTopic: 'zigbee2mqtt' }), 'port_invalid');
  assert.equal(validateBrokerConfig({ host: 'h', port: 1883, baseTopic: '' }), 'base_topic_invalid');
  assert.equal(validateBrokerConfig({ host: 'h', port: 1883, baseTopic: 'z2m/#' }), 'base_topic_invalid');
});

test('url : une adresse nue reçoit le schéma mqtt et le port saisi', () => {
  assert.equal(buildBrokerUrl('192.168.1.50', 1883), 'mqtt://192.168.1.50:1883');
  assert.equal(buildBrokerUrl(' broker.local ', 1884), 'mqtt://broker.local:1884');
});

test('url : un port déjà écrit dans l\'adresse gagne sur le champ port', () => {
  // Sinon `mqtts://broker:8883` se connecterait au 1883 par défaut, c\'est-à-dire ailleurs.
  assert.equal(buildBrokerUrl('mqtts://broker.local:8883', 1883), 'mqtts://broker.local:8883');
  assert.equal(buildBrokerUrl('192.168.1.50:1884', 1883), 'mqtt://192.168.1.50:1884');
});

test('url : le schéma saisi est respecté', () => {
  assert.equal(buildBrokerUrl('ws://broker.local', 9001), 'ws://broker.local:9001');
  assert.equal(buildBrokerUrl('mqtts://broker.local/', 8883), 'mqtts://broker.local:8883');
});

test('url : une IPv6 entre crochets n\'est pas prise pour une adresse à port', () => {
  assert.equal(buildBrokerUrl('[fd00::1]', 1883), 'mqtt://[fd00::1]:1883');
  assert.equal(buildBrokerUrl('[fd00::1]:1884', 1883), 'mqtt://[fd00::1]:1884');
});

// --- Analyse de bridge/devices -------------------------------------------------

test('bridge/devices : les entrées complètes sont retenues, les autres écartées', () => {
  const parsed = parseBridgeDevices([
    { friendly_name: 'Valve radiateur cuisine', ieee_address: '0x00124B0022AA', type: 'EndDevice' },
    { friendly_name: 'Sans adresse' },
    { ieee_address: '0x00124B0022BB' },
    { friendly_name: '   ', ieee_address: '0x00124B0022CC' },
    null,
    'pas un objet',
  ]);
  assert.deepEqual(parsed, [
    { friendlyName: 'Valve radiateur cuisine', ieeeAddress: '0x00124B0022AA' },
  ]);
});

test('bridge/devices : une charge utile qui n\'est pas un tableau ne casse rien', () => {
  assert.deepEqual(parseBridgeDevices({ devices: [] }), []);
  assert.deepEqual(parseBridgeDevices(null), []);
  assert.deepEqual(parseBridgeDevices(undefined), []);
});

// --- Indices tirés des réglages Homey -------------------------------------------

test('indices : les clés usuelles de l\'app Z2M sont reconnues', () => {
  assert.deepEqual(
    extractDeviceHint({ friendly_name: 'Valve salon', ieee_address: '0x00124B0022AA' }),
    { friendlyName: 'Valve salon', ieeeAddress: '0x00124B0022AA' },
  );
});

test('indices : les variantes de nommage sont acceptées', () => {
  assert.deepEqual(
    extractDeviceHint({ friendlyName: 'Valve salon', ieeeAddr: '0x00124B0022AA' }),
    { friendlyName: 'Valve salon', ieeeAddress: '0x00124B0022AA' },
  );
});

test('indices : une chaîne vide vaut « je ne sais pas », pas un nom vide', () => {
  // Une chaîne vide qui remonterait jusqu'à la résolution matcherait sur rien — ou pire, sur tout.
  assert.deepEqual(extractDeviceHint({ friendly_name: '  ', ieee_address: '' }), {
    friendlyName: undefined, ieeeAddress: undefined,
  });
});

test('indices : des réglages absents ou non-objets ne lèvent pas', () => {
  assert.deepEqual(extractDeviceHint(null), {});
  assert.deepEqual(extractDeviceHint(undefined), {});
  assert.deepEqual(extractDeviceHint('zigbee2mqtt'), {});
});

// --- Résolution Homey → friendly_name --------------------------------------------

const DEVICES: readonly BridgeDevice[] = [
  { friendlyName: 'Valve radiateur cuisine', ieeeAddress: '0x00124B0022AA' },
  { friendlyName: 'Valve radiateur salon', ieeeAddress: '0x00124B0022BB' },
  { friendlyName: 'Detecteur_temp_cuisine', ieeeAddress: '0x00124B0022CC' },
];

test('résolution : l\'adresse IEEE prime, elle est immuable', () => {
  const result = resolveFriendlyName({ ieeeAddress: '0x00124B0022BB', friendlyName: 'Valve radiateur cuisine' }, DEVICES);
  assert.deepEqual(result, { ok: true, friendlyName: 'Valve radiateur salon', via: 'ieee_address' });
});

test('résolution : la casse et le préfixe 0x de l\'adresse IEEE sont indifférents', () => {
  const result = resolveFriendlyName({ ieeeAddress: '00124b0022aa' }, DEVICES);
  assert.deepEqual(result, { ok: true, friendlyName: 'Valve radiateur cuisine', via: 'ieee_address' });
});

test('résolution : sans adresse, le nom exact suffit', () => {
  const result = resolveFriendlyName({ friendlyName: 'Valve radiateur salon' }, DEVICES);
  assert.deepEqual(result, { ok: true, friendlyName: 'Valve radiateur salon', via: 'friendly_name' });
});

test('résolution : une adresse inconnue laisse sa chance au nom', () => {
  // Vanne ré-appairée : nouvelle adresse côté Z2M, nom conservé.
  const result = resolveFriendlyName(
    { ieeeAddress: '0x00124B00DEAD', friendlyName: 'Valve radiateur cuisine' },
    DEVICES,
  );
  assert.deepEqual(result, { ok: true, friendlyName: 'Valve radiateur cuisine', via: 'friendly_name' });
});

test('résolution : repli insensible à la casse, mais seulement s\'il désigne un seul appareil', () => {
  const result = resolveFriendlyName({ friendlyName: 'valve RADIATEUR cuisine' }, DEVICES);
  assert.deepEqual(result, { ok: true, friendlyName: 'Valve radiateur cuisine', via: 'friendly_name' });
});

test('résolution : deux noms ne différant que par la casse ⇒ refus, pas de tirage au sort', () => {
  const ambiguous: BridgeDevice[] = [
    { friendlyName: 'Valve cuisine', ieeeAddress: '0x1' },
    { friendlyName: 'valve cuisine', ieeeAddress: '0x2' },
  ];
  assert.deepEqual(
    resolveFriendlyName({ friendlyName: 'VALVE CUISINE' }, ambiguous),
    { ok: false, reason: 'ambiguous' },
  );
});

test('résolution : AUCUNE correspondance approximative — un préfixe ne suffit pas', () => {
  // C'est l'invariant central de ce module : mieux vaut ne pas piloter la vanne que piloter
  // celle d'une autre pièce.
  assert.deepEqual(resolveFriendlyName({ friendlyName: 'Valve radiateur' }, DEVICES), {
    ok: false, reason: 'not_found',
  });
  assert.deepEqual(resolveFriendlyName({ friendlyName: 'cuisine' }, DEVICES), {
    ok: false, reason: 'not_found',
  });
});

test('résolution : sans indice, on le dit', () => {
  assert.deepEqual(resolveFriendlyName({}, DEVICES), { ok: false, reason: 'no_hint' });
  assert.deepEqual(resolveFriendlyName({ friendlyName: '  ' }, DEVICES), { ok: false, reason: 'no_hint' });
});

test('résolution : bridge/devices pas encore reçu ⇒ raison distincte de « introuvable »', () => {
  // La page de réglages doit pouvoir distinguer « mauvais base_topic » de « mauvais appareil ».
  assert.deepEqual(resolveFriendlyName({ friendlyName: 'Valve radiateur cuisine' }, []), {
    ok: false, reason: 'no_bridge_devices',
  });
});

test('résolution : deux appareils à la même adresse IEEE ⇒ refus', () => {
  const ambiguous: BridgeDevice[] = [
    { friendlyName: 'A', ieeeAddress: '0x00124B0022AA' },
    { friendlyName: 'B', ieeeAddress: '00124b0022aa' },
  ];
  assert.deepEqual(
    resolveFriendlyName({ ieeeAddress: '0x00124B0022AA' }, ambiguous),
    { ok: false, reason: 'ambiguous' },
  );
});
