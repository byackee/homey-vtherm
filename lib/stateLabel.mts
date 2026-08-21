/**
 * Priorité de `vtherm_state` (SPEC §2.3), exprimée en TABLE ORDONNÉE et non en cascade de `if`.
 *
 * Pourquoi une table : `safety` et `power` sont hors périmètre v1 (SPEC §12) mais leurs valeurs sont
 * déjà réservées dans la capability. Avec une cascade, les ajouter en v1.1 obligerait à relire tout
 * l'enchaînement pour retrouver où s'insère la nouvelle branche — l'endroit exact où l'on introduit
 * une régression de priorité. Ici, leurs lignes existent déjà, à la bonne place, avec une condition
 * constamment fausse : activer la fonctionnalité sera l'édition d'UNE ligne.
 */

import type { EffectiveState, StateContext } from './types.mjs';

export interface StateRule {
  label: EffectiveState;
  when: (ctx: StateContext) => boolean;
}

/**
 * Du plus prioritaire au moins prioritaire. L'ordre EST la spécification : ne pas réordonner sans
 * reprendre SPEC §2.3.
 */
export const STATE_RULES: readonly StateRule[] = [
  // L'appareil éteint prime sur tout : rien de ce qui suit n'a de sens s'il ne chauffe pas.
  { label: 'off', when: (ctx) => !ctx.onoff },

  // Mode central non-`auto` (et respecté par ce device) : décision du logement, pas de la pièce.
  { label: 'central', when: (ctx) => ctx.centralOverride },

  { label: 'window', when: (ctx) => ctx.windowActive },

  // v1.1 — mode sécurité (SPEC §12) : remplacer par `(ctx) => ctx.roomSensorMute`
  // une fois `safety_delay_min` implémenté. Le contexte porte déjà `roomSensorMute`.
  { label: 'safety', when: () => false },

  // v1.1 — délestage par puissance (SPEC §12) : remplacer par `(ctx) => ctx.overpowered`.
  { label: 'power', when: () => false },

  // Absence puis Activité : ces deux drapeaux peuvent être vrais ensemble, l'absence tranche.
  { label: 'away', when: (ctx) => ctx.away },
  { label: 'activity', when: (ctx) => ctx.activity },

  { label: 'heating', when: (ctx) => ctx.heating },

  // Filet : toujours vrai, ce qui rend `resolveStateLabel` total.
  { label: 'idle', when: () => true },
];

export function resolveStateLabel(ctx: StateContext): EffectiveState {
  for (const rule of STATE_RULES) {
    if (rule.when(ctx)) {
      return rule.label;
    }
  }
  // Inatteignable tant que la dernière ligne de la table est inconditionnelle ; on ne se repose
  // pas dessus pour autant, le compilateur exige un retour total.
  return 'idle';
}
