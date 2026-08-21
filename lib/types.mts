/**
 * Contrat du cœur algorithmique.
 *
 * Règle absolue de ce fichier et de tous les modules qui l'importent : AUCUNE référence à Homey.
 * Les fonctions du cœur sont pures — elles reçoivent un état, retournent le suivant, et ne lisent
 * jamais l'horloge elles-mêmes (`nowMs` est toujours un paramètre). C'est ce qui les rend testables
 * sans Homey et sans attendre.
 */

/**
 * `activity` représente le preset Activité (SPEC §7) : il n'a pas de température propre, sa
 * consigne dépend du mouvement (voir presetResolver.mts). Ajout additif au contrat pour ce point
 * précis — autorisé explicitement, le reste de ce fichier reste inchangé.
 */
export type Preset = 'frost' | 'eco' | 'comfort' | 'boost' | 'none' | 'activity';

/** État effectif affiché, distinct du preset choisi (voir SPEC §2.3). */
export type EffectiveState =
  | 'off' | 'idle' | 'heating' | 'window' | 'away' | 'activity'
  | 'central' | 'safety' | 'power';

export type CentralMode = 'auto' | 'stopped' | 'heat_only' | 'frost';

export type WindowMode = 'off' | 'sensor' | 'auto';
export type WindowAction = 'turn_off' | 'frost' | 'eco' | 'fan_only';

export type RegulationMode = 'none' | 'slow' | 'light' | 'medium' | 'strong' | 'expert';

/** Comment on parle à l'émetteur : ouverture de vanne pilotée, ou consigne décalée. */
export type EmitterMode = 'valve' | 'setpoint';

/** Synchronisation du capteur de pièce vers l'émetteur (SPEC §5.3). */
export type SyncMode = 'off' | 'external' | 'calibration';

// ---------------------------------------------------------------------------
// TPI (SPEC §4)
// ---------------------------------------------------------------------------

export interface TpiParams {
  coefInt: number;
  coefExt: number;
  /**
   * Dépassement toléré **quand la température monte**. 0 = seuils désactivés.
   * Ce n'est PAS un seuil d'hystérésis : voir `computeOnPercent` et SPEC §4.
   */
  thresholdHigh: number;
  /** Dépassement toléré **quand la température descend**. 0 = seuils désactivés. */
  thresholdLow: number;
}

export interface TpiInput {
  setpoint: number;
  roomTemp: number;
  /** `null` quand aucun capteur extérieur n'est configuré : le terme externe vaut alors 0. */
  outdoorTemp: number | null;
  /**
   * Pente de température en °C/h, `null` tant qu'elle n'est pas calculable.
   * Entrée **obligatoire** : chez VT (`prop_algo_tpi.py`) les seuils haut/bas dépendent du SIGNE
   * de la pente. Sans elle, les seuils n'ont aucun effet — ce n'est pas un raffinement optionnel.
   */
  slopePerHour: number | null;
}

/**
 * Le TPI est **sans état** : VT ne conserve aucun verrou entre deux pas. Une première rédaction
 * avait inventé un `TpiState { cutOff }` d'hystérésis qui n'existe nulle part dans VT.
 */
export interface TpiResult {
  onPercent: number;
}

/**
 * Passage de `on_percent` à l'ouverture de vanne (SPEC §4.1, `opening_degree_algorithm.py`).
 *
 * Attention aux unités, elles diffèrent d'un champ à l'autre — c'est ainsi chez VT :
 * `openingThreshold` est sur l'échelle de `on_percent` (fraction 0..1), les trois degrés sont
 * des pourcentages 0..100. C'est ce qui fait que `on_percent = 1` rend exactement
 * `maxOpeningDegree`.
 */
export interface OpeningDegreeParams {
  /** Fraction 0..1, même échelle que `onPercent`. En dessous, la vanne est fermée. */
  openingThreshold: number;
  /** En %, 0..100. Ouverture minimale quand la chauffe démarre. */
  minOpeningDegree: number;
  /** En %, 0..100. */
  maxOpeningDegree: number;
  /** En %, 0..100. Sous le seuil, l'ouverture vaut `100 − maxClosingDegree`, et non zéro. */
  maxClosingDegree: number;
}

// ---------------------------------------------------------------------------
// Auto-régulation par offset de consigne (SPEC §5.2)
// ---------------------------------------------------------------------------

