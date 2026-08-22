/**
 * Pilotage par interrupteur : transformer une puissance en temps de marche (type `over_switch`).
 *
 * Sur une vanne, le pourcentage calculé par le TPI devient une ouverture. Sur un relais, il devient
 * du temps : 30 % sur un cycle de 10 minutes, c'est trois minutes allumé puis sept éteint. C'est
 * toute la différence entre un thermostat proportionnel et un bilame — le convecteur ne passe plus
 * de zéro à fond, il délivre la puissance dont la pièce a besoin.
 *
 * Deux gardes, reprises de VT, et elles ne sont pas cosmétiques : un relais a une durée de vie qui
 * se compte en commutations, et un convecteur qu'on allume vingt secondes ne chauffe rien tout en
 * usant le contact.
 */

export interface DutyCycleParams {
  /** Durée d'un cycle complet, en minutes. */
  cycleMin: number;
  /**
   * En dessous de cette durée de marche, on n'allume pas du tout.
   *
   * Allumer un convecteur pour quinze secondes ne chauffe pas la pièce : ça use le relais et ça
   * fait claquer le contacteur, pour rien.
   */
  minActivationSec: number;
  /** Symétrique : en dessous de cette durée d'arrêt, on laisse allumé plutôt que de clignoter. */
  minDeactivationSec: number;
}

export interface DutyCycleState {
  /** Début du cycle courant. `null` tant qu'aucun cycle n'a commencé. */
  cycleStartMs: number | null;
  /** Dernier état commandé, pour ne pas réécrire sans raison. */
  commanded: boolean;
}

export interface DutyCycleResult {
  /** État que l'interrupteur doit avoir maintenant. */
  commanded: boolean;
  /** Vrai quand il diffère du précédent : seul ce cas justifie une écriture. */
  changed: boolean;
  /** Instant de la prochaine bascule. Le noyau n'arme aucune minuterie, il annonce l'échéance. */
  wakeUpAtMs: number;
  nextState: DutyCycleState;
}

export function createDutyCycleState(): DutyCycleState {
  return { cycleStartMs: null, commanded: false };
}

export function stepDutyCycle(
  state: DutyCycleState,
  onPercent: number,
  params: DutyCycleParams,
  nowMs: number,
): DutyCycleResult {
  const cycleMs = Math.max(1, params.cycleMin) * 60_000;

  // Nouveau cycle : au premier appel, et chaque fois que le précédent est consommé. Une horloge
  // qui recule redémarre aussi le cycle, plutôt que de calculer sur un écoulement négatif.
  let cycleStartMs = state.cycleStartMs;
  if (cycleStartMs === null || nowMs < cycleStartMs || nowMs - cycleStartMs >= cycleMs) {
    cycleStartMs = nowMs;
  }

  const onMs = resolveOnMs(onPercent, cycleMs, params);
  const elapsed = nowMs - cycleStartMs;
  const commanded = elapsed < onMs;

  // Prochaine bascule : la fin de la période de marche si on chauffe, la fin du cycle sinon.
  const wakeUpAtMs = commanded ? cycleStartMs + onMs : cycleStartMs + cycleMs;

  return {
    commanded,
    changed: commanded !== state.commanded,
    wakeUpAtMs,
    nextState: { cycleStartMs, commanded },
  };
}

/** Durée de marche du cycle, gardes comprises. */
function resolveOnMs(onPercent: number, cycleMs: number, params: DutyCycleParams): number {
  if (!Number.isFinite(onPercent) || onPercent <= 0) return 0;
  if (onPercent >= 1) return cycleMs;

  const raw = onPercent * cycleMs;

  // Trop court pour chauffer : on reste éteint tout le cycle.
  if (raw < Math.max(0, params.minActivationSec) * 1000) return 0;

  // Trop court pour couper : on reste allumé tout le cycle.
  const off = cycleMs - raw;
  if (off < Math.max(0, params.minDeactivationSec) * 1000) return cycleMs;

  return raw;
}
