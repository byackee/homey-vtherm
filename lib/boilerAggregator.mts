/**
 * Agrégation de la demande de chauffe et pilotage de la chaudière centrale (SPEC §9.2).
 */

import type { BoilerParams, BoilerResult, BoilerState } from './types.mjs';
import { BOILER_MIN_DWELL_FLOOR_SEC } from './constants.mjs';

export function createBoilerState(): BoilerState {
  return {
    commanded: false, lastChangeMs: null, pendingSinceMs: null, lastKeepAliveMs: null,
    // Un état neuf n'a rien écrit : le premier pas affirmera l'arrêt, ce qui est toujours sûr.
    affirmed: false,
  };
}

export function stepBoiler(
  state: BoilerState,
  nbActive: number,
  params: BoilerParams,
  nowMs: number,
): BoilerResult {
  const demand = nbActive >= params.threshold;

  // Compteur du délai d'activation : actif tant que la demande est vraie et qu'on n'est pas
  // encore commandé. Indépendant du garde-fou anti-pulsation ci-dessous.
  const activationPendingSinceMs = demand && !state.commanded ? (state.pendingSinceMs ?? nowMs) : null;

  let desired: boolean;
  if (!demand) {
    desired = false;
  } else if (state.commanded) {
    desired = true;
  } else {
    desired = nowMs - (activationPendingSinceMs as number) >= params.activationDelaySec * 1000;
  }

  let commanded = state.commanded;
  let lastChangeMs = state.lastChangeMs;
  let command: boolean | null = null;

  if (desired !== state.commanded) {
    /*
     * Garde-fou anti-pulsation, ASYMÉTRIQUE — ne surtout pas « simplifier » en le rendant
     * symétrique.
     *
     * Il ne porte que sur l'ALLUMAGE : pas de nouveau ON moins de `minDwellSec` après la dernière
     * commutation. L'EXTINCTION part toujours immédiatement. VT documente le choix : « Il n'y a
     * pas de délai pour l'extinction de la chaudière. C'est volontaire pour vous éviter de laisser
     * tourner la chaudière alors que toutes les vannes sont fermées. » Différer une coupure quand
     * tous les robinets viennent de se fermer, c'est faire tourner une chaudière sur un circuit
     * fermé — une surpression, pas une inélégance.
     *
     * Premier appel (lastChangeMs === null) exempté de l'attente.
     */
    if (!desired) {
      commanded = false;
      lastChangeMs = nowMs;
      command = false;
    } else {
      const dwellMs = Math.max(params.minDwellSec, BOILER_MIN_DWELL_FLOOR_SEC) * 1000;
      const allowed = lastChangeMs === null || nowMs - lastChangeMs >= dwellMs;
      if (allowed) {
        commanded = true;
        lastChangeMs = nowMs;
        command = true;
      }
      // Sinon : allumage refusé, il reste en attente et sera retenté aux appels suivants,
      // dès que le délai sera écoulé — si la demande tient toujours à ce moment-là.
    }
  }

  // Le compteur d'activation reflète l'état final : nul dès que la demande est satisfaite ou absente.
  const pendingSinceMs = demand && !commanded ? (activationPendingSinceMs ?? nowMs) : null;

  let lastKeepAliveMs = state.lastKeepAliveMs;
  let keepAlive = false;

  if (!commanded) {
    lastKeepAliveMs = null;
  } else if (command === null && params.keepAliveSec > 0) {
    // Un keep-alive n'est pas une commutation : il ne touche pas lastChangeMs.
    const baseline = lastKeepAliveMs ?? (lastChangeMs as number);
    if (nowMs - baseline >= params.keepAliveSec * 1000) {
      command = true;
      keepAlive = true;
      lastKeepAliveMs = nowMs;
    }
  }

  /*
   * Réaffirmation au démarrage. Une réaffirmation n'est PAS une commutation : elle ne touche pas
   * `lastChangeMs`, n'est pas soumise au garde-fou anti-pulsation, et ne doit pas déclencher les
   * cartes Flow « la chaudière démarre / s'arrête » — elle ne fait que remettre le relais en
   * accord avec l'état que l'app croit avoir commandé.
   */
  let affirmed = state.affirmed;
  let affirmation = false;
  if (command === null && !affirmed) {
    command = commanded;
    affirmation = true;
  }
  if (command !== null) affirmed = true;

  return {
    command,
    keepAlive,
    affirmation,
    nextState: {
      commanded, lastChangeMs, pendingSinceMs, lastKeepAliveMs, affirmed,
    },
  };
}
