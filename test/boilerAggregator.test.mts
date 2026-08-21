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
    affirmed: false,
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
    affirmed: false,
  };
  const result = stepBoiler(restored, 1, PARAMS, 1);
  assert.equal(result.command, true);
  assert.equal(result.affirmation, true);
});
