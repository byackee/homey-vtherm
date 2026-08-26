import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDutyCycleState, stepDutyCycle, type DutyCycleParams } from '../lib/dutyCycle.mjs';

/** Cycle de 10 minutes, gardes à 30 s — les valeurs recommandées par VT pour un convecteur. */
const P: DutyCycleParams = { cycleMin: 10, minActivationSec: 30, minDeactivationSec: 30 };
const CYCLE = 10 * 60_000;

test('50 % : allumé la première moitié du cycle, éteint la seconde', () => {
  let s = createDutyCycleState();
  const start = stepDutyCycle(s, 0.5, P, 0);
  assert.deepEqual(start.commanded, [true]);
  assert.deepEqual(start.changed, [true]);
  assert.equal(start.wakeUpAtMs, CYCLE / 2, 'réveil à la fin de la période de marche');
  s = start.nextState;

  const middle = stepDutyCycle(s, 0.5, P, CYCLE / 2 - 1);
  assert.deepEqual(middle.commanded, [true]);

  const after = stepDutyCycle(middle.nextState, 0.5, P, CYCLE / 2);
  assert.deepEqual(after.commanded, [false]);
  assert.deepEqual(after.changed, [true]);
  assert.equal(after.wakeUpAtMs, CYCLE, 'réveil à la fin du cycle');
});

test('un nouveau cycle repart au bon moment', () => {
  let s = createDutyCycleState();
  s = stepDutyCycle(s, 0.5, P, 0).nextState;
  const next = stepDutyCycle(s, 0.5, P, CYCLE);
  assert.deepEqual(next.commanded, [true], 'le cycle suivant recommence par la marche');
  assert.equal(next.nextState.cycleStartMs, CYCLE);
});

test('puissance trop faible pour chauffer : on n\'allume pas du tout', () => {
  // 4 % de 10 minutes = 24 secondes. Allumer un convecteur pour ça ne chauffe rien et use le
  // relais ; VT ne l'allume pas, nous non plus.
  const r = stepDutyCycle(createDutyCycleState(), 0.04, P, 0);
  assert.deepEqual(r.commanded, [false]);
  assert.equal(r.wakeUpAtMs, CYCLE);
});

test('juste au-dessus du seuil d\'activation : on allume', () => {
  // 6 % de 10 minutes = 36 secondes, au-dessus des 30 s.
  const r = stepDutyCycle(createDutyCycleState(), 0.06, P, 0);
  assert.deepEqual(r.commanded, [true]);
  assert.equal(r.wakeUpAtMs, 36_000);
});

test('arrêt trop court : on laisse allumé plutôt que de faire clignoter', () => {
  // 97 % laisserait 18 secondes d'arrêt. Couper puis rallumer pour si peu use le contact sans
  // rien apporter.
  const r = stepDutyCycle(createDutyCycleState(), 0.97, P, 0);
  assert.deepEqual(r.commanded, [true]);
  assert.equal(r.wakeUpAtMs, CYCLE, 'allumé tout le cycle');
});

test('0 % et 100 % sont des cas francs', () => {
  assert.deepEqual(stepDutyCycle(createDutyCycleState(), 0, P, 0).commanded, [false]);
  assert.deepEqual(stepDutyCycle(createDutyCycleState(), 1, P, 0).commanded, [true]);
});

test('une puissance aberrante ne fait rien allumer', () => {
  assert.deepEqual(stepDutyCycle(createDutyCycleState(), Number.NaN, P, 0).commanded, [false]);
  assert.deepEqual(stepDutyCycle(createDutyCycleState(), -1, P, 0).commanded, [false]);
  assert.deepEqual(stepDutyCycle(createDutyCycleState(), 5, P, 0).commanded, [true]);
});

test('`changed` ne vaut vrai que sur une vraie bascule', () => {
  let s = createDutyCycleState();
  const a = stepDutyCycle(s, 0.5, P, 0);
  assert.deepEqual(a.changed, [true]);
  const b = stepDutyCycle(a.nextState, 0.5, P, 60_000);
  assert.deepEqual(b.commanded, [true]);
  assert.deepEqual(b.changed, [false], 'une écriture inutile use le relais autant qu\'une utile');
});

test('une horloge qui recule redémarre le cycle au lieu de calculer à l\'envers', () => {
  let s = createDutyCycleState();
  s = stepDutyCycle(s, 0.5, P, 1_000_000).nextState;
  const back = stepDutyCycle(s, 0.5, P, 500_000);
  assert.equal(back.nextState.cycleStartMs, 500_000);
  assert.deepEqual(back.commanded, [true]);
});

