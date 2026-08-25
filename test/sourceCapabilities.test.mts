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
import { SOURCE_CAPABILITIES, EMITTER_CLASSES } from '../lib/sources.mjs';

interface RealDevice {
  /** Classe Homey de l'appareil : c'est le seul discriminant du filtre émetteur. */
  class: string;
  capabilities: string[];
}

/**
 * Relevé réel, tel que Homey expose ces appareils. On ne teste pas la carte contre elle-même :
 * on la teste contre ce que la maison contient vraiment.
 */
const REAL_DEVICES: Record<string, RealDevice> = {
  'detecteur presence cuisine': {
    class: 'sensor',
    capabilities: ['measure_luminance', 'alarm_presence', 'target_distance', 'measure_linkquality'],
  },
  'detecteur presence couloir': {
    class: 'sensor',
    capabilities: ['measure_luminance', 'alarm_presence', 'target_distance', 'measure_linkquality'],
  },
  'detecteur presence SDB': {
    class: 'sensor',
    capabilities: ['alarm_occupancy', 'measure_linkquality'],
  },
  'detecteur presence chambre parentale': {
    class: 'sensor',
    capabilities: ['alarm_occupancy', 'measure_linkquality'],
  },
  'Fenêtre cuisine': {
    class: 'sensor',
    capabilities: ['measure_battery', 'measure_voltage_mv', 'alarm_contact', 'alarm_battery'],
  },
  'Fenêtre salon': {
    class: 'sensor',
    capabilities: ['measure_battery', 'measure_voltage_mv', 'alarm_contact', 'alarm_battery'],
  },
  'Valve radiateur cuisine': {
    class: 'thermostat',
    capabilities: ['target_temperature.local', 'measure_temperature.local', 'system_mode',
      'running_state', 'measure_battery'],
  },
  'Detecteur': {
    class: 'sensor',
    capabilities: ['measure_temperature', 'measure_humidity', 'measure_battery'],
  },
  // La prise commutée du radiateur de salle de bains : aucune consigne, seulement un `onoff`.
  // C'est elle que le mode interrupteur existe pour piloter.
  'Radiateur SDB': {
    class: 'socket',
    capabilities: ['onoff', 'measure_power', 'measure_current', 'meter_power'],
  },
  'Chaudière': {
    class: 'other',
    capabilities: ['onoff', 'measure_linkquality'],
  },
  // 38 appareils de l'installation portent `onoff`, dont toutes les lampes. Sans filtre de classe,
  // la liste des émetteurs deviendrait un annuaire de la maison.
  'Lampe salon': {
    class: 'light',
    capabilities: ['onoff', 'dim', 'light_temperature'],
  },
  // Aucun capteur de la maison ne publie encore `alarm_open` : c'est la capability système que
  // Homey a introduite au firmware 12.11 pour les ouvertures, et les apps commenceront à s'en
  // servir. Tant que `window` n'acceptait que `alarm_contact`, un tel capteur n'était même pas
  // candidat au pairing — la liste s'affichait, simplement sans lui.
  'Fenêtre bureau (alarm_open)': {
    class: 'sensor',
    capabilities: ['alarm_open', 'measure_battery', 'measure_linkquality'],
  },
};

/**
 * Les tables testées sont les vraies, importées de `lib/sources.mjs`. La suite en gardait une copie
 * manuelle : élargir une source sans toucher la copie laissait les tests valider l'ancienne table.
 */
function candidatesFor(source: string): string[] {
  const accepted: readonly string[] = SOURCE_CAPABILITIES[source as keyof typeof SOURCE_CAPABILITIES] ?? [];
  return Object.entries(REAL_DEVICES)
    .filter(([, device]) => accepted.some((want) => matchesCapability(device.capabilities, want)))
    // Le filtre de classe ne s'applique qu'à l'émetteur : c'est la seule source dont les
    // capabilities acceptées ne suffisent plus à discriminer.
    .filter(([, device]) => source !== 'emitter' || EMITTER_CLASSES.includes(device.class))
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

test('un capteur d\'ouverture en alarm_open est candidat au même titre', () => {
  // Même raison que les détecteurs de présence : la capability dépend du modèle, pas de l'usage.
  assert.ok(candidatesFor('window').includes('Fenêtre bureau (alarm_open)'));
  // Et il ne déborde pas sur les autres sources.
  assert.ok(!candidatesFor('presence').includes('Fenêtre bureau (alarm_open)'));
  assert.ok(!candidatesFor('room').includes('Fenêtre bureau (alarm_open)'));
});

test('alarm_contact reste en tête des capabilities acceptées pour une ouverture', () => {
  // Ce n'est pas cosmétique : `SOURCE_CAPABILITIES.window[0]` est le repli utilisé tant que le hub
  // n'a pas répondu. Le mettre après `alarm_open` lierait les capteurs existants sur une
  // capability qu'ils ne portent pas.
  assert.equal(SOURCE_CAPABILITIES.window[0], 'alarm_contact');
});

test('une vanne est candidate comme émetteur malgré sa sous-capability', () => {
  assert.ok(candidatesFor('emitter').includes('Valve radiateur cuisine'));
});

test('une prise commutée est candidate comme émetteur', () => {
  // Le cas qui motive le mode interrupteur : `onoff` seul, class `socket`, aucune consigne.
  assert.ok(candidatesFor('emitter').includes('Radiateur SDB'));
});

test('les lampes ne polluent pas la liste des émetteurs', () => {
  // Elles portent `onoff` comme la prise du radiateur ; seule leur classe les distingue.
  assert.ok(!candidatesFor('emitter').includes('Lampe salon'));
});

test('les sources ne se mélangent pas', () => {
  // Une fenêtre n'est pas un capteur de présence, et un capteur de présence pas un contact.
  assert.ok(!candidatesFor('presence').includes('Fenêtre cuisine'));
  assert.ok(!candidatesFor('window').includes('detecteur presence cuisine'));
  // Un capteur ne peut pas être émetteur : sa classe l'exclut avant même ses capabilities.
  assert.ok(!candidatesFor('emitter').includes('Detecteur'));
  // Contrepartie assumée du filtre : le relais de chaudière, class `other`, reste proposable
  // comme émetteur. Rien ne le distingue d'un relais de convecteur, ni sa classe ni ses
  // capabilities — et retirer `other` rendrait inatteignables de vrais émetteurs, ce qui est pire.
  assert.ok(candidatesFor('emitter').includes('Chaudière'));
});

test('un capteur de température de pièce reste proposé', () => {
  assert.ok(candidatesFor('room').includes('Detecteur'));
  // Et une vanne aussi : elle mesure une température, c'est à l'utilisateur de juger.
  assert.ok(candidatesFor('room').includes('Valve radiateur cuisine'));
});
