/**
 * Clés de traduction de la page de réglages de l'app.
 *
 * `test/locales.test.mts` ne détecte qu'une divergence ENTRE les trois langues : trois locales
 * amputées de la même façon restent vertes pendant que l'écran affiche des clés brutes. Ce test
 * ferme l'autre moitié du problème — toute clé que la page référence doit exister.
 *
 * Le même contrôle existe pour les vues de pairing ; il manquait ici.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PAGE = join(ROOT, 'settings/index.html');

function leafKeys(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'object' && child !== null) leafKeys(child, path, out);
    else out.add(path);
  }
  return out;
}

test('la page de réglages existe', () => {
  assert.ok(existsSync(PAGE), 'settings/index.html manque');
});

test('toutes les clés référencées par la page de réglages existent', () => {
  const html = readFileSync(PAGE, 'utf8');
  const known = leafKeys(JSON.parse(readFileSync(join(ROOT, 'locales/en.json'), 'utf8')));

  const referenced = new Set<string>();
  for (const pattern of [/data-i18n="([^"]+)"/g, /Homey\.__\('([^']+)'/g, /\bt\('([^']+)'/g]) {
    for (const match of html.matchAll(pattern)) {
      if (match[1] !== undefined) referenced.add(match[1]);
    }
  }

  assert.ok(referenced.size > 0, 'aucune clé détectée — le motif de détection est-il encore juste ?');
  const missing = [...referenced].filter((key) => !known.has(key)).sort();
  assert.deepEqual(missing, [], 'clés référencées par la page mais absentes des traductions');
});

test('la page de réglages sait afficher une erreur', () => {
  // Une page de réglages blanche est aussi opaque qu'une vue de pairing blanche, et elle porte
  // maintenant l'édition des sources : la panne y coûterait plus cher.
  const html = readFileSync(PAGE, 'utf8');
  assert.ok(html.includes("addEventListener('error'"),
    "la page n'intercepte pas les erreurs JavaScript");
});

test('les onglets et leurs panneaux se correspondent', () => {
  // Deux sujets sans rapport cohabitent sur cette page : les appareils d'un thermostat, et
  // l'accès au broker Zigbee2MQTT. Un onglet qui pointe vers un panneau inexistant afficherait
  // une page vide, sans erreur — le mode de panne le plus discret de cette page.
  const html = readFileSync(PAGE, 'utf8');

  const tabs = [...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1] ?? '');
  const panels = [...html.matchAll(/class="panel"[^>]*id="panel-([^"]+)"/g)].map((m) => m[1] ?? '');

  assert.ok(tabs.length >= 2, 'moins de deux onglets : la séparation n\'a plus lieu d\'être');
  assert.deepEqual([...tabs].sort(), [...panels].sort(),
    'un onglet sans panneau, ou un panneau sans onglet');
});

test('un seul panneau est visible au chargement', () => {
  const html = readFileSync(PAGE, 'utf8');
  const panels = [...html.matchAll(/<div class="panel"([^>]*)>/g)].map((m) => m[1] ?? '');
  const visible = panels.filter((attrs) => !attrs.includes('hidden'));
  assert.equal(visible.length, 1,
    'exactement un panneau doit être ouvert à l\'arrivée sur la page');
});

test('les onglets portent type="button"', () => {
  // Sans lui, un bouton déclenche une soumission de formulaire implicite. Cette page contient
  // un formulaire de broker : le piège est réel, pas théorique.
  const html = readFileSync(PAGE, 'utf8');
  for (const match of html.matchAll(/<button([^>]*class="tab"[^>]*)>/g)) {
    assert.ok(match[1]?.includes('type="button"'), 'onglet sans type="button"');
  }
});

test('les onglets sont câblés avant tout chargement de données', () => {
  // Si le chargement des thermostats échoue, l'onglet du broker doit rester utilisable : les
  // deux sujets n'ont aucune raison de tomber ensemble.
  const html = readFileSync(PAGE, 'utf8');
  const wired = html.indexOf('wireTabs();');
  const loaded = html.indexOf('loadSources(');
  assert.ok(wired !== -1, 'les onglets ne sont jamais câblés');
  assert.ok(loaded === -1 || wired < loaded,
    'les données se chargent avant que les onglets ne soient utilisables');
});

test('les thermostats sont regroupés par pièce', () => {
  // À plat, retrouver un thermostat parmi dix oblige à lire le détail de chacun. Le regroupement
  // se fait sur la pièce du CAPTEUR : c'est lui qui définit le volume d'air régulé, alors qu'un
  // radiateur peut être déclaré dans une pièce voisine.
  const html = readFileSync(PAGE, 'utf8');
  assert.ok(html.includes('room-title'), 'aucun intitulé de pièce dans le rendu');
  assert.ok(/const room = thermostat\.sources\.find\(s => s\.source === 'room'\)/.test(html),
    'le regroupement ne se fait pas sur la pièce du capteur');
  assert.ok(html.includes('settings.sources.no_room'),
    'un thermostat dont le capteur n\'a pas de pièce disparaîtrait du rendu');
});
