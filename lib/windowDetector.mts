/**
 * Détection d'ouverture de fenêtre (SPEC §6) : machine à états à quatre phases, commune aux
 * modes `sensor` (capteur d'ouverture) et `auto` (chute de pente de température). Le mode `off`
 * désactive toute détection et remet l'état à `closed`.
 */

import type { WindowInput, WindowMode, WindowParams, WindowResult, WindowState } from './types.mjs';

export function createWindowState(): WindowState {
  return { phase: 'closed', phaseSinceMs: null, openSinceMs: null, autoDisarmed: false };
}

/** Signal « ouverture détectée », déclencheur d'entrée en détection selon le mode. */
function computeOpenSignal(input: WindowInput, params: WindowParams): boolean {
  if (params.mode === 'sensor') {
    return input.sensorOpen === true;
  }
  // Mode auto : attention au signe, le seuil de réglage est positif mais la chute est négative.
  return input.slopePerHour !== null && input.slopePerHour <= -params.autoOpenThreshold;
}

/** Signal « fin de détection », déclencheur de sortie. `null` (pas de pente) vaut fin de détection. */
function computeCloseSignal(input: WindowInput, params: WindowParams): boolean {
  if (params.mode === 'sensor') {
    /*
     * `!== true` et non `=== false` : une lecture ABSENTE vaut fin de détection.
     *
     * Le contact peut cesser de répondre — appareil disparu du cache de l'API, ré-appairé sous un
     * nouvel identifiant, valeur non interprétable — et il vaut alors `null`. Avec `=== false`, ni
     * le signal d'ouverture ni celui de fermeture n'étaient vrais : la phase `open` n'avait plus
     * AUCUNE sortie, puisque la fermeture forcée sur durée maximale ne vaut qu'en mode auto.
     * Chauffage coupé, vanne à zéro, aucun avertissement, et l'état persisté survivait au
     * redémarrage. Le seuil de fraîcheur de sept jours de ce capteur dit déjà l'intention — « un
     * "ouvert" périmé gèlerait le logement » : on ne confirme une fenêtre ouverte que sur un
     * capteur qui l'affirme.
     */
    return input.sensorOpen !== true;
  }
  return input.slopePerHour === null || input.slopePerHour >= -params.autoCloseThreshold;
}

