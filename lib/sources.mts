/**
 * Les sources d'un thermostat : leurs clés de `store`, les capabilities acceptées pour chacune, et
 * les classes admises pour un émetteur.
 *
 * Ces trois tables vivent ici, dans la couche pure, et non dans `device.mts` : les tests unitaires
 * ne peuvent compiler que `lib/` et `test/` (voir `tsconfig.test.json`), et importer `device.mts`
 * y tirerait tout le SDK Homey. Tant qu'elles étaient déclarées dans le driver, la suite en
 * gardait une copie manuelle sous un commentaire « Doit rester identique » que rien ne vérifiait —
 * on pouvait donc élargir une source et laisser les tests valider l'ancienne table, en silence.
 * `device.mts` les ré-exporte, pour que rien d'autre n'ait à changer d'import.
 */

/**
 * Les six sources désignées au pairing, et la clé de `store` qui porte chacune.
 *
 * Les clés sont figées : elles voyagent de la vue de pairing jusqu'ici, et `onRepair` les réécrit
 * une par une quand un appareil Zigbee2MQTT ré-appairé a changé d'identifiant.
 */
export const SOURCE_STORE_KEYS = {
  room: 'roomId',
  emitter: 'emitterId',
  outdoor: 'outdoorId',
  window: 'windowId',
  motion: 'motionId',
  presence: 'presenceId',
} as const;

export type SourceKey = keyof typeof SOURCE_STORE_KEYS;

/**
 * Capabilities acceptées pour chaque source, par ordre de préférence.
 *
 * Plusieurs par source, et ce n'est pas de la générosité : les détecteurs de présence de
 * l'installation de référence n'exposent PAS `alarm_motion`. Les mmWave publient
 * `alarm_presence`, d'autres `alarm_occupancy`. Une seule capability codée en dur rendait ces
 * appareils introuvables au pairing — ils n'étaient même pas candidats.
 *
 * Le pairing propose exactement cette liste, et la liaison résout ensuite celle que l'appareil
 * choisi porte réellement : il n'y a qu'une vérité, ici.
 *
 * L'émetteur en accepte deux : une consigne pour les vannes et les thermostats, un `onoff` pour les
 * relais et prises commutées qui pilotent un convecteur (mode `switch`). `onoff` seul serait
 * beaucoup trop large — toutes les lampes de la maison le portent —, d'où le filtre par classe
 * d'appareil de `EMITTER_CLASSES`, côté driver.
 *
 * L'ouverture en accepte deux pour la même raison que la présence. `alarm_contact` est ce que
 * publient les capteurs d'ouverture d'aujourd'hui, et reste donc en tête : c'est aussi le repli
 * utilisé tant que le hub n'a pas répondu. Mais Homey a une capability faite pour ça depuis le
 * firmware 12.11, `alarm_open` — « vrai quand une porte/fenêtre est ouverte » —, et un capteur qui
 * la publierait n'aurait même pas été candidat au pairing. Les deux portent la même polarité :
 * `alarm_contact` vaut `true` quand le contact est rompu, `alarm_open` quand c'est ouvert. Rien à
 * inverser.
 */
export const SOURCE_CAPABILITIES: Record<SourceKey, readonly string[]> = {
  room: ['measure_temperature'],
  emitter: ['target_temperature', 'onoff'],
  outdoor: ['measure_temperature'],
  window: ['alarm_contact', 'alarm_open'],
  motion: ['alarm_motion', 'alarm_presence', 'alarm_occupancy'],
  presence: ['alarm_presence', 'alarm_occupancy', 'alarm_motion'],
};

/**
 * Classes d'appareil admises pour un émetteur, `onoff` étant devenu acceptable.
 *
 * Sur l'installation de référence, 38 appareils portent `onoff` — toutes les lampes comprises. Sans
 * ce filtre, la liste des émetteurs deviendrait un annuaire de la maison, dans lequel les quelques
 * appareils qui chauffent seraient introuvables. Seules ces quatre classes peuvent chauffer une
 * pièce : `socket` couvre les prises commutées, et `other` les relais que leur app ne classe pas.
 *
 * Une classe de trop est bien moins grave qu'une classe manquante — un émetteur absent de la liste
 * est inatteignable, alors qu'un intrus se contente d'occuper une ligne.
 */
export const EMITTER_CLASSES: readonly string[] = ['thermostat', 'heater', 'socket', 'other'];

// --- Groupe d'émetteurs ------------------------------------------------------

/**
 * Clé de `store` qui porte la liste ORDONNÉE des têtes, la première comprise.
 *
 * `emitterId` reste écrit et reste la tête n°1 : ce n'est pas une redondance oubliée, c'est ce qui
 * fait qu'une version antérieure de l'app relisant ce `store` trouve encore un émetteur et continue
 * de chauffer la pièce avec une tête, au lieu de rendre le thermostat indisponible. Un
 * rétrogradage doit dégrader, jamais éteindre.
 */
export const EMITTER_LIST_STORE_KEY = 'emitterIds';

/**
 * Nombre maximal de têtes derrière un thermostat.
 *
 * Une borne, parce que chaque tête est un appareil de plus écrit à CHAQUE pas : le quota de l'API
 * Athom est réel et se déclenche en production (voir la déduplication de `lib/step.mts`). Huit
 * couvre très largement une pièce réelle — au-delà, ce n'est plus une pièce, c'est un circuit qui
 * demande son propre thermostat.
 */
export const MAX_EMITTERS = 8;

