import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoilerState, stepBoiler } from '../lib/boilerAggregator.mjs';
import type { BoilerParams, BoilerState } from '../lib/types.mjs';
import { BOILER_MIN_DWELL_FLOOR_SEC } from '../lib/constants.mjs';

const PARAMS: BoilerParams = {
  threshold: 1, activationDelaySec: 0, minDwellSec: 60, keepAliveSec: 0,
};

const DWELL_MS = BOILER_MIN_DWELL_FLOOR_SEC * 1000;

test('première commande immédiate (pas d\'attente du garde-fou)', () => {
  const result = stepBoiler(createBoilerState(), 1, PARAMS, 0);
  assert.equal(result.command, true);
  assert.equal(result.nextState.commanded, true);
  assert.equal(result.nextState.lastChangeMs, 0);
});

test('allumage après le délai d\'activation', () => {
  const params: BoilerParams = { ...PARAMS, activationDelaySec: 30 };
  let state = createBoilerState();

  let result = stepBoiler(state, 1, params, 0);
  // Le tout premier pas AFFIRME l'arrêt : au démarrage on ignore l'état réel du relais, et
  // l'affirmer éteint est toujours sûr. Ce n'est pas une commutation — `lastChangeMs` reste nul,
  // et l'appelant ne doit pas en faire une carte Flow.
  assert.equal(result.command, false);
  assert.equal(result.affirmation, true);
  assert.equal(result.nextState.lastChangeMs, null);
  state = result.nextState;

  result = stepBoiler(state, 1, params, 29_999);
  assert.equal(result.command, null);
  state = result.nextState;

  result = stepBoiler(state, 1, params, 30_000);
  assert.equal(result.command, true);
  assert.equal(result.nextState.commanded, true);
});

test('command: null quand rien ne change', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));

  const result = stepBoiler(state, 1, PARAMS, 5_000); // toujours en demande, déjà commandé
  assert.equal(result.command, null);
});

// --- Garde-fou anti-pulsation : ALLUMAGE seulement ----------------------------

test('une extinction n\'est jamais différée, même une seconde après un allumage', () => {
  // C'est le point de sécurité de la SPEC §9.2. Différer la coupure quand toutes les vannes
  // viennent de se fermer, c'est faire tourner la chaudière sur un circuit fermé.
  let state = createBoilerState();
  const on = stepBoiler(state, 1, PARAMS, 0);
  assert.equal(on.command, true);
  state = on.nextState;

  const off = stepBoiler(state, 0, PARAMS, 1_000); // une seconde plus tard
  assert.equal(off.command, false);
  assert.equal(off.nextState.commanded, false);
});

test('un nouvel allumage attend le garde-fou après une extinction', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0)); // ON à t=0
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 5_000)); // OFF immédiat à t=5 s
  assert.equal(state.commanded, false);
  assert.equal(state.lastChangeMs, 5_000);

  let result = stepBoiler(state, 1, PARAMS, 10_000); // la demande revient tout de suite
  assert.equal(result.command, null); // refusé : moins de 60 s après la dernière commutation
  assert.equal(result.nextState.commanded, false);
  state = result.nextState;

  result = stepBoiler(state, 1, PARAMS, 5_000 + DWELL_MS - 1);
  assert.equal(result.command, null);
  state = result.nextState;

  result = stepBoiler(state, 1, PARAMS, 5_000 + DWELL_MS);
  assert.equal(result.command, true);
  assert.equal(result.nextState.commanded, true);
});

test('allumage différé annulé si la demande ne tient plus à l\'échéance', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 5_000)); // OFF immédiat

  let result = stepBoiler(state, 1, PARAMS, 10_000); // demande revenue, allumage bloqué
  assert.equal(result.command, null);
  state = result.nextState;

  result = stepBoiler(state, 0, PARAMS, 20_000); // la demande retombe avant l'échéance
  assert.equal(result.command, null); // déjà éteint : rien à commuter
  state = result.nextState;

  result = stepBoiler(state, 0, PARAMS, 5_000 + DWELL_MS); // à l'échéance : rien ne se passe
  assert.equal(result.command, null);
  assert.equal(result.nextState.commanded, false);
});

