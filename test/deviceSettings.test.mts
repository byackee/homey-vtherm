/**
 * Cohérence entre les réglages déclarés et les sources réellement gérées.
 *
 * Les réglages de Homey ne savent pas afficher un sélecteur d'appareil : leurs listes déroulantes
 * sont figées dans le manifeste. Le thermostat y montre donc, en lecture seule, le nom des
 * appareils qu'il utilise, et renvoie vers les réglages de l'app pour les changer. Ces libellés
 * sont remplis à l'exécution par clé — si une source est ajoutée sans son libellé, ou l'inverse,
 * personne ne s'en aperçoit avant de regarder l'écran.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SettingNode {
  id?: string;
  type?: string;
  children?: SettingNode[];
}

function load(driverId: string): SettingNode[] {
  const path = join(process.cwd(), 'drivers', driverId, 'driver.settings.compose.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SettingNode[];
}

function flatten(nodes: SettingNode[]): SettingNode[] {
  return nodes.flatMap((n) => (n.children ? [n, ...flatten(n.children)] : [n]));
}

/** Doit rester identique à `SOURCE_STORE_KEYS` de drivers/vtherm/device.mts. */
const SOURCE_KEYS = ['room', 'emitter', 'outdoor', 'window', 'motion', 'presence'];

test('le thermostat déclare un libellé par source, et pas un de plus', () => {
  const ids = flatten(load('vtherm'))
    .filter((n) => n.type === 'label' && n.id?.startsWith('linked_'))
    .map((n) => n.id ?? '');

  for (const key of SOURCE_KEYS) {
    assert.ok(ids.includes(`linked_${key}`), `aucun libellé pour la source « ${key} »`);
  }
  const extra = ids.filter((id) => id !== 'linked_hint' && !SOURCE_KEYS.includes(id.slice('linked_'.length)));
  assert.deepEqual(extra, [], 'libellés sans source correspondante');
});

test('les deux drivers expliquent où changer leurs appareils', () => {
  // Un écran qui liste des appareils sans dire comment les changer est une impasse.
  for (const driverId of ['vtherm', 'central']) {
    const hint = flatten(load(driverId)).find((n) => n.id === 'linked_hint');
    assert.ok(hint !== undefined, `${driverId} ne dit pas où changer ses appareils`);
    assert.equal(hint.type, 'label');
  }
});

test('les libellés d\'appareils liés sont en lecture seule', () => {
  // Un champ éditable qui n'est pas relié au store serait un mensonge : l'utilisateur croirait
  // avoir changé quelque chose.
  for (const driverId of ['vtherm', 'central']) {
    for (const node of flatten(load(driverId))) {
      if (!node.id?.startsWith('linked_')) continue;
      assert.equal(node.type, 'label',
        `${driverId} : « ${node.id} » est éditable alors qu'il ne pilote rien`);
    }
  }
});

test('la configuration centrale déclare son relais', () => {
  const ids = flatten(load('central')).map((n) => n.id);
  assert.ok(ids.includes('linked_boiler'));
});
