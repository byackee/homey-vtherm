/**
 * Réducteur racine d'un VTherm.
 *
 * Ce n'est PAS « un cycle » : c'est un pas de machine à états sur un instantané du monde à
 * l'instant T. L'ordonnanceur l'appelle périodiquement, mais un changement de consigne, une
 * nouvelle mesure ou une ouverture de fenêtre l'appellent exactement de la même façon. Rien ici ne
 * suppose qu'un temps donné s'est écoulé depuis l'appel précédent, et rien ne suppose qu'il y aura
 * un appel suivant : un pas qui a besoin d'être rappelé le DIT, en retournant `wakeUpAtMs`.
 *
 * Pur : aucune référence à Homey, aucune lecture d'horloge, aucune minuterie, aucune mutation des
 * arguments. `state` et `inputs` sont lus, jamais écrits ; le pas suivant est un objet neuf.
 */

import type {
  CentralMode, Demand, EffectiveState, Preset, Reading, StateContext,
  VThermConfig, VThermEvent, VThermInputs, VThermLastWrite, VThermOutputs, VThermState,
  WindowMemento, WindowPhase,
} from './types.mjs';
import { SETPOINT_MAX, SETPOINT_MIN, SETPOINT_STEP } from './constants.mjs';
import { computeOnPercent } from './tpi.mjs';
import { computeOpeningDegree } from './openingDegree.mjs';
import { computeOffset, resolveRegulationParams } from './selfRegulation.mjs';
import { updateSlope } from './slope.mjs';
import { stepWindow } from './windowDetector.mjs';
import { createMotionState, resolveSetpoint, updateMotion } from './presetResolver.mjs';
import { resolveStateLabel } from './stateLabel.mjs';
import { shouldWrite, type LastWrite, type WriteOptions } from './writePolicy.mjs';

export type {
  Demand, Reading, VThermConfig, VThermEvent, VThermInputs, VThermOutputs,
} from './types.mjs';

const MS_PER_MINUTE = 60_000;

// --- Outils locaux ----------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Toute consigne qui part vers un émetteur passe par ici : bornée puis alignée sur le pas de 0,5 °C
 * (SPEC §2.3, et pas natif de la TRVZB). Aligner AVANT la déduplication est ce qui rend celle-ci
 * fiable : sans ça, 19,0001 et 19,0002 seraient deux écritures distinctes vers un appareil qui les
 * arrondirait de toute façon à la même valeur.
 */
export function toEmitterSetpoint(value: number): number {
  const bounded = clamp(value, SETPOINT_MIN, SETPOINT_MAX);
  return roundTo(Math.round(bounded / SETPOINT_STEP) * SETPOINT_STEP, 2);
}

/**
 * Une lecture n'est exploitable que fraîche ET finie. Le `Number.isFinite` n'est pas de la
 * paranoïa : une capability Homey absente se lit `null`, et un `null` arithmétique vaut 0 — une
 * pièce à 0 °C ferait s'ouvrir la vanne en grand.
 */
function usableNumber(reading: Reading<number> | null): Reading<number> | null {
  if (reading === null || reading.stale || !Number.isFinite(reading.value)) return null;
  return reading;
}

function usableBoolean(reading: Reading<boolean> | null): boolean | null {
  if (reading === null || reading.stale || typeof reading.value !== 'boolean') return null;
  return reading.value;
}

/** Phases où la détection d'ouverture est confirmée, indépendamment du bypass. */
function isDetectedOpen(phase: WindowPhase): boolean {
  return phase === 'open' || phase === 'pending_close';
}

// --- Réducteur --------------------------------------------------------------