test('rafale : jamais deux ALLUMAGES en moins de 60 s, extinctions jamais différées', () => {
  let state: BoilerState = createBoilerState();
  const onTimestamps: number[] = [];
  const offTimestamps: number[] = [];
  const demandDropTimestamps: number[] = [];

  // Dix bascules de nb_actifs en deux secondes (200 ms d'écart) — le scénario réel de deux Flows
  // opposés déclenchés sur le même événement.
  for (let i = 0; i < 10; i += 1) {
    const nowMs = i * 200;
    const nbActive = i % 2 === 0 ? 1 : 0;
    const wasCommanded = state.commanded;
    const result = stepBoiler(state, nbActive, PARAMS, nowMs);

    if (nbActive === 0 && wasCommanded) {
      demandDropTimestamps.push(nowMs);
    }
    if (result.command === true) {
      onTimestamps.push(nowMs);
    } else if (result.command === false) {
      offTimestamps.push(nowMs);
    }
    state = result.nextState;
  }

  // Un seul allumage a pu passer : le suivant est à plus de 60 s.
  assert.equal(onTimestamps.length, 1);
  assert.equal(onTimestamps[0], 0);
  for (let i = 1; i < onTimestamps.length; i += 1) {
    const prev = onTimestamps[i - 1] as number;
    const cur = onTimestamps[i] as number;
    assert.ok(cur - prev >= DWELL_MS, `deux allumages à ${prev} et ${cur}`);
  }

  // Chaque chute de demande sur une chaudière allumée a produit une extinction au même instant.
  assert.deepStrictEqual(offTimestamps, demandDropTimestamps);
  assert.ok(offTimestamps.length > 0, 'le scénario doit contenir au moins une extinction');
});

// --- Keep-alive ----------------------------------------------------------------

test('keep-alive périodique qui ne décale pas lastChangeMs', () => {
  const params: BoilerParams = { ...PARAMS, keepAliveSec: 10 };
  let state = createBoilerState();

  let result = stepBoiler(state, 1, params, 0); // allumage
  assert.equal(result.command, true);
  assert.equal(result.keepAlive, false);
  state = result.nextState;
  const { lastChangeMs } = state;

  result = stepBoiler(state, 1, params, 5_000); // avant le keep-alive
  assert.equal(result.command, null);
  state = result.nextState;

  result = stepBoiler(state, 1, params, 10_000); // premier keep-alive
  assert.equal(result.command, true);
  assert.equal(result.keepAlive, true);
  assert.equal(result.nextState.lastChangeMs, lastChangeMs); // jamais décalé
  state = result.nextState;

  result = stepBoiler(state, 1, params, 20_000); // second keep-alive
  assert.equal(result.command, true);
  assert.equal(result.keepAlive, true);
  assert.equal(result.nextState.lastChangeMs, lastChangeMs);
});

test('pas de keep-alive quand keepAliveSec vaut 0', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));

  const result = stepBoiler(state, 1, PARAMS, 1_000_000);
  assert.equal(result.command, null);
  assert.equal(result.keepAlive, false);
});

test('réaffirmation après redémarrage : un état restauré est réécrit une fois', () => {
  // Scénario réel : l'app s'arrête chaudière allumée, quelqu'un coupe le relais à la main, l'app
  // redémarre et relit son état. Sans réaffirmation, `stepBoiler` ne renverrait aucune commande et
  // la maison resterait froide avec une app persuadée d'avoir allumé.
  const restored: BoilerState = {
    commanded: true, lastChangeMs: 0, pendingSinceMs: null, lastKeepAliveMs: null,
    affirmed: false, lastDivergenceFixMs: null, lastForcedOffMs: null,
  };

  const first = stepBoiler(restored, 1, PARAMS, 1_000);
  assert.equal(first.command, true);
  assert.equal(first.affirmation, true);
  assert.equal(first.keepAlive, false);
  // Une affirmation n'est pas une commutation : elle ne repousse pas le garde-fou.
  assert.equal(first.nextState.lastChangeMs, 0);
  assert.equal(first.nextState.affirmed, true);

  // Et elle ne se répète pas au pas suivant.
  const second = stepBoiler(first.nextState, 1, PARAMS, 2_000);
  assert.equal(second.command, null);
  assert.equal(second.affirmation, false);
});