test('le cycle le plus court possible reste cohérent', () => {
  const short: DutyCycleParams = { cycleMin: 1, minActivationSec: 30, minDeactivationSec: 30 };
  // Sur une minute, 50 % fait 30 s de marche et 30 s d'arrêt : exactement les deux seuils.
  const r = stepDutyCycle(createDutyCycleState(), 0.5, short, 0);
  assert.deepEqual(r.commanded, [true]);
  assert.equal(r.wakeUpAtMs, 30_000);
});

test('la fonction est pure : l\'état d\'entrée n\'est pas muté', () => {
  const s = Object.freeze(createDutyCycleState());
  stepDutyCycle(s, 0.5, P, 0);
  assert.equal(s.cycleStartMs, null);
});

// --- Réglages légaux mais hostiles ------------------------------------------------

test('activation minimale plus longue que le cycle : la pièce chauffe QUAND MÊME', () => {
  // Les deux valeurs sont dans les bornes du manifeste : `cycle_min` accepte 1 (minute) et
  // `min_activation_sec` accepte 900. Ensemble, et sans bornage, `resolveOnMs` rendait 0 pour TOUTE
  // demande sous 100 % : le relais ne s'enclenchait jamais, sans avertissement, sans déclencheur de
  // Flow et sans trace, pendant que la tuile affichait une demande.
  const hostile: DutyCycleParams = { cycleMin: 1, minActivationSec: 900, minDeactivationSec: 0 };
  const cycle = 60_000;

  const half = stepDutyCycle(createDutyCycleState(), 0.5, hostile, 0);
  assert.deepEqual(
    half.commanded, [true],
    'une demande de 50 % doit pouvoir chauffer : la borne est la MOITIÉ du cycle, pas le cycle',
  );
  assert.equal(half.wakeUpAtMs, cycle / 2);

  // Sous la moitié, le renoncement reste légitime — c'est la fonction même du réglage.
  const low = stepDutyCycle(createDutyCycleState(), 0.2, hostile, 0);
  assert.deepEqual(low.commanded, [false], 'une demande trop faible ne fait toujours pas commuter');
});

test('coupure minimale plus longue que le cycle : le relais peut ENCORE s\'éteindre', () => {
  // Le défaut est symétrique : sans bornage, une coupure minimale démesurée figeait le relais
  // ALLUMÉ en permanence, par le même mécanisme et avec le même silence.
  const hostile: DutyCycleParams = { cycleMin: 1, minActivationSec: 0, minDeactivationSec: 900 };
  const cycle = 60_000;

  const half = stepDutyCycle(createDutyCycleState(), 0.5, hostile, 0);
  assert.deepEqual(half.commanded, [true]);
  const after = stepDutyCycle(half.nextState, 0.5, hostile, cycle / 2);
  assert.deepEqual(
    after.commanded, [false],
    'une demande de 50 % doit pouvoir couper à la moitié du cycle',
  );
});

// --- Plusieurs têtes : le déphasage ----------------------------------------------
//
// PANNE EMPÊCHÉE : trois convecteurs d'une même pièce commandés ENSEMBLE. Ils tirent trois fois
// leur puissance pendant trois minutes, puis rien pendant sept. Le disjoncteur voit une pointe
// qu'il ne verrait jamais avec trois thermostats séparés, et la pièce reçoit sa chaleur par
// à-coups. Décalés, ils délivrent la même énergie sans jamais se superposer tant que la demande
// reste sous 1/N.

/**
 * Les têtes allumées à cet instant d'un cycle ANCRÉ À ZÉRO.
 *
 * L'ancrage explicite est indispensable : un état neuf ouvre son cycle à `nowMs`, si bien que
 * chaque appel repartirait de l'instant zéro du cycle et que la tête n°1 serait éternellement la
 * seule allumée. Le déphasage se lit sur le temps écoulé DEPUIS un début commun, pas sur l'horloge.
 */
function onAt(nowMs: number, onPercent: number, heads: number): boolean[] {
  return stepDutyCycle({ cycleStartMs: 0, commanded: [] }, onPercent, P, nowMs, heads).commanded;
}

test('deux têtes à 30 % ne sont JAMAIS allumées en même temps', () => {
  // 30 % de 10 minutes = 3 minutes de marche, décalées de 5 minutes : aucun recouvrement possible.
  for (let t = 0; t < CYCLE; t += 10_000) {
    const on = onAt(t, 0.3, 2);
    assert.ok(
      !(on[0] === true && on[1] === true),
      `à t=${t} les deux convecteurs tirent ensemble : c'est exactement la pointe à éviter`,
    );
  }
});

