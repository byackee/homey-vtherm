import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CENTRAL_EXPLAIN_IDS, LINKED_SEPARATOR, VTHERM_EXPLAIN_IDS,
  changedSettings, explainSettings, joinLinkedLabels,
} from '../lib/settingsExplain.mjs';

describe('explainSettings', () => {
  it('traduit chaque identifiant sous la clé attendue par les locales', () => {
    const seen: string[] = [];
    const out = explainSettings(['presets_hint', 'safety_hint'], (key) => {
      seen.push(key);
      return `texte:${key}`;
    });

    assert.deepEqual(seen, ['settings.explain.presets_hint', 'settings.explain.safety_hint']);
    assert.deepEqual(out, {
      presets_hint: 'texte:settings.explain.presets_hint',
      safety_hint: 'texte:settings.explain.safety_hint',
    });
  });

  it('couvre tous les groupes explicatifs des deux drivers', () => {
    // Le manquement se voit à l'usage — un cadre gris vide dans la page — donc jamais en test
    // manuel. Ici la liste est figée : ajouter un groupe sans son explication casse ce test.
    assert.equal(VTHERM_EXPLAIN_IDS.length, 10);
    assert.equal(CENTRAL_EXPLAIN_IDS.length, 1);
    const all = [...VTHERM_EXPLAIN_IDS, ...CENTRAL_EXPLAIN_IDS];
    assert.equal(new Set(all).size, all.length, 'un identifiant est répété');
    assert.ok(!all.includes('linked_devices' as never), 'les appareils liés ne sont pas une explication');
  });
});

describe('changedSettings', () => {
  it('ne renvoie que ce qui diffère de la valeur en place', () => {
    const current: Record<string, unknown> = { a: 'déjà bon', b: 'ancien' };
    const out = changedSettings({ a: 'déjà bon', b: 'nouveau' }, (k) => current[k]);

    assert.deepEqual(out, { b: 'nouveau' });
  });

  it('rend un objet vide quand tout est déjà en place, pour ne pas écrire en flash', () => {
    const current: Record<string, unknown> = { a: 'x', b: 'y' };
    assert.deepEqual(changedSettings({ a: 'x', b: 'y' }, (k) => current[k]), {});
  });

  it("traite une valeur absente comme à écrire", () => {
    // Premier démarrage : le réglage n'a jamais été rempli, `getSetting` rend `null`.
    assert.deepEqual(changedSettings({ a: 'x' }, () => null), { a: 'x' });
    assert.deepEqual(changedSettings({ a: 'x' }, () => undefined), { a: 'x' });
  });

  it('réécrit quand la langue a changé sous le même identifiant', () => {
    assert.deepEqual(
      changedSettings({ safety_hint: 'A dead battery…' }, () => 'Une pile morte…'),
      { safety_hint: 'A dead battery…' },
    );
  });
});

describe('joinLinkedLabels', () => {
  it('sépare visiblement les sources, le retour à la ligne étant écrasé par Homey', () => {
    const out = joinLinkedLabels(['Room sensor : Detecteur', 'Heater : Valve', 'Outdoor : Module']);

    assert.ok(!out.includes('\n'), 'aucun retour à la ligne : Homey les écrase');
    assert.equal(out, `Room sensor : Detecteur${LINKED_SEPARATOR}Heater : Valve${LINKED_SEPARATOR}Outdoor : Module`);
  });

  it('laisse une source unique intacte', () => {
    assert.equal(joinLinkedLabels(['Boiler : Chaudière']), 'Boiler : Chaudière');
  });

  it('rend une chaîne vide sans source', () => {
    assert.equal(joinLinkedLabels([]), '');
  });
});
