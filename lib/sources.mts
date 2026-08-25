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
