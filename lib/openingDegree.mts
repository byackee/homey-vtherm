/**
 * Passage de `on_percent` à l'ouverture de vanne (SPEC §4.1, `opening_degree_algorithm.py` de VT).
 *
 * Ce n'est PAS un bornage de `on_percent × 100` entre min et max — c'est une **interpolation
 * affine** de la plage utile `[openingThreshold, 1]` de `on_percent` vers la plage mécanique
 * `[minOpeningDegree, maxOpeningDegree]` de la vanne. Les deux ne coïncident qu'aux bornes :
 * avec un seuil à 0,2 et une plage 20-80 %, `on_percent = 0,6` rend **50 %** ici, contre 60 %
 * pour un bornage. Un bornage n'utilise qu'une fraction de la course mécanique de la vanne.
 */

import type { OpeningDegreeParams } from './types.mjs';

export function computeOpeningDegree(onPercent: number, params: OpeningDegreeParams): number {
  const {
    openingThreshold, maxOpeningDegree, maxClosingDegree,
  } = params;

  // Garde : une plage inversée ou vide n'est pas une erreur de saisie à refuser. Sans elle, la
  // pente ci-dessous serait négative et la vanne se fermerait d'autant plus que la demande est
  // forte.
  //
  // On replie sur le seuil CONVERTI EN POURCENTAGE. Les deux grandeurs ne sont pas dans la même
  // unité : `openingThreshold` est une fraction 0..1 sur l'échelle de `on_percent`, les trois
  // degrés sont des pourcentages 0..100 (voir `OpeningDegreeParams`). Replier sur le seuil brut
  // donnait une ouverture minimale d'une fraction de pour cent — avec un seuil à 0,1, le minimum
  // valait 0,1 % au lieu de 10 % : le radiateur ne s'ouvrait pratiquement plus, en silence. Et
  // rien n'interdit de régler le minimum au-dessus du maximum, aucun contrôle croisé n'existant
  // côté réglages.
  const minOpeningDegree = params.minOpeningDegree >= maxOpeningDegree
    ? openingThreshold * 100
    : params.minOpeningDegree;

  if (onPercent >= openingThreshold && onPercent > 0) {
    // Seuil à 1 (ou au-delà) : la plage utile est vide, il n'y a plus rien à interpoler.
    // On rend le maximum plutôt qu'un NaN — une vanne ne sait pas quoi faire d'un NaN.
    if (openingThreshold >= 1) {
      return maxOpeningDegree;
    }
    const slope = (maxOpeningDegree - minOpeningDegree) / (1 - openingThreshold);
    return minOpeningDegree + slope * (onPercent - openingThreshold);
  }

  // Sous le seuil : `100 − maxClosingDegree`, et non zéro ni `minOpeningDegree`. Avec le défaut
  // `maxClosingDegree = 100` cela vaut bien 0, mais l'utilisateur qui abaisse ce réglage veut
  // délibérément garder un filet d'ouverture — le remplacer par un 0 en dur le lui retirerait.
  return 100 - maxClosingDegree;
}
