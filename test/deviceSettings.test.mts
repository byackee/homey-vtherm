/**
 * Le groupe « Appareils liés » des réglages d'appareil.
 *
 * Les réglages de Homey ne savent ni ouvrir une page personnalisée, ni afficher un sélecteur
 * d'appareil : leurs listes déroulantes sont figées dans le manifeste et la plateforme n'expose
 * aucune action de maintenance. Le plus proche d'une « entrée qui ouvre une page » est un groupe
 * unique, dépliable. Les deux drivers y montrent, en lecture seule, ce qui est lié, et disent où
 * le changer — un écran qui liste des appareils sans expliquer comment les modifier est une
 * impasse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SettingNode {
  id?: string;
  type?: string;
  hint?: Record<string, string>;
  label?: Record<string, string>;
  children?: SettingNode[];
}

function load(driverId: string): SettingNode[] {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'drivers', driverId, 'driver.settings.compose.json'), 'utf8'),
  ) as SettingNode[];
}

function flatten(nodes: SettingNode[]): SettingNode[] {
  return nodes.flatMap((n) => (n.children ? [n, ...flatten(n.children)] : [n]));
}

const DRIVERS = ['vtherm', 'central'];

for (const driverId of DRIVERS) {
  test(`${driverId} : une seule entrée « Appareils liés », et elle vient en premier`, () => {
    const groups = load(driverId);
    const linked = groups.filter((g) => g.label?.en === 'Linked devices');
    assert.equal(linked.length, 1, 'il doit y avoir exactement un groupe');
    assert.equal(groups[0]?.label?.en, 'Linked devices',
      'le groupe doit précéder les réglages : c\'est ce qu\'on vient consulter');
  });

  test(`${driverId} : un seul champ, qui porte toutes les sources`, () => {
    const group = load(driverId).find((g) => g.label?.en === 'Linked devices');
    const children = group?.children ?? [];
    assert.equal(children.length, 1,
      'six champs séparés encombrent l\'écran ; un seul se lit comme une page');
    assert.equal(children[0]?.id, 'linked_devices');
  });

  test(`${driverId} : le champ est en lecture seule`, () => {
    // Un champ éditable qui ne pilote rien serait pire que pas de champ : l'utilisateur croirait
    // avoir changé quelque chose.
    const node = flatten(load(driverId)).find((n) => n.id === 'linked_devices');
    assert.equal(node?.type, 'label');
  });

  test(`${driverId} : le champ dit où changer les appareils`, () => {
    const node = flatten(load(driverId)).find((n) => n.id === 'linked_devices');
    for (const lang of ['en', 'fr', 'nl']) {
      const hint = node?.hint?.[lang] ?? '';
      assert.ok(hint.length > 0, `pas d'explication en ${lang}`);
      assert.ok(/Adaptive Thermostat/.test(hint),
        `l'explication en ${lang} ne renvoie pas vers les réglages de l'app`);
    }
  });

  test(`${driverId} : plus aucun champ « linked_ » résiduel`, () => {
    const leftovers = flatten(load(driverId))
      .map((n) => n.id ?? '')
      .filter((id) => id.startsWith('linked_') && id !== 'linked_devices');
    assert.deepEqual(leftovers, [], 'champs d\'une version précédente restés en place');
  });
}

test('chaque source du thermostat a son libellé traduit', () => {
  // Le champ est construit à l'exécution en concaténant ces libellés : une clé manquante
  // afficherait « settings.linked.window : Fenêtre cuisine » à l'utilisateur.
  const en = JSON.parse(readFileSync(join(process.cwd(), 'locales/en.json'), 'utf8')) as {
    settings?: { linked?: Record<string, unknown> };
  };
  const linked = en.settings?.linked ?? {};
  for (const key of ['room', 'emitter', 'outdoor', 'window', 'motion', 'presence', 'boiler',
    'none', 'missing']) {
    assert.ok(typeof linked[key] === 'string', `settings.linked.${key} manque`);
  }
});
