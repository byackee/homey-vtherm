import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOpeningDegree } from '../lib/openingDegree.mjs';
import {
  DEFAULT_MAX_CLOSING_DEGREE, DEFAULT_MAX_OPENING_DEGREE,
  DEFAULT_MIN_OPENING_DEGREE, DEFAULT_OPENING_THRESHOLD,
} from '../lib/constants.mjs';
import type { OpeningDegreeParams } from '../lib/types.mjs';

/** Plage volontairement resserrée : c'est là que l'interpolation se distingue d'un bornage. */
const PARAMS: OpeningDegreeParams = {
  openingThreshold: 0.2, minOpeningDegree: 20, maxOpeningDegree: 80, maxClosingDegree: 100,
};

const DEFAULTS: OpeningDegreeParams = {
  openingThreshold: DEFAULT_OPENING_THRESHOLD,
  minOpeningDegree: DEFAULT_MIN_OPENING_DEGREE,
  maxOpeningDegree: DEFAULT_MAX_OPENING_DEGREE,
  maxClosingDegree: DEFAULT_MAX_CLOSING_DEGREE,
};

/** L'interpolation passe par une division : on compare à la tolérance du flottant. */
function approx(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `attendu ~${expected}, obtenu ${actual}`);
}

// --- Interpolation ------------------------------------------------------------

test('borne basse : au seuil exact, la vanne est à son ouverture minimale', () => {
  approx(computeOpeningDegree(0.2, PARAMS), 20);
});

test('borne haute : à pleine puissance, la vanne est à son ouverture maximale', () => {
  approx(computeOpeningDegree(1, PARAMS), 80);
});

test('milieu de plage : interpolation, et non bornage', () => {
  // pente = (80 − 20) / (1 − 0,2) = 75 ; 20 + 75 × (0,6 − 0,2) = 50.
  // Un bornage de on_percent × 100 aurait rendu 60 : il n'utilise qu'une fraction de la course.
  approx(computeOpeningDegree(0.6, PARAMS), 50);
  assert.notEqual(Math.round(computeOpeningDegree(0.6, PARAMS)), 60);
});

test('la sortie est strictement croissante sur toute la plage utile', () => {
  let previous = -Infinity;
  for (let i = 2; i <= 10; i += 1) {
    const value = computeOpeningDegree(i / 10, PARAMS);
    assert.ok(value > previous, `on_percent ${i / 10} : ${value} <= ${previous}`);
    previous = value;
  }
});

test('réglages par défaut : la sortie vaut simplement on_percent × 100', () => {
  // Seuil 0, plage 0-100 : l'interpolation dégénère en identité. C'est le cas nominal.
  approx(computeOpeningDegree(0.37, DEFAULTS), 37);
  approx(computeOpeningDegree(1, DEFAULTS), 100);
});

// --- Sous le seuil --------------------------------------------------------------

test('sous le seuil : 100 − maxClosingDegree, et non zéro', () => {
  const params: OpeningDegreeParams = { ...PARAMS, maxClosingDegree: 90 };
  approx(computeOpeningDegree(0.1, params), 10);
  approx(computeOpeningDegree(0, params), 10);
  // Le piège : ni zéro, ni minOpeningDegree (20). L'utilisateur qui abaisse maxClosingDegree
  // veut délibérément garder un filet d'ouverture.
  assert.notEqual(computeOpeningDegree(0.1, params), 0);
  assert.notEqual(computeOpeningDegree(0.1, params), 20);
});

test('sous le seuil avec maxClosingDegree à 100 : vanne fermée', () => {
  approx(computeOpeningDegree(0.1, PARAMS), 0);
});

test('on_percent nul avec un seuil nul : vanne fermée malgré `>= seuil`', () => {
  // La condition VT est `on_percent >= seuil ET on_percent > 0` : le second terme existe
  // exactement pour ce cas, sans quoi une demande nulle ouvrirait à minOpeningDegree.
  approx(computeOpeningDegree(0, DEFAULTS), 0);
  approx(computeOpeningDegree(0, { ...DEFAULTS, minOpeningDegree: 30, maxOpeningDegree: 90 }), 0);
});

// --- Gardes ----------------------------------------------------------------------

test('garde VT : min >= max ramène min au seuil sans inverser la pente', () => {
  const params: OpeningDegreeParams = { ...PARAMS, minOpeningDegree: 90, maxOpeningDegree: 80 };
  // Sans la garde, la pente serait négative : plus la demande monte, plus la vanne se ferme.
  assert.ok(computeOpeningDegree(1, params) > computeOpeningDegree(0.6, params));
  approx(computeOpeningDegree(1, params), 80);
});

test('garde : un seuil à 1 ne produit jamais de NaN', () => {
  const params: OpeningDegreeParams = { ...PARAMS, openingThreshold: 1 };
  const value = computeOpeningDegree(1, params);
  assert.ok(Number.isFinite(value), `valeur finie attendue, obtenu ${value}`);
  approx(value, 80);
});

test('la sortie reste dans 0-100 sur tout le domaine', () => {
  for (const params of [PARAMS, DEFAULTS, { ...PARAMS, maxClosingDegree: 0 }]) {
    for (let i = 0; i <= 20; i += 1) {
      const value = computeOpeningDegree(i / 20, params);
      assert.ok(value >= 0 && value <= 100, `${value} hors bornes`);
    }
  }
});
