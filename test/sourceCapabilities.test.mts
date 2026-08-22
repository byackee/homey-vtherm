/**
 * Les capabilities acceptées pour chaque source, confrontées à du matériel réel.
 *
 * Les détecteurs de présence de l'installation de référence n'exposent PAS `alarm_motion` :
 * les mmWave publient `alarm_presence`, d'autres modèles `alarm_occupancy`. Une seule capability
 * codée en dur les rendait introuvables au pairing — ils n'étaient même pas candidats, et rien
 * ne le signalait puisque la liste s'affichait, simplement sans eux.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCapability } from '../lib/capabilityMatch.mjs';

/**
 * Relevé réel, tel que Homey expose ces appareils. On ne teste pas la carte contre elle-même :
 * on la teste contre ce que la maison contient vraiment.
 */
const REAL_DEVICES: Record<string, string[]> = {
  'detecteur presence cuisine': ['measure_luminance', 'alarm_presence', 'target_distance', 'measure_linkquality'],
  'detecteur presence couloir': ['measure_luminance', 'alarm_presence', 'target_distance', 'measure_linkquality'],
  'detecteur presence SDB': ['alarm_occupancy', 'measure_linkquality'],
  'detecteur presence chambre parentale': ['alarm_occupancy', 'measure_linkquality'],
  'Fenêtre cuisine': ['measure_battery', 'measure_voltage_mv', 'alarm_contact', 'alarm_battery'],
  'Fenêtre salon': ['measure_battery', 'measure_voltage_mv', 'alarm_contact', 'alarm_battery'],
  'Valve radiateur cuisine': ['target_temperature.local', 'measure_temperature.local', 'system_mode',
    'running_state', 'measure_battery'],
  'Detecteur': ['measure_temperature', 'measure_humidity', 'measure_battery'],
  'Chaudière': ['onoff', 'measure_linkquality'],
};

/** Doit rester identique à `SOURCE_CAPABILITIES` de drivers/vtherm/device.mts. */
const ACCEPTED: Record<string, string[]> = {
  room: ['measure_temperature'],
  emitter: ['target_temperature'],
  outdoor: ['measure_temperature'],
  window: ['alarm_contact'],
  motion: ['alarm_motion', 'alarm_presence', 'alarm_occupancy'],
  presence: ['alarm_presence', 'alarm_occupancy', 'alarm_motion'],
};

function candidatesFor(source: string): string[] {
  const accepted = ACCEPTED[source] ?? [];
  return Object.entries(REAL_DEVICES)
    .filter(([, caps]) => accepted.some((want) => matchesCapability(caps, want)))
    .map(([name]) => name);
}

test('les quatre détecteurs de présence sont candidats, quel que soit leur modèle', () => {
  const found = candidatesFor('presence');
  for (const name of ['detecteur presence cuisine', 'detecteur presence couloir',
    'detecteur presence SDB', 'detecteur presence chambre parentale']) {
    assert.ok(found.includes(name), `${name} n'est pas proposé comme capteur de présence`);
  }
});

test('un mmWave en alarm_presence et un capteur en alarm_occupancy sont tous deux acceptés', () => {
  // Le bug : seul `alarm_motion` était accepté, et aucun de ces deux modèles ne le publie.
  assert.ok(candidatesFor('motion').includes('detecteur presence cuisine'));
  assert.ok(candidatesFor('motion').includes('detecteur presence SDB'));
});

test('les contacts de fenêtre sont candidats', () => {
  const found = candidatesFor('window');
  assert.ok(found.includes('Fenêtre cuisine'));
  assert.ok(found.includes('Fenêtre salon'));
});

test('une vanne est candidate comme émetteur malgré sa sous-capability', () => {
  assert.ok(candidatesFor('emitter').includes('Valve radiateur cuisine'));
});

test('les sources ne se mélangent pas', () => {
  // Une fenêtre n'est pas un capteur de présence, et un relais n'est pas un émetteur.
  assert.ok(!candidatesFor('presence').includes('Fenêtre cuisine'));
  assert.ok(!candidatesFor('emitter').includes('Chaudière'));
  assert.ok(!candidatesFor('window').includes('detecteur presence cuisine'));
});

test('un capteur de température de pièce reste proposé', () => {
  assert.ok(candidatesFor('room').includes('Detecteur'));
  // Et une vanne aussi : elle mesure une température, c'est à l'utilisateur de juger.
  assert.ok(candidatesFor('room').includes('Valve radiateur cuisine'));
});