export function stepWindow(state: WindowState, input: WindowInput, params: WindowParams, nowMs: number): WindowResult {
  if (params.mode === 'off') {
    return { active: false, action: null, nextState: createWindowState() };
  }

  const closeSignal = computeCloseSignal(input, params);
  /*
   * Le désarmement du mode auto se lève dès que la pente se rétablit, et masque toute nouvelle
   * détection jusque-là. Évalué ICI plutôt que dans `computeOpenSignal` : le drapeau appartient à
   * l'état, et le recalculer à deux endroits finirait par les faire diverger.
   */
  const autoDisarmed = state.autoDisarmed && !closeSignal;
  const openSignal = !autoDisarmed && computeOpenSignal(input, params);
  // VT a DEUX réglages distincts, `window_delay` et `window_off_delay` : le délai n'est pas
  // symétrique. Couper vite mais restaurer lentement (ou l'inverse) est un réglage légitime ;
  // les fusionner en un seul `delaySec` retirait ce choix à l'utilisateur.
  const openDelayMs = params.delaySec * 1000;
  const closeDelayMs = params.offDelaySec * 1000;

  let nextState: WindowState;
  let active: boolean;

  switch (state.phase) {
    case 'closed': {
      if (openSignal) {
        nextState = { phase: 'pending_open', phaseSinceMs: nowMs, openSinceMs: null, autoDisarmed };
      } else {
        nextState = { phase: 'closed', phaseSinceMs: null, openSinceMs: null, autoDisarmed };
      }
      active = false;
      break;
    }

    case 'pending_open': {
      const since = state.phaseSinceMs ?? nowMs;
      if (!openSignal) {
        // Ouverture fugace : jamais confirmée, retour direct sans effet.
        nextState = { phase: 'closed', phaseSinceMs: null, openSinceMs: null, autoDisarmed };
        active = false;
      } else if (nowMs - since >= openDelayMs) {
        nextState = { phase: 'open', phaseSinceMs: nowMs, openSinceMs: nowMs, autoDisarmed };
        active = true;
      } else {
        nextState = { phase: 'pending_open', phaseSinceMs: since, openSinceMs: null, autoDisarmed };
        active = false;
      }
      break;
    }

    case 'open': {
      const openSince = state.openSinceMs ?? nowMs;
      const maxDurationMs = params.autoMaxDurationSec * 1000;
      if (params.mode === 'auto' && nowMs - openSince >= maxDurationMs) {
        // Durée maximale atteinte : fermeture forcée même si la chute continue, et DÉSARMEMENT
        // jusqu'au rétablissement de la pente. Le délai de confirmation ne suffisait pas : trente
        // secondes ne protègent de rien quand la chute qui a déclenché la détection est celle que
        // la coupure du chauffage vient elle-même d'entretenir pendant une demi-heure.
        nextState = { phase: 'closed', phaseSinceMs: nowMs, openSinceMs: null, autoDisarmed: true };
        active = false;
      } else if (closeSignal) {
        nextState = { phase: 'pending_close', phaseSinceMs: nowMs, openSinceMs: openSince, autoDisarmed };
        active = true;
      } else {
        nextState = { phase: 'open', phaseSinceMs: state.phaseSinceMs ?? nowMs, openSinceMs: openSince, autoDisarmed };
        active = true;
      }
      break;
    }

    case 'pending_close': {
      const since = state.phaseSinceMs ?? nowMs;
      const openSince = state.openSinceMs ?? nowMs;
      if (openSignal) {
        // Réouverture pendant la confirmation de fermeture : retour direct, sans délai.
        nextState = { phase: 'open', phaseSinceMs: nowMs, openSinceMs: openSince, autoDisarmed };
        active = true;
      } else if (nowMs - since >= closeDelayMs) {
        nextState = { phase: 'closed', phaseSinceMs: nowMs, openSinceMs: null, autoDisarmed };
        active = false;
      } else {
        nextState = { phase: 'pending_close', phaseSinceMs: since, openSinceMs: openSince, autoDisarmed };
        active = true;
      }
      break;
    }
  }

  if (input.bypass) {
    // La détection continue de suivre le capteur en interne, mais son effet est neutralisé.
    return { active: false, action: null, nextState };
  }

  return { active, action: active ? params.action : null, nextState };
}

/**
 * Le mode de détection à écrire quand le contact d'ouverture change, ou `null` pour n'y pas toucher.
 *
 * Désigner un contact le fait servir, comme désigner un détecteur de mouvement active le preset
 * Activité : laisser la détection sur `off` gardait un capteur choisi exprès sans aucun effet, et
 * rien à l'écran ne le signalait (retour du forum, septembre 2026). Seul `off` bascule : `auto` est
 * un choix de l'utilisateur, et un contact ajouté ensuite ne doit pas le défaire en silence.
 *
 * Retirer le contact rend `sensor` à `off` pour la même raison en sens inverse : un mode capteur
 * sans capteur affiche une protection qui n'existe plus.
 *
 * Re-désigner le MÊME contact ne change rien : l'assistant de réparation n'avance qu'en cliquant
 * un appareil, et qui repasse par la page fenêtre pour réparer une vanne reclique celui déjà lié.
 * Un `off` choisi exprès, contact en place (l'été, un capteur en panne), serait sinon écrasé.
 */
export function windowModeForContact(
  current: WindowMode,
  previousContactId: string | null,
  contactId: string | null,
): WindowMode | null {
  if (contactId === previousContactId) return null;
  if (contactId !== null) return current === 'off' ? 'sensor' : null;
  return current === 'sensor' ? 'off' : null;
}
