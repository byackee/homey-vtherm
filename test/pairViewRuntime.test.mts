/**
 * Exécution réelle du JavaScript des vues de pairing, sans navigateur.
 *
 * Les autres tests de vues n'inspectent que le texte du fichier. C'est insuffisant : le bug qui a
 * atteint la production — l'amorçage placé avant l'affectation de la configuration, d'où un
 * `{capability: undefined}` envoyé au driver — était parfaitement invisible à la lecture. Ici on
 * évalue le script dans un DOM minimal avec un faux `Homey`, et on regarde ce qu'il émet vraiment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Emitted { event: string; data: unknown }

interface FakeElement {
  id: string;
  className: string;
  textContent: string;
  style: { display: string };
  children: FakeElement[];
  innerHTML: string;
  onclick: (() => void) | null;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  appendChild(child: FakeElement): void;
  querySelectorAll(): FakeElement[];
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function element(id = ''): FakeElement {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  return {
    id,
    className: '',
    textContent: '',
    style: { display: '' },
    children: [],
    innerHTML: '',
    onclick: null,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    appendChild(child) { this.children.push(child); },
    querySelectorAll: () => [],
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, value); },
  };
}

/**
 * Évalue le script d'une vue et renvoie ce qu'elle a émis.
 *
 * `homeyReadyAtLoad` reproduit la course : `true` = l'objet `Homey` est déjà présent au chargement
 * (la vue démarre immédiatement), `false` = il arrive plus tard. Les deux chemins doivent produire
 * exactement le même appel — c'est précisément ce qui n'était pas le cas.
 */
function runView(
  relativePath: string,
  homeyReadyAtLoad: boolean,
  /** Ce que le faux driver répond, par événement. Vide = une liste vide, comme avant. */
  responses: Record<string, unknown> = {},
): {
  emitted: Emitted[];
  handlerInstalled: boolean;
  nodes: Map<string, FakeElement>;
} {
  const html = readFileSync(join(process.cwd(), relativePath), 'utf8');
  const match = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html);
  const source = match?.[1];
  assert.ok(source !== undefined, `aucun script trouvé dans ${relativePath}`);

  const emitted: Emitted[] = [];
  let handlerInstalled = false;
  // Les identifiants sont préfixés par le nom de la vue : les vues d'un même driver partagent un
  // seul document, et des identifiants nus se marchent dessus.
  const viewId = relativePath.split('/').pop()?.replace('.html', '') ?? '';
  const nodes = new Map<string, FakeElement>();
  for (const base of [
    'state', 'list', 'outdoor', 'window', 'motion', 'presence', 'finish', 'count', 'continue',
  ]) {
    const id = `${viewId}-${base}`;
    nodes.set(id, element(id));
  }

  const homey = {
    emit(event: string, data: unknown): Promise<unknown> {
      emitted.push({ event, data });
      // Une liste vide par défaut : la plupart des tests regardent ce qui PART, pas ce qui revient.
      // Les vues à sélection multiple, elles, ont besoin de candidats pour qu'il y ait à cliquer.
      return Promise.resolve(responses[event] ?? []);
    },
    __: (key: string) => key,
    nextView: () => { /* rien à faire ici */ },
  };

  const sandbox: Record<string, unknown> = {
    Promise,
    JSON,
    console,
    setTimeout,
    document: {
      getElementById: (id: string) => nodes.get(id) ?? null,
      querySelectorAll: () => [],
      createElement: () => element(),
      addEventListener: () => { /* DOMContentLoaded : jamais déclenché ici */ },
    },
    addEventListener: (type: string) => { if (type === 'error') handlerInstalled = true; },
  };
  sandbox.window = sandbox;
  if (homeyReadyAtLoad) sandbox.Homey = homey;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { timeout: 2000 });

  // Convention « page de réglages » : l'objet arrive après coup.
  if (!homeyReadyAtLoad) {
    const onReady = sandbox.onHomeyReady as ((h: unknown) => void) | undefined;
    assert.ok(typeof onReady === 'function', `${relativePath} n'expose pas onHomeyReady`);
    onReady(homey);
  }

  return { emitted, handlerInstalled, nodes };
}

/** Les `li` rendus dans un conteneur : la vue les crée sous un `ul`, lui-même sous la racine. */
function items(root: FakeElement | undefined): FakeElement[] {
  return root?.children[0]?.children ?? [];
}

