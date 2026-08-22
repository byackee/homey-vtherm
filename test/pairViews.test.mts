/**
 * Garde-fou sur les vues de pairing.
 *
 * Une vue de pairing cassée est invisible partout ailleurs : `npm test` ne l'exécute pas,
 * `homey app validate` ne lit pas son JavaScript, et une app installée par CLI n'a pas de log.
 * Le symptôme est une page blanche, sans message, sur l'appareil de l'utilisateur — c'est
 * exactement ainsi que la première version est arrivée en production.
 *
 * Ces tests vérifient ce qui peut l'être sans navigateur : les clés de traduction existent, les
 * vues déclarées existent, et chaque vue conserve les trois garde-fous qui l'empêchent de rester
 * muette.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DRIVERS = join(ROOT, 'drivers');

function leafKeys(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'object' && child !== null) leafKeys(child, path, out);
    else out.add(path);
  }
  return out;
}

const KNOWN_KEYS = leafKeys(JSON.parse(readFileSync(join(ROOT, 'locales/en.json'), 'utf8')));

const driverIds = readdirSync(DRIVERS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

interface View { driverId: string; viewId: string; path: string; html: string }

const views: View[] = [];
for (const driverId of driverIds) {
  const dir = join(DRIVERS, driverId, 'pair');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const path = join(dir, file);
    views.push({
      driverId,
      viewId: file.slice(0, -'.html'.length),
      path,
      html: readFileSync(path, 'utf8'),
    });
  }
}

test('des vues de pairing existent', () => {
  assert.ok(views.length > 0, 'aucune vue trouvée sous drivers/*/pair/');
});

test('chaque vue déclarée dans un driver.compose.json a bien son fichier', () => {
  for (const driverId of driverIds) {
    const composePath = join(DRIVERS, driverId, 'driver.compose.json');
    if (!existsSync(composePath)) continue;
    const compose = JSON.parse(readFileSync(composePath, 'utf8')) as {
      pair?: { id: string; template?: string }[];
      repair?: { id: string; template?: string }[];
    };
    for (const step of [...(compose.pair ?? []), ...(compose.repair ?? [])]) {
      if (step.template !== undefined) continue; // template système, fourni par Homey
      const file = join(DRIVERS, driverId, 'pair', `${step.id}.html`);
      assert.ok(existsSync(file), `${driverId} déclare la vue « ${step.id} » sans fichier ${file}`);
    }
  }
});

test('toutes les clés de traduction utilisées par les vues existent', () => {
  // `data-i18n="clé"` et `label('clé', 'repli')` — les deux voies utilisées par les vues.
  const patterns = [/data-i18n="([^"]+)"/g, /label\('([^']+)'/g];
  for (const view of views) {
    for (const pattern of patterns) {
      for (const match of view.html.matchAll(pattern)) {
        const key = match[1];
        assert.ok(key !== undefined && KNOWN_KEYS.has(key),
          `${view.driverId}/${view.viewId}.html référence la clé inexistante « ${key} »`);
      }
    }
  }
});

test('aucune vue ne dépend uniquement de onHomeyReady', () => {
  // C'est LA cause de la panne de production : `onHomeyReady` est la convention des pages de
  // réglages. Dans une vue de pairing il n'est jamais appelé, donc rien ne se rend et la page
  // reste blanche. Une vue doit savoir démarrer avec le `Homey` déjà présent.
  for (const view of views) {
    assert.ok(view.html.includes("typeof Homey !== 'undefined'"),
      `${view.driverId}/${view.viewId}.html ne démarre pas sans onHomeyReady`);
  }
});

test('chaque vue peut afficher une erreur au lieu de rester blanche', () => {
  for (const view of views) {
    assert.ok(view.html.includes(`id="${view.viewId}-state"`),
      `${view.driverId}/${view.viewId}.html n'a pas de zone d'état`);
    assert.ok(view.html.includes('function showError'),
      `${view.driverId}/${view.viewId}.html ne sait pas afficher une erreur`);
    assert.ok(view.html.includes("addEventListener('error'"),
      `${view.driverId}/${view.viewId}.html n'intercepte pas les erreurs JavaScript`);
  }
});

