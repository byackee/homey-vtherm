/**
 * `runtime/valveBackend.mts` — le contrat de la dorsale MQTT, vu par l'émetteur.
 *
 * Quatre propriétés de la TRVZB n'existent PAS comme capability Homey (SPEC §1.1, relevé sur
 * l'appareil réel) : `valve_opening_degree`, `valve_closing_degree`, `external_temperature_input`
 * et `temperature_sensor_select`. Les atteindre demande de publier soi-même sur
 * `<base_topic>/<friendly_name>/set`, ce que fait `runtime/mqttBackend.mts`.
 *
 * Ce fichier ne porte QUE l'interface, pour deux raisons :
 *  - l'émetteur doit fonctionner entièrement sans dorsale — sans elle il régule par consigne
 *    décalée, ce qui est le cœur publiable de l'app (règle Athom « core functionality must always
 *    work standalone ») ;
 *  - l'implémentation MQTT est écrite séparément et ne doit pas être une dépendance de compilation
 *    de la couche de régulation.
 *
 * `deviceId` est l'identifiant Homey de l'émetteur : c'est à l'implémentation de le traduire en
 * `friendly_name` Zigbee2MQTT, elle seule connaît cette correspondance.
 */

export interface ValveBackend {
  /**
   * Faux tant que le broker n'est pas joignable. Interrogé AVANT chaque écriture et non une fois
   * au démarrage : un broker qui tombe en cours de journée doit rendre la main à la régulation par
   * consigne, pas faire échouer silencieusement toutes les commandes de vanne.
   */
  readonly available: boolean;

  /**
   * `valve_opening_degree`, en % 0..100. L'implémentation publie aussi
   * `valve_closing_degree = 100 − percent` (SPEC §5.1).
   *
   * Rend VRAI seulement si le message est réellement parti vers le broker. Un `false` n'est pas
   * une erreur — c'est un renoncement propre, et l'appelant DOIT en tenir compte : croire une
   * vanne ouverte alors que rien n'est parti fait enclencher la chaudière sur un circuit fermé.
   */
  setValveOpening(deviceId: string, percent: number): Promise<boolean>;

  /** `external_temperature_input`, en °C (SPEC §5.3). Vrai si la publication est partie. */
  setExternalTemperature(deviceId: string, celsius: number): Promise<boolean>;

  /**
   * `temperature_sensor_select`. Écrit UNE SEULE FOIS à la liaison de l'émetteur
   * ([ÉCART] assumé, SPEC §5.3) : la TRVZB l'exige pour prendre en compte
   * `external_temperature_input`, sans quoi elle continue de réguler sur son propre thermomètre
   * collé au radiateur.
   */
  setTemperatureSensorSelect(deviceId: string, source: 'internal' | 'external'): Promise<boolean>;

  /** `local_temperature_calibration`, en °C, borné par le matériel à ±12,7. Vrai si parti. */
  setLocalTemperatureCalibration(deviceId: string, offsetC: number): Promise<boolean>;

  /**
   * Ferme la dorsale. Doit pouvoir être appelée sur une dorsale jamais démarrée, deux fois de
   * suite, ou pendant une reconnexion — l'app la remplace à chaque changement de réglages, et
   * une fermeture qui lève laisserait deux clients abonnés au même broker.
   */
  stop(): Promise<void>;
}

/*
 * Les bornes matérielles du TRVZB (ouverture 0-100, température externe 0-99,9, calibrage ±12,7)
 * vivaient ici ET dans `lib/mqttPayload.mts`. Deux jeux de constantes pour un seul matériel, c'est
 * une divergence qui attend son heure : on garde ceux de `lib/`, qui sont testés et que la couche
 * pure peut utiliser — `lib/` ne pouvant pas importer `runtime/` sans rompre son invariant.
 */
export {
  CALIBRATION_ABS_MAX,
  EXTERNAL_TEMPERATURE_MAX,
  EXTERNAL_TEMPERATURE_MIN,
  VALVE_OPENING_MAX,
  VALVE_OPENING_MIN,
} from '../lib/mqttPayload.mjs';