/** `onclick` est synchrone, mais ce qu'il déclenche ne l'est pas : on laisse tourner les promesses. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Ce que chaque vue doit demander.
 *
 * Les vues du driver `vtherm` nomment une SOURCE ; c'est le driver qui sait quelles capabilities
 * cela recouvre. La vue du driver `central` n'a qu'un seul choix possible et demande directement
 * sa capability.
 */
const SINGLE_VIEWS: { path: string; field: 'source' | 'capability'; value: string }[] = [
  { path: 'drivers/vtherm/pair/pick_room_sensor.html', field: 'source', value: 'room' },
  { path: 'drivers/vtherm/pair/pick_emitter.html', field: 'source', value: 'emitter' },
  { path: 'drivers/central/pair/pick_boiler.html', field: 'capability', value: 'onoff' },
];

for (const view of SINGLE_VIEWS) {
  for (const readyAtLoad of [true, false]) {
    const when = readyAtLoad ? 'Homey deja pret' : 'Homey pret plus tard';
    test(`${view.path} demande bien ${view.value} (${when})`, () => {
      const { emitted } = runView(view.path, readyAtLoad);
      const calls = emitted.filter((e) => e.event === 'list_candidates');
      assert.equal(calls.length, 1, 'une seule demande, quel que soit le chemin de démarrage');

      const data = calls[0]?.data as Record<string, unknown> | undefined;
      // Le cœur du bug : `undefined` se sérialisait en `{}` et le driver ne voyait rien.
      assert.notEqual(data?.[view.field], undefined,
        `${view.field} undefined — la vue a démarré avant d'affecter sa configuration`);
      assert.equal(data?.[view.field], view.value);
    });
  }
}

for (const readyAtLoad of [true, false]) {
  const when = readyAtLoad ? 'Homey deja pret' : 'Homey pret plus tard';
  test(`pick_optional demande ses quatre sources (${when})`, () => {
    const { emitted } = runView('drivers/vtherm/pair/pick_optional.html', readyAtLoad);
    const asked = emitted
      .filter((e) => e.event === 'list_candidates')
      .map((e) => (e.data as { source?: unknown }).source);

    assert.equal(asked.length, 4);
    for (const source of asked) {
      assert.notEqual(source, undefined, 'un emplacement demandé sans source');
    }
    assert.deepEqual(new Set(asked),
      new Set(['outdoor', 'window', 'motion', 'presence']));
  });
}

test('une vue installe son interception d\'erreurs', () => {
  // Un plantage survenu avant l'installation du gestionnaire ne laisserait aucune trace :
  // ni dans le log de l'app, ni dans la page.
  for (const view of SINGLE_VIEWS) {
    const { handlerInstalled } = runView(view.path, true);
    assert.ok(handlerInstalled, `${view.path} n'installe pas de gestionnaire d'erreurs`);
  }
});

test('la liste se charge sans attendre la réponse au mode', () => {
  // Une première version enchaînait `start()` derrière `emit('pair_mode')`. La liste ne
  // s'affichait donc qu'après un aller-retour supplémentaire, et pas du tout si celui-ci
  // traînait — exactement la panne qu'on venait de corriger, réintroduite par le correctif
  // suivant. `runView` ne laisse passer aucune microtâche : ce qui est émis ici est ce qui
  // part de façon synchrone au démarrage.
  for (const view of SINGLE_VIEWS) {
    const { emitted } = runView(view.path, true);
    const events = emitted.map((e) => e.event);
    assert.ok(events.includes('list_candidates'),
      `${view.path} ne demande pas sa liste au démarrage — elle attend autre chose`);
  }
});

test('le mode pairing/réparation est demandé, mais ne bloque rien', () => {
  for (const view of SINGLE_VIEWS) {
    const { emitted } = runView(view.path, true);
    assert.ok(emitted.some((e) => e.event === 'pair_mode'),
      `${view.path} ne demande jamais son mode : le bouton final agira comme en pairing`);
  }
});

// --- Sélection multiple de l'émetteur ------------------------------------------
//
// Cette vue est la seule qui n'envoie RIEN au clic : elle accumule, puis pose le groupe entier
// quand l'utilisateur valide. Une vue qui émettrait à chaque clic créerait un thermostat à chaque
// radiateur coché — c'est la panne que ces tests rendent impossible.

/**
 * Le tableau émis, recopié dans CE realm.
 *
 * La vue s'exécute dans un contexte `vm` : son `Array` a un autre prototype que le nôtre, et
 * `deepStrictEqual` refuse deux tableaux de contenu identique mais de realms différents. Recopier
 * compare ce qui nous intéresse — le contenu — sans relâcher la comparaison en `deepEqual` lâche.
 */