export interface RegulationParams {
  kp: number;
  ki: number;
  kExt: number;
  offsetMax: number;
  accumulatedErrorThreshold: number;
  overheatProtection: boolean;
}

export interface RegulationInput {
  setpoint: number;
  roomTemp: number;
  /** `null` ⇒ VT saute **entièrement** l'auto-régulation (voir `computeOffset`). */
  outdoorTemp: number | null;
  /**
   * Intervalle écoulé depuis le pas précédent, **exprimé en cycles** (1 = un cycle complet).
   * VT pondère l'accumulation par cette durée (`accumulated_error += error * time_delta`) :
   * sans ça, un pas déclenché hors cycle (changement de consigne, nouvelle mesure) pèserait
   * autant qu'un cycle complet et l'intégrale s'emballerait.
   */
  dtCycles: number;
}

export interface RegulationState {
  accumulatedError: number;
  /** Signe de l'erreur au pas précédent : -1, 0 ou 1. Sert à la protection surchauffe. */
  lastErrorSign: -1 | 0 | 1;
}

export interface RegulationResult {
  offset: number;
  nextState: RegulationState;
}

// ---------------------------------------------------------------------------
// Pente de température (SPEC §6.2)
// ---------------------------------------------------------------------------

/**
 * Lissage de la pente chez VT (`open_window_algorithm.py`) : `pente = 0,2 × précédente + 0,8 × instantanée`,
 * arrondi à 2 décimales. Ce n'est **pas** une EMA à demi-vie — les `max_alpha`/`halflife` qu'une
 * première rédaction avait repris pilotent chez VT une *température* lissée, pas une pente.
 */
export interface SlopeParams {
  /** Poids de la pente instantanée dans le lissage. VT : 0,8. */
  alpha: number;
  /** Décimales conservées. VT : 2. */
  precision: number;
  /** Nombre minimal de mesures avant de publier une pente. VT : 4. */
  minSamples: number;
  /** Au-delà, en valeur absolue et en °C/h, la mesure est jugée aberrante et ignorée. VT : 120. */
  maxAbsSlopePerHour: number;
  /** Silence au-delà duquel un point fictif est injecté, en secondes. VT : 1800 (30 min). */
  staleAfterSec: number;
}

export interface SlopeState {
  /** Pente lissée courante, déjà arrondie. `null` tant qu'aucune pente n'a pu être calculée. */
  slope: number | null;
  lastMs: number | null;
  /** Dernière température vue, nécessaire pour calculer la pente instantanée du pas suivant. */
  lastTemp: number | null;
  /** Mesures retenues, plafonné à `minSamples` : au-delà, l'information n'a plus d'usage. */
  sampleCount: number;
}

export interface SlopeResult {
  /** °C par heure. `null` tant que la garde des `minSamples` points n'est pas franchie. */
  slopePerHour: number | null;
  nextState: SlopeState;
}

// ---------------------------------------------------------------------------
// Détection d'ouverture (SPEC §6)
// ---------------------------------------------------------------------------

export interface WindowParams {
  mode: WindowMode;
  /** Délai de confirmation d'**ouverture** (`window_delay` chez VT). */
  delaySec: number;
  /**
   * Délai de confirmation de **fermeture** (`window_off_delay` chez VT).
   * Réglage distinct : VT n'a jamais eu de délai symétrique, contrairement à ce qu'une première
   * rédaction supposait. On peut vouloir couper vite et restaurer lentement, ou l'inverse.
   */
  offDelaySec: number;
  action: WindowAction;
  autoOpenThreshold: number;
  autoCloseThreshold: number;
  autoMaxDurationSec: number;
}

export interface WindowInput {
  /** État du capteur, `null` si aucun capteur n'est lié. */
  sensorOpen: boolean | null;
  slopePerHour: number | null;
  /** Action Flow « ignorer la fenêtre » : la détection est neutralisée. */
  bypass: boolean;
}

export type WindowPhase = 'closed' | 'pending_open' | 'open' | 'pending_close';

export interface WindowState {
  phase: WindowPhase;
  /** Début de la phase courante, pour les délais de confirmation. */
  phaseSinceMs: number | null;
  /** Début de la détection effective, pour la durée maximale du mode auto. */
  openSinceMs: number | null;
}