test('chaque vue renvoie ses erreurs à l\'app', () => {
  // Sans ça, une erreur de vue ne laisse aucune trace côté app, et l'app installée par CLI
  // n'a pas de log : le diagnostic devient impossible à distance.
  for (const view of views) {
    assert.ok(view.html.includes("'viewLog'"),
      `${view.driverId}/${view.viewId}.html ne renvoie pas ses erreurs à l'app`);
  }
});

test('aucune vue n\'appelle setNavigationNext', () => {
  // Cette méthode n'existe pas dans l'objet Homey d'une vue de pairing : absente de la
  // documentation officielle, des mocks communautaires et de toutes les apps publiées
  // inspectées. L'appeler lève une TypeError qui interrompt le script et vide la page.
  // La mentionner en commentaire est en revanche utile — d'où la recherche sur l'APPEL.
  for (const view of views) {
    for (const call of ['H.setNavigationNext(', 'Homey.setNavigationNext(']) {
      assert.ok(!view.html.includes(call),
        `${view.driverId}/${view.viewId}.html appelle ${call} — cette méthode n'existe pas`);
    }
  }
});

test('les appels de navigation réels sont protégés', () => {
  // `nextView` existe, mais une vue peut être servie par une version qui ne l'expose pas :
  // une méthode absente vide la page sans message.
  for (const view of views) {
    if (!view.html.includes('H.nextView(')) continue;
    assert.ok(view.html.includes("typeof H.nextView === 'function'"),
      `${view.driverId}/${view.viewId}.html appelle nextView sans vérifier son existence`);
  }
});

test('la configuration de la vue est affectée avant tout démarrage', () => {
  // Le second bug de production : l'amorçage se trouvait AVANT `var VIEW = {...}`. La
  // déclaration est remontée par JavaScript, pas l'affectation — `start()` lisait donc
  // `undefined` et envoyait `{capability: undefined}`, que le driver recevait comme `{}`.
  // Le bug ne se manifestait que lorsque `Homey` était déjà prêt : une course.
  for (const view of views) {
    const assigned = view.html.indexOf('var VIEW =');
    const booted = view.html.indexOf('boot(Homey)');
    assert.ok(assigned !== -1, `${view.driverId}/${view.viewId}.html ne déclare pas VIEW`);
    assert.ok(booted !== -1, `${view.driverId}/${view.viewId}.html ne démarre jamais`);
    assert.ok(assigned < booted,
      `${view.driverId}/${view.viewId}.html démarre avant d'avoir affecté sa configuration`);
  }
});

test('aucun assistant ne navigue d\'une vue custom vers le template add_devices', () => {
  // Sur Homey Pro 2023, ce passage ferme l'assistant SANS créer l'appareil. Constaté en
  // production : l'utilisateur choisissait son relais de chaudière et la page se refermait,
  // sans device et sans message. Les vues créent donc l'appareil elles-mêmes.
  for (const driverId of driverIds) {
    const composePath = join(DRIVERS, driverId, 'driver.compose.json');
    if (!existsSync(composePath)) continue;
    const compose = JSON.parse(readFileSync(composePath, 'utf8')) as {
      pair?: { id: string; template?: string }[];
    };
    const templates = (compose.pair ?? []).filter((v) => v.template !== undefined);
    assert.deepEqual(templates, [],
      `${driverId} enchaîne encore sur un template système : ${templates.map((t) => t.template).join(', ')}`);
  }
});

test('chaque driver a exactement une vue qui crée l\'appareil', () => {
  for (const driverId of driverIds) {
    const own = views.filter((v) => v.driverId === driverId);
    if (own.length === 0) continue;
    const creators = own.filter((v) => v.html.includes('H.createDevice('));
    assert.equal(creators.length, 1,
      `${driverId} a ${creators.length} vue(s) créatrice(s) au lieu d'une`);
  }
});

test('tout bouton porte type="button"', () => {
  // Sans lui, un bouton déclenche une soumission de formulaire implicite qui interfère avec la
  // navigation du pairing et vide la page — panne documentée sur le forum Homey.
  for (const view of views) {
    for (const match of view.html.matchAll(/<button([^>]*)>/g)) {
      assert.ok(match[1]?.includes('type="button"'),
        `${view.driverId}/${view.viewId}.html a un <button> sans type="button"`);
    }
  }
});

