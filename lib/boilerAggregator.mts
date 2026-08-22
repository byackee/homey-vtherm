/**
 * Agrégation de la demande de chauffe et pilotage de la chaudière centrale (SPEC §9.2).
 */

import type { BoilerParams, BoilerResult, BoilerState } from './types.mjs';
import { BOILER_DIVERGENCE_RETRY_SEC, BOILER_MIN_DWELL_FLOOR_SEC } from './constants.mjs';

export function createBoilerState(): BoilerState {
  return {
    commanded: false, lastChangeMs: null, pendingSinceMs: null, lastKeepAliveMs: null,
    lastDivergenceFixMs: null,
    // Un état neuf n'a rien écrit : le premier pas affirmera l'arrêt, ce qui est toujours sûr.
    affirmed: false,
  };
}

/**
 * Le garde-fou anti-pulsation en millisecondes, plancher compris.
 *
 * Exporté parce que l'ordonnancement en a besoin autant que la décision : le participant doit
 * pouvoir annoncer l'instant EXACT où un allumage refusé redeviendra possible, et une seconde
 * définition du plancher finirait par diverger de celle-ci.
 */
export function boilerDwellMs(params: BoilerParams): number {
  return Math.max(params.minDwellSec, BOILER_MIN_DWELL_FLOOR_SEC) * 1000;
}

/**
 * @param relayState état RÉELLEMENT lu sur le relais, ou `null` quand il n'est pas lisible.
 *   Voir le bloc « Réaffirmation sur divergence ». `null` conserve exactement le comportement
 *   d'avant la lecture en retour : on ne corrige que ce qu'on a vu.
 */
export function stepBoiler(
  state: BoilerState,
  nbActive: number,
  params: BoilerParams,
  nowMs: number,
  relayState: boolean | null = null,
): BoilerResult {
  const demand = nbActive >= params.threshold;
  const dwellMs = boilerDwellMs(params);

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
  let ignitionBlocked = false;

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
      const allowed = lastChangeMs === null || nowMs - lastChangeMs >= dwellMs;
      if (allowed) {
        commanded = true;
        lastChangeMs = nowMs;
        command = true;
      } else {
        // Allumage refusé : il reste en attente et sera retenté dès que le délai sera écoulé —
        // si la demande tient toujours à ce moment-là. Signalé à l'appelant pour qu'il puisse
        // le tracer : une attente muette d'une minute se lit comme une panne.
        ignitionBlocked = true;
      }
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

  /*
   * Réaffirmation sur DIVERGENCE — le relais n'est pas dans l'état qu'on lui a commandé.
   *
   * `stepBoiler` ne produit un ordre que sur CHANGEMENT, et `keepAliveSec` vaut zéro par défaut :
   * un ordre perdu en route n'était donc jamais réémis. Une trame Zigbee avalée, une prise qui
   * revient sur son `power_on_behavior` après une micro-coupure, un quota d'API atteint pendant
   * une rafale de changements de consigne, une bascule à la main — et le modèle disait ALLUMÉE
   * pendant que la maison restait froide, sans erreur ni trace, jusqu'au prochain vrai changement
   * de demande. C'est exactement la panne que l'émetteur en mode interrupteur corrige déjà par
   * divergence (voir `step.mts` §8bis) ; le relais de chaudière ne le faisait pas.
   *
   * Une correction n'est PAS une commutation : elle ne touche pas `lastChangeMs` et ne déclenche
   * aucune carte Flow — du point de vue de l'app, l'état commandé n'a pas bougé.
   *
   * L'ASYMÉTRIE du garde-fou est reconduite ici, et pour la même raison. Corriger vers l'ALLUMAGE
   * attend le garde-fou : si le relais a divergé juste après une commutation, le rallumer aussitôt
   * fabriquerait précisément le court-cycle que le garde-fou existe pour empêcher. Corriger vers
   * l'ARRÊT ne l'attend pas : une chaudière qui tourne alors que RIEN ne la demande chauffe un
   * circuit dont toutes les vannes sont fermées.
   *
   * « Rien ne la demande » est la condition, et elle n'est pas la même que « pas encore commandée ».
   * Entre le retour de la demande et l'allumage il y a une attente — délai d'activation, ou garde-fou
   * — pendant laquelle l'app n'a pas encore commandé l'allumage mais s'apprête à le faire. Couper là
   * un relais resté allumé, c'est éteindre une chaudière qu'on rallumera quarante secondes plus tard :
   * le court-cycle qu'on prétendait éviter, fabriqué par la correction elle-même. Tant que la demande
   * est là, on laisse le relais tranquille ; le prochain allumage remettra le modèle d'accord.
   */
  let divergence = false;
  let lastDivergenceFixMs = commanded === state.commanded ? state.lastDivergenceFixMs : null;

  if (command === null && relayState !== null && relayState !== commanded) {
    // Espacement des RETENTATIVES : un relais en panne peut réannoncer son état en boucle, et
    // chaque annonce vaudrait un appel d'API. Voir `BOILER_DIVERGENCE_RETRY_SEC`.
    const retryDue = lastDivergenceFixMs === null
      || nowMs - lastDivergenceFixMs >= BOILER_DIVERGENCE_RETRY_SEC * 1000;

    if (retryDue && !commanded && !demand) {
      command = false;
      divergence = true;
    } else if (retryDue && commanded && (lastChangeMs === null || nowMs - lastChangeMs >= dwellMs)) {
      command = true;
      divergence = true;
    }
  }
  if (divergence) lastDivergenceFixMs = nowMs;

  if (command !== null) affirmed = true;

  return {
    command,
    keepAlive,
    affirmation,
    divergence,
    ignitionBlocked,
    nextState: {
      commanded, lastChangeMs, pendingSinceMs, lastKeepAliveMs, affirmed, lastDivergenceFixMs,
    },
  };
}