export interface WindowResult {
  /** Vrai quand la détection est confirmée et doit primer sur le preset. */
  active: boolean;
  action: WindowAction | null;
  nextState: WindowState;
}

// ---------------------------------------------------------------------------
// Presets, présence, mouvement (SPEC §7-8)
// ---------------------------------------------------------------------------

export interface PresetTemps {
  frost: number;
  eco: number;
  comfort: number;
  boost: number;
}

/** Températures appliquées en cas d'absence. Le hors-gel n'en a pas : il est déjà minimal. */
export interface AwayTemps {
  eco: number;
  comfort: number;
  boost: number;
}

export interface MotionConfig {
  /** Faux si l'un des quatre réglages manque : le preset Activité n'est alors pas proposé. */
  enabled: boolean;
  motionPreset: Exclude<Preset, 'none'>;
  noMotionPreset: Exclude<Preset, 'none'>;
  delaySec: number;
  offDelaySec: number;
}

export interface MotionState {
  /** Dernier état brut du capteur. */
  raw: boolean;
  /** État confirmé après temporisation. */
  confirmed: boolean;
  pendingSinceMs: number | null;
}

export interface TimedPreset {
  preset: Preset;
  untilMs: number;
  /** Preset à restaurer à l'échéance. */
  previous: Preset;
}

export interface PresetInput {
  preset: Preset;
  /** Consigne libre, utilisée quand le preset vaut `none`. */
  manualSetpoint: number;
  presetTemps: PresetTemps;
  awayTemps: AwayTemps;
  /** `null` quand aucun capteur de présence n'est configuré. */
  presence: boolean | null;
  motion: MotionConfig;
  motionState: MotionState;
  timedPreset: TimedPreset | null;
}

export interface PresetResult {
  setpoint: number;
  /** Preset réellement utilisé pour le calcul, après preset temporisé et Activité. */
  effectivePreset: Preset;
  away: boolean;
  activity: boolean;
  /** Vrai si le preset temporisé vient d'expirer : l'appelant doit le purger et restaurer. */
  timedExpired: boolean;
}

// ---------------------------------------------------------------------------
// Chaudière centrale (SPEC §9.2)
// ---------------------------------------------------------------------------

export interface BoilerParams {
  /** Nombre d'émetteurs en demande à partir duquel on allume. */
  threshold: number;
  activationDelaySec: number;
  /**
   * Délai minimal avant tout nouvel **ALLUMAGE**. Jamais nul — garde-fou anti-pulsation.
   * Ne s'applique JAMAIS à l'extinction : voir `stepBoiler` et SPEC §9.2.
   */
  minDwellSec: number;
  /** 0 = désactivé. */
  keepAliveSec: number;
}

export interface BoilerState {
  commanded: boolean;
  lastChangeMs: number | null;
  /** Début de l'attente du délai d'activation. */
  pendingSinceMs: number | null;
  lastKeepAliveMs: number | null;
  /**
   * Faux tant que l'état commandé n'a pas été réellement écrit sur le relais depuis le démarrage.
   *
   * Sans ce drapeau, un état restauré depuis le `store` est considéré comme déjà appliqué, et
   * `stepBoiler` ne renvoie aucune commande : si quelqu'un a basculé le relais à la main pendant
   * que l'app était arrêtée, l'écart n'est jamais rattrapé. Remettre ce champ à `false` à la
   * relecture force une réaffirmation au premier pas.
   */
  affirmed: boolean;
}

export interface BoilerResult {
  /** `true`/`false` = commuter, `null` = ne rien écrire à ce tick. */
  command: boolean | null;
  /** Vrai quand l'écriture est un simple rappel périodique, pas un changement d'état. */
  keepAlive: boolean;
  /**
   * Vrai quand l'écriture ne fait que remettre le relais en accord avec l'état déjà commandé,
   * au démarrage de l'app. L'appelant doit l'écrire, mais ne doit PAS déclencher de carte Flow.
   */
  affirmation: boolean;
  nextState: BoilerState;
}

// ---------------------------------------------------------------------------
// Lecture de capteur horodatée (PLAN, principe directeur n°3)
// ---------------------------------------------------------------------------

