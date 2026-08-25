/**
 * Cohérence entre les événements du noyau et les cartes Flow réellement offertes.
 *
 * PANNE EMPÊCHÉE : un événement que le noyau émet correctement, à la bonne milliseconde, et que
 * personne ne peut utiliser faute de carte déclarée. C'est exactement ce qui est arrivé à
 * `preset_changed` : le noyau le calculait depuis toujours, le driver l'ignorait, et le
 * commentaire qui justifiait cet abandon reposait sur une croyance fausse — que Homey fabrique
 * tout seul un déclencheur `_changed` pour n'importe quelle capability custom. Il ne le fait que
 * pour les identifiants à préfixe SYSTÈME (`measure_`, `meter_`, `alarm_`…) ; aucun des nôtres
 * n'en porte. Le changement de preset n'était donc déclenchable par personne, en silence, et
 * aucun test ne s'en plaignait.
 *
 * Le remède n'est pas de tester la carte du jour mais d'obliger CHAQUE nouvel événement à
 * déclarer son sort : une carte, ou un `null` assumé et motivé.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Événement du noyau → identifiant de la carte qu'il déclenche.
 *
 * `null` = délibérément sans carte, avec sa raison. Ajouter un événement à `VThermEvent` ou à
 * `CentralEvent` sans l'inscrire ici casse le premier test : c'est le but.
 */
const VTHERM_EVENT_CARDS: Record<string, string | null> = {
  preset_changed: 'preset_changed',
  /** Lisible en continu sur la capability `vtherm_state` : une carte ferait doublon. */
  state_changed: null,
  window_opened: 'window_opened',
  window_closed: 'window_closed',
  demand_started: 'demand_started',
  demand_stopped: 'demand_stopped',
  /** Le nom de la carte diffère du nom de l'événement : c'est voulu, et c'est le piège. */
  sensor_quiet: 'sensor_went_quiet',
  /** Retour à la normale d'un avertissement : il lève le bandeau, il n'annonce rien. */
  sensor_recovered: null,
};

const CENTRAL_EVENT_CARDS: Record<string, string | null> = {
  boiler_started: 'boiler_started',
  boiler_stopped: 'boiler_stopped',
  central_mode_changed: 'central_mode_changed',
};

/** Les `kind` d'une union discriminée, lus dans la SOURCE — le type lui-même s'efface à l'exécution. */
function eventKinds(relativePath: string, typeName: string): string[] {
  const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
  const start = source.indexOf(`export type ${typeName} =`);
  assert.notEqual(start, -1, `${typeName} introuvable dans ${relativePath}`);

  // L'union se termine à la première ligne vide : un `;` naïf s'arrêterait au premier séparateur
  // de champ, `{ kind: 'boiler_started'; nbActive: number }`.
  const end = source.indexOf('\n\n', start);
  assert.notEqual(end, -1, `fin de l'union ${typeName} introuvable`);

  const kinds = [...source.slice(start, end).matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1] as string);
  assert.ok(kinds.length > 0, `aucun kind lu dans ${typeName}`);
  return kinds;
}

/** Identifiants des déclencheurs déclarés pour ce driver. */
function declaredTriggers(driverId: string): string[] {
  const raw = readFileSync(join(process.cwd(), 'drivers', driverId, 'driver.flow.compose.json'), 'utf8');
  const parsed = JSON.parse(raw) as { triggers?: { id: string }[] };
  return (parsed.triggers ?? []).map((trigger) => trigger.id);
}

/**
 * Identifiants que le driver déclenche vraiment.
 *
 * Lecture du texte source : instancier un `Homey.Device` demanderait tout le SDK, et ce qu'on
 * veut vérifier ici est justement ce qui est ÉCRIT, pas ce qui s'exécute.
 */
function firedTriggers(driverId: string): string[] {
  const source = readFileSync(join(process.cwd(), 'drivers', driverId, 'device.mts'), 'utf8');
  const calls = source.matchAll(/(?:this\.trigger|getDeviceTriggerCard)\(\s*'([a-z_]+)'/g);
  return [...new Set([...calls].map((m) => m[1] as string))];
}

// --- Le test qui aurait attrapé le preset muet ------------------------------

test('tout événement du noyau a décidé de son sort : une carte, ou un null assumé', () => {
  assert.deepEqual(
    eventKinds('lib/types.mts', 'VThermEvent').sort(),
    Object.keys(VTHERM_EVENT_CARDS).sort(),
    'un événement VThermEvent a été ajouté ou retiré sans dire s\'il mérite une carte Flow',
  );
  assert.deepEqual(
    eventKinds('runtime/participants.mts', 'CentralEvent').sort(),
    Object.keys(CENTRAL_EVENT_CARDS).sort(),
    'un événement CentralEvent a été ajouté ou retiré sans dire s\'il mérite une carte Flow',
  );
});

test('toute carte promise à un événement est réellement déclarée', () => {
  for (const [driverId, mapping] of [['vtherm', VTHERM_EVENT_CARDS], ['central', CENTRAL_EVENT_CARDS]] as const) {
    const declared = declaredTriggers(driverId);
    for (const [kind, cardId] of Object.entries(mapping)) {
      if (cardId === null) continue;
      assert.ok(
        declared.includes(cardId),
        `${driverId} : l'événement ${kind} vise la carte ${cardId}, qui n'est pas déclarée`,
      );
    }
  }
});

// --- Les deux sens de la trahison manifeste/code ----------------------------

test('aucune carte déclarée ne reste orpheline, aucun déclenchement ne vise le vide', () => {
  for (const driverId of ['vtherm', 'central'] as const) {
    const declared = declaredTriggers(driverId).sort();
    const fired = firedTriggers(driverId).sort();

    // Une carte déclarée que rien ne déclenche s'affiche dans l'éditeur de Flow et ne part jamais :
    // l'utilisateur construit un Flow mort et n'a aucun moyen de le savoir.
    assert.deepEqual(declared, fired,
      `${driverId} : cartes déclarées et cartes déclenchées divergent`);
  }
});
