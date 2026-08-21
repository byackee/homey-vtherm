/**
 * Parité des traductions.
 *
 * `homey app validate --level publish` ne détecte pas une clé absente d'une seule locale : la
 * page s'affiche alors avec l'identifiant brut de la clé, en production, dans la langue de
 * l'utilisateur qui n'a pas eu de chance. Ce test est le seul garde-fou.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = join(process.cwd(), 'locales');
const REFERENCE = 'en';

function leafKeys(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'object' && child !== null) {
      for (const nested of leafKeys(child, path)) out.add(nested);
    } else {
      out.add(path);
    }
  }
  return out;
}

function load(lang: string): unknown {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), 'utf8'));
}

const languages = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -'.json'.length));

test('les trois locales existent', () => {
  for (const lang of ['en', 'fr', 'nl']) {
    assert.ok(languages.includes(lang), `locales/${lang}.json manque`);
  }
});

test('toutes les locales portent exactement les mêmes clés', () => {
  const reference = leafKeys(load(REFERENCE));
  assert.ok(reference.size > 0, 'la locale de référence est vide');

  for (const lang of languages) {
    if (lang === REFERENCE) continue;
    const current = leafKeys(load(lang));
    const missing = [...reference].filter((k) => !current.has(k));
    const extra = [...current].filter((k) => !reference.has(k));
    assert.deepEqual(missing, [], `clés absentes de ${lang}.json`);
    assert.deepEqual(extra, [], `clés en trop dans ${lang}.json (absentes de ${REFERENCE}.json)`);
  }
});

test('aucune traduction vide ou laissée en anglais par recopie', () => {
  const english = load(REFERENCE) as Record<string, unknown>;
  const flatten = (v: unknown, p = '', acc = new Map<string, string>()): Map<string, string> => {
    if (typeof v !== 'object' || v === null) return acc;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const path = p === '' ? k : `${p}.${k}`;
      if (typeof child === 'string') acc.set(path, child);
      else flatten(child, path, acc);
    }
    return acc;
  };

  const reference = flatten(english);
  for (const lang of languages) {
    if (lang === REFERENCE) continue;
    for (const [key, value] of flatten(load(lang))) {
      assert.ok(value.trim().length > 0, `${lang}.json : ${key} est vide`);
      // Un mot identique à l'anglais est souvent légitime (« Boost », « Eco »). Une phrase, non :
      // c'est une recopie oubliée, et elle se lit comme telle par l'utilisateur.
      const sameAsEnglish = reference.get(key) === value;
      const isSentence = value.trim().split(/\s+/).length >= 5;
      assert.ok(!(sameAsEnglish && isSentence),
        `${lang}.json : ${key} est une phrase identique à l'anglais — traduction oubliée ?`);
    }
  }
});