/**
 * Une mesure n'est jamais un nombre nu. C'est le TYPE qui force à traiter le capteur muet,
 * au lieu de le découvrir un jour de gel : impossible de lire `.value` sans avoir vu `.stale`.
 */
export interface Reading<T> {
  value: T;
  atMs: number;
  stale: boolean;
}

// ---------------------------------------------------------------------------
// État agrégé d'un VTherm (SPEC §11)
// ---------------------------------------------------------------------------

/** État mémorisé juste avant l'application d'une action fenêtre, pour la restauration. */
export interface WindowMemento {
  onoff: boolean;
  preset: Preset;
  setpoint: number;
}

/**
 * Ce qui doit survivre à un redémarrage de l'app (`store` du device).
 *
 * `version` n'est pas décoratif : sans lui, un champ absent après mise à jour devient `undefined`,
 * puis `NaN` au premier calcul, puis une capability morte pour toute la durée de vie de l'app.
 */
export interface VThermPersistentState {
  readonly version: 1;
  preset: Preset;
  manualSetpoint: number;
  timedPreset: TimedPreset | null;
  window: WindowState;
  windowMemento: WindowMemento | null;
  regulation: RegulationState;
  /** Instant du dernier pas exécuté. Sert à la règle SPEC §11 « arrêt > 1 h ⇒ RAZ de l'intégrale ». */
  lastRunAtMs: number;
}

/**
 * Dernières valeurs réellement parties vers l'émetteur.
 * Nommé `VThermLastWrite` pour ne pas entrer en collision avec le `LastWrite` par capability
 * de `writePolicy.mts`, qui porte une valeur unique et non un couple.
 */
export interface VThermLastWrite {
  valvePercent: number | null;
  setpoint: number | null;
  atMs: number;
}

/**
 * Dernières valeurs publiées, base de comparaison des déclencheurs Flow.
 * `null` = jamais publié : au tout premier pas après un démarrage, aucun événement ne part.
 * Sans ce `null`, chaque redémarrage d'app tirerait une rafale de Flows fantômes.
 */
export interface PublishedSnapshot {
  stateLabel: EffectiveState | null;
  preset: Preset | null;
  windowOpen: boolean | null;
  demandActive: boolean | null;
  sensorQuiet: boolean | null;
}

/** Ce qui se reconstruit en quelques cycles et n'a donc rien à faire dans le `store`. */
export interface VThermVolatileState {
  slope: SlopeState;
  motion: MotionState;
  lastWrite: VThermLastWrite;
  lastPublished: PublishedSnapshot;
}

export interface VThermState {
  persistent: VThermPersistentState;
  volatile: VThermVolatileState;
}

/** Ce que la migration ne peut pas deviner et qui vient des réglages du device. */
export interface VThermStateDefaults {
  preset: Preset;
  manualSetpoint: number;
}

// ---------------------------------------------------------------------------
// Étiquette d'état effectif (SPEC §2.3)
// ---------------------------------------------------------------------------

/**
 * Entrées de la table de priorité de `vtherm_state`.
 * `roomSensorMute` et `overpowered` n'ont pas d'usage en v1 : ils sont déjà là pour que l'ajout
 * de `safety` et `power` en v1.1 soit l'édition d'UNE ligne de la table (SPEC §12).
 */
export interface StateContext {
  onoff: boolean;
  /** Mode central non-`auto` ET respecté par ce device (`use_central_mode`). */
  centralOverride: boolean;
  windowActive: boolean;
  roomSensorMute: boolean;
  overpowered: boolean;
  away: boolean;
  activity: boolean;
  /** Demande de chaleur en cours. */
  heating: boolean;
}

// ---------------------------------------------------------------------------
// Réducteur racine (PLAN, lot 1bis)
// ---------------------------------------------------------------------------

