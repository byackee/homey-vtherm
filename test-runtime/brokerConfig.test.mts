/**
 * `configFromBody` — la fusion du formulaire de réglages et de la configuration enregistrée.
 *
 * PANNE EMPÊCHÉE : le mot de passe du broker envoyé à une machine que l'utilisateur n'a pas
 * désignée. Le champ mot de passe n'est jamais prérempli — la page ne peut pas le relire — donc il
 * est vide à chaque ouverture. Sans garde, repointer l'adresse vers un autre broker et cliquer
 * « Tester » envoyait le mot de passe du PREMIER dans un CONNECT vers le SECOND, en silence.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { FakeHomey } from './fakes/homey.mjs';

mock.module('homey', {
  defaultExport: {
    App: class { log(): void { /* rien */ } error(): void { /* rien */ } },
    Driver: class {},
    Device: class {},
  },
});

const { configFromBody } = await import('../api.mjs');

/** Un broker déjà configuré, mot de passe compris. */
function homeyWithStoredBroker(): FakeHomey {
  const homey = new FakeHomey();
  homey.settings.values.set('broker.host', '192.168.1.10');
  homey.settings.values.set('broker.port', 1883);
  homey.settings.values.set('broker.username', 'alice');
  homey.settings.values.set('broker.password', 's3cr3t');
  homey.settings.values.set('broker.baseTopic', 'zigbee2mqtt');
  return homey;
}

test('même hôte, champ vide : le mot de passe enregistré est CONSERVÉ', () => {
  const homey = homeyWithStoredBroker();
  const config = configFromBody(homey as never, { host: '192.168.1.10', password: '' });

  assert.equal(
    config.password, 's3cr3t',
    'tester sans retaper son mot de passe doit marcher : c\'est la raison d\'être de la substitution',
  );
});

test('hôte CHANGÉ, champ vide : le mot de passe enregistré n\'est PAS envoyé au nouvel hôte', () => {
  const homey = homeyWithStoredBroker();
  const config = configFromBody(homey as never, { host: '10.0.0.99', password: '' });

  assert.equal(config.host, '10.0.0.99');
  assert.equal(
    config.password, undefined,
    'le mot de passe appartient à l\'ancien broker : le substituer l\'enverrait à une machine que '
    + 'l\'utilisateur n\'a pas désignée, sans que rien ne l\'indique à l\'écran',
  );
});

test('hôte changé ET mot de passe saisi : c\'est celui du formulaire qui part', () => {
  const homey = homeyWithStoredBroker();
  const config = configFromBody(homey as never, { host: '10.0.0.99', password: 'nouveau' });

  assert.equal(config.password, 'nouveau');
});

test('hôte absent du formulaire : on reste sur l\'enregistré, mot de passe compris', () => {
  const homey = homeyWithStoredBroker();
  const config = configFromBody(homey as never, { password: '' });

  assert.equal(config.host, '192.168.1.10');
  assert.equal(config.password, 's3cr3t');
});