test('deux vues d\'un même driver ne partagent aucun identifiant d\'élément', () => {
  // Homey charge toutes les vues de pairing d'un driver dans UN SEUL document. Des identifiants
  // nus s'y télescopent : `getElementById('list')` renvoie le premier du document, donc celui de
  // la première vue. Constaté en production — la page « Qu'est-ce qui chauffe cette pièce ? »
  // recevait bien les cinq vannes et remplissait consciencieusement la liste de sa voisine,
  // restée cachée, en laissant la sienne vide.
  const seen = new Map<string, string>();
  for (const view of views) {
    for (const match of view.html.matchAll(/id="([^"]+)"/g)) {
      const id = match[1];
      if (id === undefined) continue;
      const key = `${view.driverId}::${id}`;
      const owner = seen.get(key);
      assert.equal(owner, undefined,
        `l'identifiant « ${id} » est utilisé par ${owner} ET ${view.viewId} du driver ${view.driverId}`);
      seen.set(key, view.viewId);
    }
  }
});

test('chaque identifiant est préfixé par le nom de sa vue', () => {
  // La règle qui rend la précédente vraie par construction plutôt que par vigilance.
  for (const view of views) {
    for (const match of view.html.matchAll(/id="([^"]+)"/g)) {
      const id = match[1] ?? '';
      assert.ok(id.startsWith(`${view.viewId}-`),
        `${view.driverId}/${view.viewId}.html : l'identifiant « ${id} » n'est pas préfixé`);
    }
  }
});

test('le script de chaque vue est encapsulé', () => {
  // Les vues d'un même driver partagent le document ET la portée globale. Sans encapsulation,
  // treize fonctions de mêmes noms, `VIEW`, `H` et `MODE` se télescopent d'une vue à l'autre.
  for (const view of views) {
    assert.ok(view.html.includes('(function () {'),
      `${view.driverId}/${view.viewId}.html laisse ses fonctions au global`);
  }
});

test('onHomeyReady est chaîné, jamais écrasé', () => {
  // La portée étant partagée, une affectation nue ferait perdre le rappel des vues précédentes.
  for (const view of views) {
    assert.ok(!view.html.includes('window.onHomeyReady = function (homey) { boot(homey); };'),
      `${view.driverId}/${view.viewId}.html écrase onHomeyReady au lieu de le chaîner`);
    assert.ok(view.html.includes('previousReady'),
      `${view.driverId}/${view.viewId}.html ne chaîne pas onHomeyReady`);
  }
});

test('rien ne lit MODE avant que la réponse au mode soit arrivée', () => {
  // `emit('pair_mode')` est un aller-retour. Tout ce qui dépend du mode doit être câblé dans sa
  // continuation, jamais dans `start()`, qui s'exécute dans le même tour de boucle — sinon la
  // branche réparation est du code mort et l'assistant échoue au dernier clic.
  for (const view of views) {
    const start = view.html.indexOf('function start()');
    if (start === -1) continue;
    const end = view.html.indexOf('\n    }', start);
    const body = view.html.slice(start, end === -1 ? undefined : end);
    assert.ok(!body.includes('MODE'),
      `${view.driverId}/${view.viewId}.html lit MODE dans start(), avant que la réponse arrive`);
  }
});

test('chaque vue déclare son préfixe et ne cible que ses propres éléments', () => {
  // La page d'édition des sources visait `pick_optional-state` : son socle avait été recopié
  // depuis cette vue. En réparation, ni les erreurs ni les confirmations ne s'affichaient, et
  // le « … » de chargement ne partait jamais. Le test précédent ne l'attrapait pas — il
  // vérifiait que le div existe, pas que le script le vise.
  for (const view of views) {
    assert.ok(view.html.includes(`var PREFIX = '${view.viewId}-';`),
      `${view.driverId}/${view.viewId}.html ne déclare pas son préfixe`);
    for (const match of view.html.matchAll(/getElementById\('([^']+)'/g)) {
      assert.fail(
        `${view.driverId}/${view.viewId}.html cible « ${match[1]} » en dur au lieu de passer par PREFIX`);
    }
  }
});
