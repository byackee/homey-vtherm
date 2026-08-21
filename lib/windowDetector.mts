/**
 * Détection d'ouverture de fenêtre (SPEC §6) : machine à états à quatre phases, commune aux
 * modes `sensor` (capteur d'ouverture) et `auto` (chute de pente de température). Le mode `off`
 * désactive toute détection et remet l'état à `closed`.
 */

import type { WindowInput, WindowParams, WindowResult, WindowState } from './types.mjs';

export function createWindowState(): WindowState {
  return { phase: 'closed', phaseSinceMs: null, openSinceMs: null };
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
    return input.sensorOpen === false;
  }
  return input.slopePerHour === null || input.slopePerHour >= -params.autoCloseThreshold;
}

export function stepWindow(state: WindowState, input: WindowInput, params: WindowParams, nowMs: number): WindowResult {
  if (params.mode === 'off') {
    return { active: false, action: null, nextState: createWindowState() };
  }

  const openSignal = computeOpenSignal(input, params);
  const closeSignal = computeCloseSignal(input, params);
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
        nextState = { phase: 'pending_open', phaseSinceMs: nowMs, openSinceMs: null };
      } else {
        nextState = { phase: 'closed', phaseSinceMs: null, openSinceMs: null };
      }
      active = false;
      break;
    }

    case 'pending_open': {
      const since = state.phaseSinceMs ?? nowMs;
      if (!openSignal) {
        // Ouverture fugace : jamais confirmée, retour direct sans effet.
        nextState = { phase: 'closed', phaseSinceMs: null, openSinceMs: null };
        active = false;
      } else if (nowMs - since >= openDelayMs) {
        nextState = { phase: 'open', phaseSinceMs: nowMs, openSinceMs: nowMs };
        active = true;
      } else {
        nextState = { phase: 'pending_open', phaseSinceMs: since, openSinceMs: null };
        active = false;
      }
      break;
    }

    case 'open': {
      const openSince = state.openSinceMs ?? nowMs;
      const maxDurationMs = params.autoMaxDurationSec * 1000;
      if (params.mode === 'auto' && nowMs - openSince >= maxDurationMs) {
        // Durée maximale atteinte : fermeture forcée même si la chute continue. On repasse par
        // `closed` sans réévaluer le signal courant : un nouveau déclenchement devra donc repartir
        // de `pending_open` (et de son délai complet), ce qui évite une réouverture instantanée
        // sur la même chute de température.
        nextState = { phase: 'closed', phaseSinceMs: nowMs, openSinceMs: null };
        active = false;
      } else if (closeSignal) {
        nextState = { phase: 'pending_close', phaseSinceMs: nowMs, openSinceMs: openSince };
        active = true;
      } else {
        nextState = { phase: 'open', phaseSinceMs: state.phaseSinceMs ?? nowMs, openSinceMs: openSince };
        active = true;
      }
      break;
    }

    case 'pending_close': {
      const since = state.phaseSinceMs ?? nowMs;
      const openSince = state.openSinceMs ?? nowMs;
      if (openSignal) {
        // Réouverture pendant la confirmation de fermeture : retour direct, sans délai.
        nextState = { phase: 'open', phaseSinceMs: nowMs, openSinceMs: openSince };
        active = true;
      } else if (nowMs - since >= closeDelayMs) {
        nextState = { phase: 'closed', phaseSinceMs: nowMs, openSinceMs: null };
        active = false;
      } else {
        nextState = { phase: 'pending_close', phaseSinceMs: since, openSinceMs: openSince };
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