/**
 * La liste des têtes telle qu'elle doit être lue d'un `store`, quelle que soit son ancienneté.
 *
 * Défensive de bout en bout, pour la même raison que `migratePersistentState` : une entrée
 * illisible qui arriverait jusqu'aux liaisons ferait un adaptateur lié à `undefined`, c'est-à-dire
 * une tête qui n'écrit jamais et ne le dit pas. Tout ce qui n'est pas une chaîne non vide est
 * écarté, les doublons aussi — la même vanne deux fois recevrait deux écritures par pas, pour rien.
 *
 * Ordre de vérité : la liste si elle est exploitable, `emitterId` seul sinon. Un `store` d'avant
 * cette version n'a que le second, et doit rendre exactement une tête.
 */
export function readEmitterIds(store: Readonly<Record<string, unknown>>): string[] {
  const raw = store[EMITTER_LIST_STORE_KEY];
  const listed = Array.isArray(raw) ? raw : [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    if (typeof entry !== 'string' || entry === '') continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length === MAX_EMITTERS) break;
  }

  if (out.length > 0) return out;

  const primary = store[SOURCE_STORE_KEYS.emitter];
  return typeof primary === 'string' && primary !== '' ? [primary] : [];
}

/**
 * Les deux champs à écrire pour une liste de têtes, toujours ensemble.
 *
 * Les écrire séparément est le seul moyen de les désynchroniser, et un `emitterId` qui ne serait
 * plus `emitterIds[0]` ferait diverger la lecture d'une version antérieure de celle d'aujourd'hui —
 * deux apps qui chauffent la même pièce par deux vannes différentes.
 */
export function emitterStorePatch(
  ids: readonly string[],
): Record<string, string | string[] | null> {
  const kept = readEmitterIds({ [EMITTER_LIST_STORE_KEY]: [...ids] });
  return {
    [SOURCE_STORE_KEYS.emitter]: kept[0] ?? null,
    [EMITTER_LIST_STORE_KEY]: kept.length > 0 ? kept : null,
  };
}

/**
 * Le minimum qu'il faut savoir d'un appareil pour décider des tuiles d'un thermostat.
 *
 * Structurellement compatible avec `DeviceSummary` de `runtime/hub.mts`, sans en dépendre : la
 * couche pure ne peut pas importer le runtime, et cette décision doit rester testable.
 */
export interface EmitterProbe {
  capabilities: readonly string[];
  setable: Readonly<Record<string, boolean>>;
}

/** Vrai si cet appareil porte une consigne inscriptible — donc s'il peut avoir une ouverture. */
export function hasWritableSetpoint(probe: EmitterProbe): boolean {
  return probe.capabilities.some(
    (id) => (id === 'target_temperature' || id.startsWith('target_temperature.'))
      && probe.setable[id] === true,
  );
}

/** Vrai si cet appareil rapporte une pile. */
export function hasBattery(probe: EmitterProbe): boolean {
  return probe.capabilities.some(
    (id) => id === 'measure_battery' || id.startsWith('measure_battery.'),
  );
}

/**
 * Les capabilities que le groupe rend nécessaires, en plus du socle.
 *
 * Un OU sur les têtes, dans les deux cas, et pour la même raison : une seule vanne à pile suffit à
 * rendre la tuile de pile utile, une seule tête à consigne suffit à rendre l'ouverture affichable.
 * Une intersection masquerait une information vraie parce qu'une autre tête ne la porte pas.
 *
 * Une sonde `null` — le hub n'a pas répondu — compte comme une tête à consigne SANS pile : c'est le
 * repli historique, et c'est le bon sens des deux côtés. Supposer une pile ferait apparaître une
 * tuile perpétuellement vide sur un radiateur branché au secteur ; supposer l'absence de consigne
 * priverait d'ouverture une vanne parfaitement pilotable.
 */
export function emitterExtraCapabilities(
  probes: ReadonlyArray<EmitterProbe | null>,
): string[] {
  const out: string[] = [];
  if (probes.some((p) => p !== null && hasBattery(p))) out.push('vtherm_emitter_battery');
  if (probes.some((p) => p === null || hasWritableSetpoint(p))) out.push('vtherm_valve_open');
  return out;
}

/**
 * Vrai quand toutes les têtes se pilotent de la même façon.
 *
 * `lib/step.mts` choisit une branche ENTIÈRE sur `emitterMode` : découpage temporel d'un côté,
 * pilotage d'ouverture de l'autre. Un groupe mixte n'a donc pas de comportement correct à offrir —
 * il en aurait un par tête, et le noyau n'en connaît qu'un. La tête qui n'est pas du mode du groupe
 * se retrouve écartée des écritures et reste figée sur sa dernière position, sans un mot.
 *
 * Une sonde `null` — le hub n'a pas répondu — compte comme COMPATIBLE avec n'importe quoi. Refuser
 * sur une ignorance rendrait un groupe impossible à former ou à modifier pendant la minute qui suit
 * le démarrage de l'app, alors que l'appareil visé est peut-être parfaitement conforme.
 *
 * Ici, dans la couche pure, parce que trois chemins y mènent — la création, la réparation et la
 * page de réglages — et qu'une règle recopiée trois fois est une règle qui finira par diverger.
 */
export function isHomogeneous(probes: ReadonlyArray<EmitterProbe | null>): boolean {
  const known = probes.filter((p): p is EmitterProbe => p !== null).map(hasWritableSetpoint);
  return known.every((value) => value === known[0]);
}