test('chaque tête reçoit le MÊME temps de marche : le déphasage ne change pas l\'énergie', () => {
  const step = 1_000;
  const total = [0, 0, 0];
  for (let t = 0; t < CYCLE; t += step) {
    onAt(t, 0.3, 3).forEach((value, i) => { if (value) total[i] = (total[i] ?? 0) + step; });
  }

  assert.deepEqual(
    total,
    [0.3 * CYCLE, 0.3 * CYCLE, 0.3 * CYCLE],
    'décaler la marche ne doit rien enlever à la pièce, seulement l\'étaler',
  );
});

test('à 50 % sur trois têtes, il y a recouvrement — mais jamais les trois', () => {
  let maxEnsemble = 0;
  for (let t = 0; t < CYCLE; t += 5_000) {
    maxEnsemble = Math.max(maxEnsemble, onAt(t, 0.5, 3).filter(Boolean).length);
  }

  assert.equal(
    maxEnsemble, 2,
    'au-delà de 1/N le recouvrement est inévitable : on l\'étale, on ne le supprime pas',
  );
});

test('le réveil annoncé est la bascule la PLUS PROCHE, toutes têtes confondues', () => {
  // 30 % sur deux têtes : la n°1 coupe à 3 min, la n°2 s'allume à 5 min. La première échéance
  // est donc 3 min — annoncer celle de la n°2 ferait rater sa coupure à la n°1.
  const r = stepDutyCycle(createDutyCycleState(), 0.3, P, 0, 2);

  assert.deepEqual(r.commanded, [true, false]);
  assert.equal(r.wakeUpAtMs, 3 * 60_000);
});

test('une tête ajoutée au groupe reçoit une commande, elle n\'hérite de rien', () => {
  const deux = stepDutyCycle(createDutyCycleState(), 0.3, P, 0, 2);
  // La troisième vanne vient d'être ajoutée : l'état durable n'en sait rien.
  const trois = stepDutyCycle(deux.nextState, 0.3, P, 0, 3);

  assert.equal(
    trois.changed[2], true,
    'sans ça, un radiateur ajouté resterait dans l\'état où le hasard l\'a laissé',
  );
  assert.deepEqual(trois.changed.slice(0, 2), [false, false], 'les autres ne bougent pas pour autant');
});

test('aux deux bornes, le déphasage disparaît : rien à étaler, rien à réveiller en trop', () => {
  const eteint = stepDutyCycle(createDutyCycleState(), 0, P, 0, 3);
  assert.deepEqual(eteint.commanded, [false, false, false]);
  assert.equal(eteint.wakeUpAtMs, CYCLE, 'une seule échéance, pas trois réveils pour zéro bascule');

  const plein = stepDutyCycle(createDutyCycleState(), 1, P, 0, 3);
  assert.deepEqual(plein.commanded, [true, true, true]);
  assert.equal(plein.wakeUpAtMs, CYCLE);
});

test('une tête unique se comporte EXACTEMENT comme avant les groupes', () => {
  // La non-régression qui compte : l'immense majorité des thermostats installés n'a qu'un émetteur.
  for (const percent of [0, 0.04, 0.3, 0.5, 0.97, 1]) {
    for (const t of [0, 60_000, CYCLE / 2, CYCLE - 1]) {
      const seule = stepDutyCycle(createDutyCycleState(), percent, P, t, 1);
      const defaut = stepDutyCycle(createDutyCycleState(), percent, P, t);
      assert.deepEqual(seule, defaut, `${percent} à t=${t}`);
    }
  }
});

test('l\'échéance annoncée est toujours dans le futur, même à 7 têtes', () => {
  // `cycleMs / 7` n'est pas représentable en binaire : l'arrondi finit par rendre un `untilMs` de
  // l'ordre de 1e-10, que l'addition à `nowMs` avale entièrement. L'échéance rendue devenait alors
  // l'instant courant. Le scrutateur d'aujourd'hui ne s'y perdrait pas ; une minuterie armée sur
  // cette valeur tournerait en boucle.
  for (const heads of [1, 2, 3, 5, 6, 7, 8]) {
    let state = createDutyCycleState();
    let now = 0;
    for (let pas = 0; pas < 60; pas += 1) {
      const r = stepDutyCycle(state, 0.3, P, now, heads);
      assert.ok(
        r.wakeUpAtMs > now,
        `${heads} têtes, pas ${pas} : échéance ${r.wakeUpAtMs} pour un instant ${now}`,
      );
      state = r.nextState;
      now = r.wakeUpAtMs;
    }
  }
});