export function stepVTherm(
  state: VThermState,
  inputs: VThermInputs,
  config: VThermConfig,
  nowMs: number,
): { outputs: VThermOutputs; nextState: VThermState } {
  const { persistent, volatile } = state;

  // === 1. Normalisation des lectures (table de replis, PLAN lot 2) ==========
  //
  // Chaque repli est une décision de sûreté écrite une fois pour toutes, ici et nulle part ailleurs.

  const roomReading = usableNumber(inputs.roomTemp);
  const roomTemp = roomReading === null ? null : roomReading.value;
  const roomSensorMute = roomTemp === null;

  const outdoorReading = usableNumber(inputs.outdoorTemp);
  // Capteur extérieur muet : terme `coefExt` mis à 0 (SPEC §4), et non une valeur inventée.
  const outdoorTemp = outdoorReading === null ? null : outdoorReading.value;

  // Contact de fenêtre périmé : traité FERMÉ. Un « ouvert » périmé couperait la chauffe
  // indéfiniment et gèlerait le logement — le repli dangereux est ici l'inverse de l'intuition.
  const sensorOpen = inputs.windowContact === null
    ? null
    : (inputs.windowContact.stale ? false : inputs.windowContact.value);

  // Mouvement et présence muets : repli sur « présent, sans mouvement », c'est-à-dire la consigne
  // la plus conservatrice qui ne laisse pas un logement occupé sans chauffage.
  const motionRaw = usableBoolean(inputs.motion) ?? false;
  const presence = inputs.presence === null ? null : (usableBoolean(inputs.presence) ?? true);

  const emitterHeating = usableBoolean(inputs.emitterHeating);

  // === 2. Pente de température (volatile) ==================================
  //
  // Horodatée sur la MESURE et non sur `nowMs` : deux pas successifs sur la même lecture ne doivent
  // pas fabriquer une pente nulle, ils doivent ne rien changer du tout. `updateSlope` neutralise
  // déjà un delta nul, ce qui rend l'appel idempotent.

  let slopeState = volatile.slope;
  let slopePerHour: number | null;
  if (roomReading !== null) {
    const result = updateSlope(slopeState, roomReading.value, roomReading.atMs, config.slope);
    slopeState = result.nextState;
    slopePerHour = result.slopePerHour;
  } else {
    // Capteur muet : la dernière pente connue est conservée telle quelle, pas remise à zéro.
    slopePerHour = slopeState.slope;
  }

  // === 3. Mouvement (volatile) =============================================

  const motionState = config.motion.enabled
    ? updateMotion(volatile.motion, motionRaw, config.motion, nowMs)
    : createMotionState();

  // === 4. Résolution du preset =============================================
  //
  // Calculée AVANT les priorités qui peuvent l'écraser, pour trois raisons : le preset affiché ne
  // change pas sous l'effet d'une fenêtre ou d'une absence (SPEC §6.3 et §7), l'expiration d'un
  // preset temporisé doit être constatée même quand le mode central prend la main, et le mémento
  // fenêtre a besoin de la consigne telle qu'elle était avant l'action.

  const presetResult = resolveSetpoint({
    preset: persistent.preset,
    manualSetpoint: persistent.manualSetpoint,
    presetTemps: config.presetTemps,
    awayTemps: config.awayTemps,
    presence,
    motion: config.motion,
    motionState,
    timedPreset: persistent.timedPreset,
  }, nowMs);

  let preset: Preset = persistent.preset;
  let timedPreset = persistent.timedPreset;
  if (presetResult.timedExpired && timedPreset !== null) {
    preset = timedPreset.previous;
    timedPreset = null;
  }
  const displayedPreset: Preset = timedPreset !== null ? timedPreset.preset : preset;

  // === 5. Détection d'ouverture ============================================

  const windowResult = stepWindow(
    persistent.window,
    { sensorOpen, slopePerHour, bypass: inputs.windowBypass },
    config.window,
    nowMs,
  );
  // La détection suit le capteur même sous bypass ; seule son ACTION est neutralisée. Les
  // déclencheurs Flow « fenêtre ouverte/fermée » suivent donc la détection, pas l'action.
  const windowDetected = isDetectedOpen(windowResult.nextState.phase);

  // === 6. Mode central =====================================================

  const centralMode: CentralMode = config.useCentralMode ? inputs.centralMode : 'auto';
  const centralOverride = centralMode !== 'auto';

  // === 7. Arbitrage : consigne effective et autorisation de chauffe ========
  //
  // Correction du pseudo-code SPEC §3, qui « sort » sur tout mode central non-`auto` et sur toute
  // fenêtre confirmée. C'est faux dans trois cas sur quatre :
  //  - `heat_only` interdit seulement le refroidissement (sans objet en v1, pas de mode clim) et
  //    continue de réguler ; sortir gèlerait toute la régulation du logement ;
  //  - `frost` force la consigne hors-gel puis CONTINUE de réguler vers 7 °C ;
  //  - les actions fenêtre `frost` et `eco` changent la consigne sans changer le preset (SPEC §6.3)
  //    et exigent donc que la régulation s'exécute ensuite.
  // Seuls `stopped`, l'arrêt utilisateur et les actions `turn_off`/`fan_only` suppriment la chauffe.

  const frostTemp = config.presetTemps.frost;
  let effectiveSetpoint = presetResult.setpoint;
  let heatSuppressed = false;

  if (!inputs.onoff) {
    // SPEC muette sur ce point — comportement décidé ici : consigne hors-gel ET vanne fermée.
    // Éteindre sans envoyer de consigne laisserait la vanne sur sa dernière valeur, donc un
    // radiateur ouvert sur un thermostat affiché « éteint ».
    effectiveSetpoint = frostTemp;
    heatSuppressed = true;
  } else if (centralOverride) {
    // Le mode central prime sur la fenêtre : c'est une décision de logement, elle ne se laisse pas
    // renverser par un capteur de pièce (SPEC §2.3, priorité `central` > `window`).
    if (centralMode === 'stopped') {
      effectiveSetpoint = frostTemp;
      heatSuppressed = true;
    } else if (centralMode === 'frost') {
      effectiveSetpoint = frostTemp;
    }
    // `heat_only` : consigne nominale, régulation nominale, seule l'étiquette change.
  } else if (windowResult.active) {
    switch (windowResult.action) {
      case 'frost':
        effectiveSetpoint = frostTemp;
        break;
      case 'eco':
        // Température ÉCO du preset, pas sa variante « absence » : l'action fenêtre court-circuite
        // la résolution des presets (SPEC §6.3).
        effectiveSetpoint = config.presetTemps.eco;
        break;
      default:
        // `turn_off` et `fan_only` : pas de chauffe. `fan_only` n'a pas de sens sans mode clim,
        // il est traité comme `turn_off` jusqu'à l'arrivée de `ac_mode` (SPEC §12).
        effectiveSetpoint = frostTemp;
        heatSuppressed = true;
        break;
    }
  }

  // === 8. Régulation =======================================================

  let onPercent = 0;
  let regulationState = persistent.regulation;
  let valveTarget: number | null = null;
  let regulatedSetpoint: number | null = null;

  if (heatSuppressed) {
    // Arrêt commandé : aucune mesure n'est nécessaire pour fermer une vanne. Ce cas passe donc
    // AVANT le capteur muet — un thermostat éteint doit s'éteindre même sans thermomètre.
    // Fermeture à 0 franc, et non `100 − maxClosingDegree` : le filet d'ouverture de ce réglage
    // vise la régulation sous le seuil, pas un thermostat qu'on vient d'éteindre.
    valveTarget = inputs.emitterMode === 'valve' ? 0 : null;
    regulatedSetpoint = toEmitterSetpoint(effectiveSetpoint);
  } else if (roomTemp === null) {
    // Capteur de pièce muet : SORTIE GELÉE. On ne calcule rien, on n'écrit rien, on n'accumule
    // rien. Continuer le TPI sur une température figée, c'est l'emballement thermique : l'écart
    // resterait constant, la vanne s'ouvrirait un peu plus à chaque cycle et personne ne le verrait
    // avant d'entrer dans la pièce. `regulationState` reste tel quel : à la reprise, l'intégrale
    // repart de là où la mesure s'est tue, pas de zéro.
  } else {
    // `on_percent` est calculé dans les DEUX modes : SPEC §2.3 définit `vtherm_power_percent`
    // comme la sortie TPI, indépendamment de la façon dont on parle à l'émetteur.
    onPercent = computeOnPercent({
      setpoint: effectiveSetpoint, roomTemp, outdoorTemp, slopePerHour,
    }, config.tpi).onPercent;

    if (inputs.emitterMode === 'valve') {
      // Interpolation affine de la plage utile de `on_percent` vers la course mécanique de la
      // vanne (SPEC §4.1) — arrondie au pas de 1 % accepté par la TRVZB.
      valveTarget = Math.round(computeOpeningDegree(onPercent, config));
      // En contrôle direct de vanne, la consigne envoyée reste la consigne BRUTE : elle ne sert
      // qu'à l'affichage de l'émetteur, c'est l'ouverture qui commande (SPEC §3, étape 4).
      regulatedSetpoint = toEmitterSetpoint(effectiveSetpoint);
    } else {
      const params = resolveRegulationParams(config.regulationMode, config.expertRegulation);
      // Intervalle écoulé exprimé en cycles : un pas déclenché hors cycle ne doit pas peser autant
      // qu'un cycle complet dans l'intégrale. Jamais négatif — une horloge qui recule ne charge pas.
      const dtCycles = Math.max(0, nowMs - persistent.lastRunAtMs) / (config.cycleMin * MS_PER_MINUTE);
      const regulation = computeOffset(
        {
          setpoint: effectiveSetpoint, roomTemp, outdoorTemp, dtCycles,
        },
        params,
        regulationState,
      );
      regulationState = regulation.nextState;
      regulatedSetpoint = toEmitterSetpoint(effectiveSetpoint + regulation.offset);
    }
  }

  // === 9. Demande de chaleur ===============================================

  let demand: Demand;
  if (heatSuppressed) {
    // Décision définitive et non une ignorance : on vient de commander la fermeture.
    demand = { kind: 'inactive' };
  } else if (roomTemp === null) {
    demand = { kind: 'unknown' };
  } else if (inputs.emitterMode === 'valve') {
    // MÊME prédicat que `computeOpeningDegree` : sans ça, on finirait par compter une vanne
    // commandée ouverte comme inactive, ou l'inverse. `openingThreshold` est sur l'échelle de
    // `on_percent` (fraction 0..1), pas en points de pourcentage d'ouverture.
    const valveOpen = onPercent >= config.openingThreshold && onPercent > 0;
    demand = valveOpen
      ? { kind: 'active', percent: valveTarget ?? 0 }
      : { kind: 'inactive' };
  } else if (emitterHeating === null) {
    // Mode consigne : la demande se lit sur l'émetteur (SPEC §9.2). Sans cette lecture on ne SAIT
    // pas, et `unknown` propage l'ignorance jusqu'à l'agrégateur, qui laisse la chaudière éteinte.
    demand = { kind: 'unknown' };
  } else {
    demand = emitterHeating
      ? { kind: 'active', percent: roundTo(onPercent * 100, 1) }
      : { kind: 'inactive' };
  }

  // === 10. Écritures et déduplication ======================================
  //
  // La déduplication est une fonction de correction : le quota de l'API Athom se déclenche aussi en
  // production. Elle est déléguée à `writePolicy.shouldWrite` pour qu'il n'y ait qu'une seule
  // définition de « faut-il vraiment appeler l'appareil ».

  const lastWrite = volatile.lastWrite;
  const lastValve: LastWrite | null = lastWrite.valvePercent === null
    ? null
    : { value: lastWrite.valvePercent, atMs: lastWrite.atMs };
  const lastSetpoint: LastWrite | null = lastWrite.setpoint === null
    ? null
    : { value: lastWrite.setpoint, atMs: lastWrite.atMs };

  let valvePercent: number | null = null;
  if (valveTarget !== null) {
    // Une fermeture commandée n'est jamais retenue par le seuil de variation : c'est une décision
    // de sûreté, pas une optimisation. Avec `regulationThreshold` à 3 %, une vanne à 2 % resterait
    // sinon entrouverte sur un thermostat éteint.
    const opts: WriteOptions = heatSuppressed ? {} : { minDelta: config.regulationThreshold };
    if (shouldWrite(lastValve, valveTarget, opts, nowMs).write) {
      valvePercent = valveTarget;
    }
  }

  let setpointToEmitter: number | null = null;
  if (regulatedSetpoint !== null) {
    // En mode vanne la consigne n'est qu'un affichage : aucun seuil, on la réécrit quand elle
    // change. En mode consigne, c'est elle qui commande, et les deux garde-fous de la SPEC §5.2
    // (`auto_regulation_dtemp`, `auto_regulation_period_min`) s'appliquent.
    const opts: WriteOptions = (heatSuppressed || inputs.emitterMode === 'valve')
      ? {}
      : {
        minDelta: config.autoRegulationDtemp,
        minIntervalMs: config.autoRegulationPeriodMin * MS_PER_MINUTE,
      };
    if (shouldWrite(lastSetpoint, regulatedSetpoint, opts, nowMs).write) {
      setpointToEmitter = regulatedSetpoint;
    }
  }

  const wrote = valvePercent !== null || setpointToEmitter !== null;
  const nextLastWrite: VThermLastWrite = {
    valvePercent: valvePercent ?? lastWrite.valvePercent,
    setpoint: setpointToEmitter ?? lastWrite.setpoint,
    atMs: wrote ? nowMs : lastWrite.atMs,
  };

  // === 11. Étiquette d'état ================================================

  const stateContext: StateContext = {
    onoff: inputs.onoff,
    centralOverride,
    windowActive: windowResult.active,
    roomSensorMute,
    overpowered: false,
    away: presetResult.away,
    activity: presetResult.activity,
    heating: demand.kind === 'active',
  };
  const stateLabel: EffectiveState = resolveStateLabel(stateContext);

  // === 12. Mémento fenêtre =================================================
  //
  // Le noyau restaure naturellement la consigne à la fermeture, puisqu'il la recalcule à chaque
  // pas. Le mémento sert à ce que le noyau ne peut pas reconstruire : ce que l'utilisateur avait
  // choisi avant l'ouverture, que `runtime/` doit pouvoir rétablir sur les capabilities.

  const wasDetectedOpen = isDetectedOpen(persistent.window.phase);
  let windowMemento: WindowMemento | null = persistent.windowMemento;
  if (!wasDetectedOpen && windowDetected) {
    windowMemento = {
      onoff: inputs.onoff,
      preset: displayedPreset,
      setpoint: presetResult.setpoint,
    };
  } else if (wasDetectedOpen && !windowDetected) {
    windowMemento = null;
  }

  // === 13. Événements ======================================================
  //
  // Comparaison avec ce qui a été PUBLIÉ, jamais avec l'entrée courante : c'est ce qui garantit
  // qu'un événement part une seule fois sur un changement, et pas à chaque pas qui suit.
  // Un champ `null` signifie « jamais publié » et n'émet rien : au premier pas après un
  // redémarrage, aucun Flow fantôme.

  const published = volatile.lastPublished;
  const demandActive = demand.kind === 'active';
  const events: VThermEvent[] = [];

  if (published.windowOpen !== null && published.windowOpen !== windowDetected) {
    events.push(windowDetected ? { kind: 'window_opened' } : { kind: 'window_closed' });
  }
  if (published.preset !== null && published.preset !== displayedPreset) {
    events.push({ kind: 'preset_changed', preset: displayedPreset });
  }
  if (published.stateLabel !== null && published.stateLabel !== stateLabel) {
    events.push({ kind: 'state_changed', state: stateLabel });
  }
  // Un capteur qui se tait n'est signalé qu'appareil allumé : un thermostat éteint dont la pile
  // est vide n'a rien à annoncer, et un bandeau permanent est un bandeau qu'on apprend à ignorer.
  const sensorQuiet = roomSensorMute && inputs.onoff;
  if (published.sensorQuiet !== null && published.sensorQuiet !== sensorQuiet) {
    events.push(sensorQuiet ? { kind: 'sensor_quiet' } : { kind: 'sensor_recovered' });
  }
  if (published.demandActive !== null && published.demandActive !== demandActive) {
    // `unknown` compte comme une demande arrêtée : c'est déjà ce que l'agrégateur en fait, et deux
    // lectures divergentes du même état finiraient par allumer une chaudière sur de l'inconnu.
    events.push(demand.kind === 'active'
      ? { kind: 'demand_started', percent: demand.percent }
      : { kind: 'demand_stopped' });
  }

  // === 14. Prochain réveil =================================================
  //
  // Remplace TOUTES les minuteries de l'app : le noyau n'en arme aucune, il annonce l'instant où sa
  // décision changera sans nouvelle entrée. `null` = rien en attente, l'ordonnanceur peut dormir
  // jusqu'à son propre cycle.

  const wakeUps: number[] = [];
  const nextWindow = windowResult.nextState;
  if (config.window.mode !== 'off') {
    if (nextWindow.phaseSinceMs !== null) {
      // Les deux délais sont distincts chez VT : `window_delay` confirme l'ouverture,
      // `window_off_delay` la fermeture. Réveiller sur le mauvais des deux ferait restaurer la
      // chauffe trop tôt ou trop tard, silencieusement.
      if (nextWindow.phase === 'pending_open') {
        wakeUps.push(nextWindow.phaseSinceMs + config.window.delaySec * 1000);
      } else if (nextWindow.phase === 'pending_close') {
        wakeUps.push(nextWindow.phaseSinceMs + config.window.offDelaySec * 1000);
      }
    }
    // Durée maximale de détection auto : seule la phase `open` y est soumise (windowDetector.mts).
    if (config.window.mode === 'auto' && nextWindow.phase === 'open' && nextWindow.openSinceMs !== null) {
      wakeUps.push(nextWindow.openSinceMs + config.window.autoMaxDurationSec * 1000);
    }
  }
  if (config.motion.enabled && motionState.pendingSinceMs !== null) {
    const delaySec = motionState.raw ? config.motion.delaySec : config.motion.offDelaySec;
    wakeUps.push(motionState.pendingSinceMs + delaySec * 1000);
  }
  if (timedPreset !== null) {
    wakeUps.push(timedPreset.untilMs);
  }
  const wakeUpAtMs = wakeUps.length === 0 ? null : Math.min(...wakeUps);

  // === 15. Capabilities à publier ==========================================
  //
  // Une clé absente = valeur non calculable à ce pas, donc capability inchangée. C'est le mécanisme
  // du gel de sortie : publier un 0 de remplacement afficherait un mensonge à l'utilisateur et,
  // pour `vtherm_power_percent`, fausserait durablement les graphiques Insights.

  const capabilities: Record<string, number | boolean | string> = {
    vtherm_preset: displayedPreset,
    vtherm_state: stateLabel,
    // La consigne CHOISIE, pas celle qui part vers l'émetteur : `target_temperature` est setable et
    // y republier une valeur calculée ferait lutter l'app contre l'utilisateur. Ce qui part
    // réellement est exposé en lecture seule sous `vtherm_regulated_setpoint` (SPEC §2.3).
    target_temperature: toEmitterSetpoint(presetResult.setpoint),
  };
  if (roomTemp !== null) {
    capabilities.measure_temperature = roomTemp;
  }
  if (!roomSensorMute || heatSuppressed) {
    capabilities.vtherm_power_percent = roundTo(onPercent * 100, 1);
    if (valveTarget !== null) {
      capabilities.vtherm_valve_open = valveTarget;
    }
    if (regulatedSetpoint !== null) {
      capabilities.vtherm_regulated_setpoint = regulatedSetpoint;
    }
  }
  if (slopePerHour !== null) {
    capabilities.vtherm_slope = slopePerHour;
  }
  if (inputs.windowContact !== null) {
    capabilities.alarm_contact = windowDetected;
  }
  if (config.motion.enabled) {
    capabilities.alarm_motion = motionState.confirmed;
  }

  // === 16. Avertissement ===================================================
  //
  // Seul le capteur de pièce muet justifie un avertissement : c'est le seul repli qui SUSPEND la
  // régulation. Les autres dégradent sans bloquer, et un avertissement permanent sur un émetteur
  // qui n'expose pas son état de chauffe serait un bandeau que l'utilisateur apprendrait à ignorer.
  // Rien à signaler sur un appareil éteint.

  let warning: string | null = null;
  if (sensorQuiet) {
    warning = inputs.roomTemp === null
      ? 'Aucun capteur de température de pièce exploitable : régulation suspendue.'
      : 'Mesure de température de pièce périmée : régulation suspendue, aucune commande envoyée.';
  }

  // === 17. État suivant ====================================================

  const nextState: VThermState = {
    persistent: {
      version: 1,
      preset,
      manualSetpoint: persistent.manualSetpoint,
      timedPreset,
      window: nextWindow,
      windowMemento,
      regulation: regulationState,
      lastRunAtMs: nowMs,
    },
    volatile: {
      slope: slopeState,
      motion: motionState,
      lastWrite: nextLastWrite,
      lastPublished: {
        stateLabel,
        preset: displayedPreset,
        windowOpen: windowDetected,
        demandActive,
        sensorQuiet,
      },
    },
  };

  const outputs: VThermOutputs = {
    stateLabel,
    setpointToEmitter,
    valvePercent,
    onPercent,
    slopePerHour,
    regulatedSetpoint,
    demand,
    capabilities,
    events,
    wakeUpAtMs,
    warning,
  };

  return { outputs, nextState };
}