test('la réaffirmation n\'est pas soumise au garde-fou anti-pulsation', () => {
  // Un allumage normal devrait attendre 60 s après la dernière commutation. Une réaffirmation, non :
  // elle ne change pas d'état, elle remet le relais en accord avec l'état déjà décidé.
  const restored: BoilerState = {
    commanded: true, lastChangeMs: 0, pendingSinceMs: null, lastKeepAliveMs: null,
    affirmed: false, lastDivergenceFixMs: null, lastForcedOffMs: null,
  };
  const result = stepBoiler(restored, 1, PARAMS, 1);
  assert.equal(result.command, true);
  assert.equal(result.affirmation, true);
});

// --- Réaffirmation sur divergence du relais ----------------------------------
//
// PANNE EMPÊCHÉE : le modèle dit ALLUMÉE, la maison reste froide. `stepBoiler` ne produit un
// ordre que sur CHANGEMENT et `keepAliveSec` vaut zéro par défaut : un ordre avalé en route —
// trame Zigbee perdue, prise revenue sur son `power_on_behavior`, quota d'API atteint pendant une
// rafale de changements de consigne, bascule à la main — n'était jamais réémis.

test('relais trouvé ÉTEINT alors qu\'il est commandé allumé : réaffirmé', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0)); // allumage
  assert.equal(state.commanded, true);

  // Le garde-fou est écoulé : la correction peut partir.
  const result = stepBoiler(state, 1, PARAMS, DWELL_MS, false);
  assert.equal(result.command, true);
  assert.equal(result.divergence, true);
  assert.equal(result.affirmation, false, 'la réaffirmation de démarrage est un autre cas');
  assert.equal(result.keepAlive, false);
  // Une correction n'est pas une commutation : elle ne repousse pas le garde-fou.
  assert.equal(result.nextState.lastChangeMs, 0);
  assert.equal(result.nextState.commanded, true);
});

test('relais trouvé ALLUMÉ alors qu\'il est commandé éteint : coupé SANS attendre', () => {
  // L'asymétrie du garde-fou est reconduite ici, et pour la même raison qu'à la commutation :
  // une chaudière qui tourne alors que rien ne la demande chauffe un circuit fermé.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));   // allumée
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 1_000)); // éteinte à 1 s
  assert.equal(state.commanded, false);
  assert.equal(state.lastChangeMs, 1_000);

  const result = stepBoiler(state, 0, PARAMS, 1_001, true);
  assert.equal(result.command, false);
  assert.equal(result.divergence, true);
  assert.equal(result.nextState.lastChangeMs, 1_000, 'la correction ne compte pas comme commutation');
});

test('la correction vers l\'ALLUMAGE attend le garde-fou anti-pulsation', () => {
  // Un relais qui diverge juste après une commutation ne doit pas être rallumé aussitôt : ce
  // serait fabriquer le court-cycle que le garde-fou existe pour empêcher.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));

  const tooSoon = stepBoiler(state, 1, PARAMS, DWELL_MS - 1, false);
  assert.equal(tooSoon.command, null);
  assert.equal(tooSoon.divergence, false);

  const allowed = stepBoiler(state, 1, PARAMS, DWELL_MS, false);
  assert.equal(allowed.command, true);
  assert.equal(allowed.divergence, true);
});

test('un relais en accord avec l\'état commandé n\'est pas réécrit', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));

  const result = stepBoiler(state, 1, PARAMS, DWELL_MS, true);
  assert.equal(result.command, null, 'aucune écriture inutile : un contacteur s\'use');
  assert.equal(result.divergence, false);
});

test('relais illisible : exactement le comportement d\'avant la lecture en retour', () => {
  // `null` n'est pas « éteint ». On ne corrige que ce qu'on a VU.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));

  const result = stepBoiler(state, 1, PARAMS, DWELL_MS, null);
  assert.equal(result.command, null);
  assert.equal(result.divergence, false);
});