function sent(data: unknown): unknown[] {
  return Array.isArray(data) ? Array.from(data as unknown[]) : [];
}

const DEUX_VANNES = [
  { id: 'vanne-1', name: 'Vanne fenêtre', zoneName: 'Salon' },
  { id: 'vanne-2', name: 'Vanne porte', zoneName: 'Salon' },
];

test('chaque coche envoie le groupe : le bouton « Continuer » de l\'assistant doit suffire', async () => {
  // RÉGRESSION, trouvée sur un vrai téléphone. L'assistant de Homey affiche SON PROPRE bouton
  // « Continuer » sous la vue — hors de notre portée, impossible à griser. L'utilisateur coche ses
  // vannes et presse ce bouton-là, parce que c'est le geste naturel. Tant que la vue n'envoyait
  // qu'à la validation de SON bouton, l'assistant avançait sans que rien ne soit parti, et le
  // thermostat était refusé à la création pour « aucun émetteur » — l'écran, lui, en montrait deux.
  const { emitted, nodes } = runView(
    'drivers/vtherm/pair/pick_emitter.html', true, { list_candidates: DEUX_VANNES },
  );
  await settle();

  const lignes = items(nodes.get('pick_emitter-list'));
  lignes[0]?.onclick?.();
  await settle();

  const apresUnClic = emitted.filter((e) => e.event === 'select_emitters');
  assert.equal(apresUnClic.length, 1, 'la coche doit avoir posé le groupe sans attendre');
  assert.deepEqual(sent(apresUnClic[0]?.data), ['vanne-1']);

  lignes[1]?.onclick?.();
  await settle();

  const envois = emitted.filter((e) => e.event === 'select_emitters');
  assert.equal(envois.length, 2);
  assert.deepEqual(
    sent(envois[1]?.data),
    ['vanne-1', 'vanne-2'],
    'le driver remplace la liste à chaque appel : c\'est toujours l\'écran qui fait foi',
  );
});

test('la coche n\'avance PAS toute seule : on en choisit plusieurs', async () => {
  // La page à choix unique avançait au clic. Celle-ci ne doit pas : partir sur la première vanne
  // cochée rendrait la sélection multiple inatteignable.
  const { emitted, nodes } = runView(
    'drivers/vtherm/pair/pick_emitter.html', true, { list_candidates: DEUX_VANNES },
  );
  await settle();

  items(nodes.get('pick_emitter-list'))[0]?.onclick?.();
  await settle();

  assert.equal(emitted.filter((e) => e.event === 'nextView').length, 0);
});

test('le bouton de la vue renvoie le groupe entier, dans l\'ordre des clics', async () => {
  const { emitted, nodes } = runView(
    'drivers/vtherm/pair/pick_emitter.html', true, { list_candidates: DEUX_VANNES },
  );
  await settle();

  const lignes = items(nodes.get('pick_emitter-list'));
  // Volontairement la SECONDE d'abord : l'ordre des clics fait la tête de référence du groupe,
  // et le trier par nom la ferait changer au premier renommage d'appareil.
  lignes[1]?.onclick?.();
  lignes[0]?.onclick?.();
  await settle();

  nodes.get('pick_emitter-continue')?.onclick?.();
  await settle();

  const envois = emitted.filter((e) => e.event === 'select_emitters');
  assert.deepEqual(sent(envois[envois.length - 1]?.data), ['vanne-2', 'vanne-1']);
});

test('un second clic retire la tête, et le retrait part aussi', async () => {
  const { emitted, nodes } = runView(
    'drivers/vtherm/pair/pick_emitter.html', true, { list_candidates: DEUX_VANNES },
  );
  await settle();

  const lignes = items(nodes.get('pick_emitter-list'));
  lignes[0]?.onclick?.();
  lignes[1]?.onclick?.();
  lignes[0]?.onclick?.();
  await settle();

  const envois = emitted.filter((e) => e.event === 'select_emitters');
  assert.deepEqual(
    sent(envois[envois.length - 1]?.data),
    ['vanne-2'],
    'sans envoi du retrait, une case décochée à l\'écran resterait dans le groupe du driver',
  );
});

test('valider sans aucune tête n\'envoie rien', async () => {
  const { emitted, nodes } = runView(
    'drivers/vtherm/pair/pick_emitter.html', true, { list_candidates: DEUX_VANNES },
  );
  await settle();

  nodes.get('pick_emitter-continue')?.onclick?.();
  await settle();

  assert.deepEqual(emitted.filter((e) => e.event === 'select_emitters'), []);
});
