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
  /** Début du cycle courant, COMMUN à toutes les têtes. `null` tant qu'aucun cycle n'a commencé. */
  cycleStartMs: number | null;
  /**
   * Dernier état commandé, une entrée par tête, pour ne pas réécrire sans raison.
   *
   * Un tableau et non un booléen depuis les groupes d'émetteurs : les têtes d'une même pièce sont
   * DÉPHASÉES et n'ont donc pas le même état au même instant. Voir `stepDutyCycle`.
   */
  commanded: readonly boolean[];
}

export interface DutyCycleResult {
  /** État que chaque interrupteur doit avoir maintenant, dans l'ordre des têtes. */
  commanded: boolean[];
  /** Par tête : vrai quand il diffère du précédent. Seul ce cas justifie une écriture. */
  changed: boolean[];
  /**
   * Instant de la prochaine bascule, la PLUS PROCHE toutes têtes confondues.
   *
   * Le noyau n'arme aucune minuterie, il annonce l'échéance — et il n'en annonce qu'une : prendre
   * la plus lointaine ferait rater sa bascule à toutes les autres têtes.
   */
  wakeUpAtMs: number;
  nextState: DutyCycleState;
}

export function createDutyCycleState(): DutyCycleState {
  return { cycleStartMs: null, commanded: [] };
}

/**
 * Découpe la puissance en temps de marche, une tête à la fois, DÉPHASÉES entre elles.
 *
 * Le déphasage est la seule vraie nouveauté. Trois convecteurs commandés ensemble à 30 % tirent
 * trois fois leur puissance pendant trois minutes, puis rien pendant sept : le disjoncteur voit une
 * pointe qu'il ne verrait jamais avec trois thermostats séparés, et la pièce reçoit sa chaleur par
 * à-coups. Décalés d'un tiers de cycle, ils délivrent exactement la même énergie — c'est le même
 * `onMs` pour chacun — mais un seul à la fois tant que la demande reste sous 1/N.
 *
 * L'ancrage du cycle reste COMMUN : le déphasage se calcule à partir de lui, et donner à chaque
 * tête son propre `cycleStartMs` les laisserait dériver jusqu'à se resynchroniser par hasard.
 */
export function stepDutyCycle(
  state: DutyCycleState,
  onPercent: number,
  params: DutyCycleParams,
  nowMs: number,
  headCount = 1,
): DutyCycleResult {
  const cycleMs = Math.max(1, params.cycleMin) * 60_000;
  const heads = Math.max(1, Math.trunc(headCount));

  // Nouveau cycle : au premier appel, et chaque fois que le précédent est consommé. Une horloge
  // qui recule redémarre aussi le cycle, plutôt que de calculer sur un écoulement négatif.
  let cycleStartMs = state.cycleStartMs;
  if (cycleStartMs === null || nowMs < cycleStartMs || nowMs - cycleStartMs >= cycleMs) {
    cycleStartMs = nowMs;
  }

  const onMs = resolveOnMs(onPercent, cycleMs, params);
  const elapsed = nowMs - cycleStartMs;

  // Aux deux bornes, le déphasage n'a plus d'objet : toutes les têtes sont dans le même état pour
  // tout le cycle. Le calculer quand même produirait N échéances de réveil pour zéro bascule —
  // l'ordonnanceur serait réveillé N fois par cycle pour ne rien faire.
  const saturated = onMs <= 0 || onMs >= cycleMs;
  const offsetMs = saturated ? 0 : cycleMs / heads;

  const commanded: boolean[] = [];
  const changed: boolean[] = [];
  let wakeUpAtMs = Number.POSITIVE_INFINITY;

  for (let i = 0; i < heads; i += 1) {
    // Le temps écoulé DEPUIS le début du cycle de CETTE tête. La tête n°1 démarre avec le cycle,
    // la suivante un `offsetMs` plus tard, et ainsi de suite.
    const local = saturated ? elapsed : (((elapsed - i * offsetMs) % cycleMs) + cycleMs) % cycleMs;
    const on = local < onMs;

    // Une tête absente de l'état précédent — un radiateur qu'on vient d'ajouter au groupe — doit
    // recevoir une commande, pas hériter d'un « déjà dans le bon état » qu'on n'a jamais vérifié.
    const previous = state.commanded[i];
    commanded.push(on);
    changed.push(previous === undefined || previous !== on);

    const untilMs = saturated
      ? cycleMs - elapsed
      : (on ? onMs - local : cycleMs - local);
    wakeUpAtMs = Math.min(wakeUpAtMs, nowMs + untilMs);
  }

  return {
    commanded,
    changed,
    wakeUpAtMs,
    nextState: { cycleStartMs, commanded },
  };
}

/** Durée de marche du cycle, gardes comprises. */
function resolveOnMs(onPercent: number, cycleMs: number, params: DutyCycleParams): number {
  if (!Number.isFinite(onPercent) || onPercent <= 0) return 0;
  if (onPercent >= 1) return cycleMs;

  const raw = onPercent * cycleMs;

  // Les deux durées minimales sont bornées à la MOITIÉ du cycle.
  //
  // Elles se règlent jusqu'à 900 s alors que le cycle descend à 60 s : deux valeurs légales qui,
  // ensemble, rendaient la régulation impossible en silence. Une activation minimale supérieure au
  // cycle fait rendre 0 ici pour TOUTE demande sous 100 % — le relais ne s'enclenchait jamais, sans
  // avertissement ni trace, pendant que la tuile affichait une demande. Le défaut est symétrique :
  // une coupure minimale trop grande fige le relais ALLUMÉ en permanence.
  //
  // La moitié plutôt que le cycle entier : à la borne exacte, seule une demande de 100 % passerait
  // encore — ce qui reproduit la panne pour tout le reste. À la moitié, toute demande d'au moins
  // 50 % peut chauffer et toute demande d'au plus 50 % peut couper.
  const halfCycleMs = cycleMs / 2;
  const minOnMs = Math.min(Math.max(0, params.minActivationSec) * 1000, halfCycleMs);
  const minOffMs = Math.min(Math.max(0, params.minDeactivationSec) * 1000, halfCycleMs);

  // Trop court pour chauffer : on reste éteint tout le cycle.
  if (raw < minOnMs) return 0;

  // Trop court pour couper : on reste allumé tout le cycle.
  const off = cycleMs - raw;
  if (off < minOffMs) return cycleMs;

  return raw;
}
