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