test('un relais resté ALLUMÉ pendant une attente d\'allumage n\'est PAS coupé', () => {
  // La correction ne doit pas fabriquer le court-cycle qu'elle prétend éviter. Ici la demande est
  // là et l'app s'apprête à allumer : couper le relais reviendrait à éteindre une chaudière qu'on
  // rallume trente secondes plus tard.
  const params: BoilerParams = { ...PARAMS, activationDelaySec: 30 };
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, params, 0));    // affirme l'arrêt
  ({ nextState: state } = stepBoiler(state, 1, params, 1_000)); // toujours en attente

  const waiting = stepBoiler(state, 1, params, 2_000, true);
  assert.equal(waiting.command, null, 'on laisse le relais tranquille');
  assert.equal(waiting.divergence, false);
  assert.equal(waiting.nextState.pendingSinceMs, 0, 'l\'attente d\'activation n\'est pas remise à zéro');

  // Et l'allumage attendu remet le modèle d'accord avec le relais, sans commutation physique.
  const ignition = stepBoiler(waiting.nextState, 1, params, 30_000, true);
  assert.equal(ignition.command, true);
  assert.equal(ignition.divergence, false, 'c\'est une vraie commutation, pas une correction');
});

test('un relais resté ALLUMÉ sans aucune demande est coupé, garde-fou ou pas', () => {
  // Le cas qui justifie l'asymétrie : une chaudière qui tourne alors que toutes les vannes sont
  // fermées chauffe un circuit fermé.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 1_000));
  assert.equal(state.commanded, false);

  const result = stepBoiler(state, 0, PARAMS, 2_000, true);
  assert.equal(result.command, false);
  assert.equal(result.divergence, true);
});

// --- Traçabilité de l'attente ------------------------------------------------

test('`ignitionBlocked` distingue une attente du garde-fou d\'une absence de demande', () => {
  // C'est le symptôme rapporté : « je change ma consigne plusieurs fois de suite et la chaudière
  // ne change pas de statut ». L'attente est légitime, mais elle était parfaitement muette.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));      // ON
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 5_000));  // OFF immédiat

  const refused = stepBoiler(state, 1, PARAMS, 10_000);
  assert.equal(refused.command, null);
  assert.equal(refused.ignitionBlocked, true);
  assert.equal(refused.nextState.commanded, false);

  // À l'expiration, l'allumage part et le signal retombe.
  const allowed = stepBoiler(refused.nextState, 1, PARAMS, 5_000 + DWELL_MS);
  assert.equal(allowed.command, true);
  assert.equal(allowed.ignitionBlocked, false);
});

test('`ignitionBlocked` reste faux quand c\'est le délai d\'activation qui retient', () => {
  // Deux attentes distinctes : confondre les deux ferait tracer « garde-fou anti-pulsation » là où
  // l'utilisateur a lui-même réglé un délai d'activation.
  const params: BoilerParams = { ...PARAMS, activationDelaySec: 30 };
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, params, 0));

  const pending = stepBoiler(state, 1, params, 10_000);
  assert.equal(pending.command, null);
  assert.equal(pending.ignitionBlocked, false);
});

test('un relais qui réannonce sa divergence en boucle n\'est pas corrigé en rafale', () => {
  // Le quota d'API Athom se déclenche en production après quelques dizaines d'appels rapprochés,
  // et il emporterait toutes les autres écritures de l'app avec lui. Une correction qui n'a pas
  // pris n'est pas rattrapée en la répétant plus vite.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));

  const first = stepBoiler(state, 1, PARAMS, DWELL_MS, false);
  assert.equal(first.divergence, true);

  const tooSoon = stepBoiler(first.nextState, 1, PARAMS, DWELL_MS + 1_000, false);
  assert.equal(tooSoon.command, null, 'une seconde correction une seconde plus tard ne part pas');

  const retry = stepBoiler(first.nextState, 1, PARAMS, DWELL_MS + 30_000, false);
  assert.equal(retry.command, true, 'mais elle est retentée, sinon un relais lent resterait faux');
  assert.equal(retry.divergence, true);
});

