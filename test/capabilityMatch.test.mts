import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCapability, resolveCapabilityId } from '../lib/capabilityMatch.mjs';

/** Relevé réel d'une SONOFF TRVZB telle que l'app Zigbee2MQTT l'expose à Homey. */
const TRVZB = [
  'target_temperature.local', 'measure_temperature.local', 'system_mode', 'running_state',
  'measure_battery', 'locked.child', 'alarm_generic.open_window',
  'target_temperature.frost_protection', 'measure_linkquality', 'last_seen',
];

test('une vanne TRVZB est reconnue comme émetteur malgré sa sous-capability', () => {
  // Le bug de production : `includes('target_temperature')` renvoyait faux, et les cinq vannes
  // étaient absentes de la liste des émetteurs.
  assert.equal(TRVZB.includes('target_temperature'), false, 'la capability nue est bien absente');
  assert.equal(matchesCapability(TRVZB, 'target_temperature'), true);
  assert.equal(matchesCapability(TRVZB, 'measure_temperature'), true);
});

test('la capability nue est reconnue aussi', () => {
  assert.equal(matchesCapability(['onoff', 'measure_power'], 'onoff'), true);
});

test('le point est exigé : pas de correspondance par simple préfixe', () => {
  assert.equal(matchesCapability(['measure_temperature_offset'], 'measure_temperature'), false);
  assert.equal(matchesCapability(['onoff_button'], 'onoff'), false);
});

test('absence franche', () => {
  assert.equal(matchesCapability(TRVZB, 'alarm_motion'), false);
  assert.equal(matchesCapability([], 'onoff'), false);
});

test('resolveCapabilityId rend l\'identifiant réellement utilisable', () => {
  assert.equal(resolveCapabilityId(TRVZB, 'target_temperature'), 'target_temperature.local');
  assert.equal(resolveCapabilityId(['onoff'], 'onoff'), 'onoff');
  assert.equal(resolveCapabilityId(TRVZB, 'alarm_motion'), null);
});

test('la sous-capability prime sur la capability nue quand les deux existent', () => {
  // Sur un appareil qui expose les deux, c'est la sous-capability qui porte la valeur réelle.
  assert.equal(resolveCapabilityId(['target_temperature', 'target_temperature.local'],
    'target_temperature'), 'target_temperature.local');
});