/** Réglages du device, constants sur la durée d'un pas. */
export interface VThermConfig {
  tpi: TpiParams;
  slope: SlopeParams;
  window: WindowParams;
  presetTemps: PresetTemps;
  awayTemps: AwayTemps;
  motion: MotionConfig;
  regulationMode: RegulationMode;
  expertRegulation: RegulationParams;
  /** Ouverture minimale quand la chauffe démarre, en %. Ne s'applique pas à `on_percent` nul. */
  minOpeningDegree: number;
  maxOpeningDegree: number;
  /** Ouverture commandée sous le seuil : `100 − maxClosingDegree`, et non zéro (SPEC §4.1). */
  maxClosingDegree: number;
  /** Fraction 0..1 sur l'échelle de `on_percent`. En dessous, la vanne est considérée fermée. */
  openingThreshold: number;
  /** Variation minimale, en points de %, pour réécrire la vanne. */
  regulationThreshold: number;
  /** Variation minimale d'offset, en °C, pour réécrire la consigne. */
  autoRegulationDtemp: number;
  autoRegulationPeriodMin: number;
  /**
   * Période nominale de recalcul, en minutes. Le noyau n'en fait PAS une horloge : elle sert
   * uniquement d'unité pour pondérer l'accumulation de l'auto-régulation (`dtCycles`), afin qu'un
   * pas déclenché hors cycle ne pèse pas autant qu'un cycle complet.
   */
  cycleMin: number;
  /** SPEC §9.1 : un device peut refuser d'obéir au mode central. */
  useCentralMode: boolean;
}

/** Instantané du monde à l'instant T. Aucune de ces valeurs n'est lue par le noyau lui-même. */
export interface VThermInputs {
  roomTemp: Reading<number> | null;
  outdoorTemp: Reading<number> | null;
  windowContact: Reading<boolean> | null;
  motion: Reading<boolean> | null;
  presence: Reading<boolean> | null;
  emitterHeating: Reading<boolean> | null;
  /** Décidé par le groupe d'émetteurs : `valve` seulement si tous le supportent (PLAN lot 4). */
  emitterMode: EmitterMode;
  /** `auto` quand aucun appareil central n'existe — c'est le défaut, pas un cas particulier. */
  centralMode: CentralMode;
  onoff: boolean;
  /** Action Flow « ignorer la fenêtre » (SPEC §6.3). */
  windowBypass: boolean;
}

/**
 * Demande de chaleur remontée à l'agrégateur chaudière.
 *
 * `unknown` est une valeur à part entière et non un `false` déguisé : avec un `boolean`, quelqu'un
 * finira par défauter un manquant à `true` et allumera une chaudière sur de l'inconnu.
 */
export type Demand =
  | { kind: 'active'; percent: number }
  | { kind: 'inactive' }
  | { kind: 'unknown' };

/**
 * Déclencheurs Flow (SPEC §10). Décider qu'un événement doit partir est une décision métier :
 * elle appartient au noyau, pas à un `if (prev !== next)` dans un fichier de driver.
 */
export type VThermEvent =
  | { kind: 'preset_changed'; preset: Preset }
  | { kind: 'state_changed'; state: EffectiveState }
  | { kind: 'window_opened' }
  | { kind: 'window_closed' }
  | { kind: 'demand_started'; percent: number }
  | { kind: 'demand_stopped' }
  /**
   * Le capteur de pièce ne dit plus rien d'exploitable et la régulation est suspendue.
   * C'est le seul avertissement que l'utilisateur recevra qu'une pile est vide : sans lui, une
   * pièce cesse simplement d'être chauffée, en silence, jusqu'à ce que quelqu'un ait froid.
   */
  | { kind: 'sensor_quiet' }
  | { kind: 'sensor_recovered' };

export interface VThermOutputs {
  stateLabel: EffectiveState;
  /** `null` = ne rien écrire (valeur dédupliquée, ou régulation suspendue). */
  setpointToEmitter: number | null;
  /** `null` = mode consigne, ou rien à écrire. */
  valvePercent: number | null;
  /** Fraction 0..1. `vtherm_power_percent` en est le centuple. */
  onPercent: number;
  slopePerHour: number | null;
  /** Consigne calculée pour l'émetteur, publiée même quand la déduplication retient l'écriture. */
  regulatedSetpoint: number | null;
  demand: Demand;
  /**
   * À publier tel quel. Une clé ABSENTE signifie « valeur non calculable à ce pas » : la capability
   * garde alors sa valeur précédente. C'est le mécanisme du gel de sortie sur capteur muet — publier
   * un 0 de remplacement serait un mensonge affiché à l'utilisateur.
   */
  capabilities: Record<string, number | boolean | string>;
  events: VThermEvent[];
  /** Prochain instant où une décision changera sans nouvelle entrée. Remplace TOUS les `setTimeout`. */
  wakeUpAtMs: number | null;
  warning: string | null;
}