test('une vraie commutation rend sa chance à la correction', () => {
  // Le compteur borne les RETENTATIVES d'un même ordre. Après une commutation, l'ordre est neuf :
  // le retenir ferait perdre la première correction de celui-ci.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, DWELL_MS, false)); // correction à 60 s
  assert.equal(state.lastDivergenceFixMs, DWELL_MS);

  // Coupure : immédiate, jamais différée.
  const off = stepBoiler(state, 0, PARAMS, DWELL_MS + 1_000);
  assert.equal(off.command, false);
  assert.equal(off.nextState.lastDivergenceFixMs, null);

  // Le relais n'obéit pas : on le recoupe sans attendre les 30 s de l'espacement.
  const fix = stepBoiler(off.nextState, 0, PARAMS, DWELL_MS + 2_000, true);
  assert.equal(fix.command, false);
  assert.equal(fix.divergence, true);
});

// --- Une coupure imposée arme le garde-fou -----------------------------------

test('couper un relais resté allumé interdit un rallumage dans la minute', () => {
  // RÉGRESSION EMPÊCHÉE. La correction ne change pas l'état commandé, donc elle ne touche pas
  // `lastChangeMs` — c'est ce qui la distingue d'une commutation partout ailleurs. Mais celle-ci
  // arrête un brûleur qui TOURNAIT. Sans marque propre, une coupure imposée à t suivie d'une
  // demande à t+1 s rallumait une seconde après avoir coupé.
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 0));           // ON
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 200_000));     // OFF commandé

  // Le relais n'a pas obéi et brûle toujours : on le coupe pour de bon, bien plus tard.
  const forced = stepBoiler(state, 0, PARAMS, 400_000, true);
  assert.equal(forced.command, false);
  assert.equal(forced.divergence, true);
  assert.equal(forced.nextState.lastForcedOffMs, 400_000);
  assert.equal(forced.nextState.lastChangeMs, 200_000, 'l\'état commandé, lui, n\'a pas bougé');

  // Une demande une seconde plus tard ne doit PAS rallumer.
  const tooSoon = stepBoiler(forced.nextState, 1, PARAMS, 401_000);
  assert.equal(tooSoon.command, null);
  assert.equal(tooSoon.ignitionBlocked, true);

  const allowed = stepBoiler(forced.nextState, 1, PARAMS, 400_000 + DWELL_MS);
  assert.equal(allowed.command, true, 'et le garde-fou expiré, elle rallume');
});

test('sur une installation neuve aussi, la coupure imposée arme le garde-fou', () => {
  // `lastChangeMs === null` exempte du garde-fou. Sans marque propre, le cas le plus exposé — un
  // relais trouvé allumé au tout premier pas — n'était protégé par rien du tout.
  const state = createBoilerState();
  const forced = stepBoiler(state, 0, PARAMS, 1_000, true);
  assert.equal(forced.command, false);
  assert.equal(forced.nextState.lastChangeMs, null);
  assert.equal(forced.nextState.lastForcedOffMs, 1_000);

  const tooSoon = stepBoiler(forced.nextState, 1, PARAMS, 2_000);
  assert.equal(tooSoon.command, null, 'aucune exemption : un brûleur vient d\'être arrêté');
  assert.equal(tooSoon.ignitionBlocked, true);
});

test('la correction vers l\'allumage attend elle aussi la coupure imposée', () => {
  let state = createBoilerState();
  ({ nextState: state } = stepBoiler(state, 0, PARAMS, 1_000, true)); // coupure imposée
  ({ nextState: state } = stepBoiler(state, 1, PARAMS, 1_000 + DWELL_MS)); // allumage à l'expiration
  assert.equal(state.commanded, true);

  // Le relais n'a pas suivi. La correction ne doit pas non plus court-circuiter le garde-fou.
  const tooSoon = stepBoiler(state, 1, PARAMS, 1_000 + DWELL_MS + 1_000, false);
  assert.equal(tooSoon.command, null);
});
