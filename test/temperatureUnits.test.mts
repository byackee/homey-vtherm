import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFahrenheit, valueFromHomey, valueToHomey } from '../lib/temperatureUnits.mjs';

test('les graphies du degré Fahrenheit sont reconnues, et rien d\'autre', () => {
  for (const units of ['°F', '°f', ' °F ', '° F', 'ºF', '℉', 'F', 'fahrenheit']) {
    assert.equal(isFahrenheit(units), true, String(units));
  }
  for (const units of ['°C', 'C', '℃', '%', 'W', '', null, undefined, 42]) {
    assert.equal(isFahrenheit(units), false, String(units));
  }
});

test('une mesure en °F entre en °C', () => {
  // Le cas du forum (novembre 2026) : 72,8 °F lus comme 72,8 °C, que Homey affichait « 163° ».
  assert.equal(valueFromHomey(72.8, '°F'), 22.67);
  assert.equal(valueFromHomey(32, '°F'), 0);
  assert.equal(valueFromHomey(-4, '°F'), -20);
});

test('une valeur en °C, ou sans unité connue, n\'est pas touchée', () => {
  assert.equal(valueFromHomey(21.37, '°C'), 21.37);
  assert.equal(valueFromHomey(21.37, undefined), 21.37);
  assert.equal(valueToHomey(21.37, '°C'), 21.37);
  assert.equal(valueToHomey(21.37, null), 21.37);
});

test('seul un nombre se convertit', () => {
  assert.equal(valueFromHomey(true, '°F'), true);
  assert.equal(valueFromHomey('heat', '°F'), 'heat');
  assert.equal(valueToHomey(false, '°F'), false);
});

test('une consigne au pas de 0,5 °C revient à l\'identique après l\'aller-retour', () => {
  // `readSetpoint` reconnaît ses échos par égalité stricte : un écart d'arrondi ferait prendre
  // chaque écriture de l'app pour une consigne changée sur l'appareil.
  for (let celsius = 5; celsius <= 35; celsius += 0.5) {
    const sent = valueToHomey(celsius, '°F');
    assert.equal(valueFromHomey(sent, '°F'), celsius, `${celsius} °C via ${String(sent)} °F`);
  }
});
