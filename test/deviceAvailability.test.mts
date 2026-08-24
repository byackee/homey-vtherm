/**
 * Garde d'un invariant du SDK que ni le compilateur ni un test unitaire ne peuvent exprimer.
 *
 * Doc Athom, Devices › Availability : « When a device is marked as unavailable, all capabilities
 * and Flow actions will be prevented. » Une écriture de capability placée avant `setAvailable()`
 * part donc dans le vide sur un appareil marqué indisponible — et les deux drivers le marquent
 * ainsi (thermostat sans émetteur, second appareil central), un état qui survit au redémarrage.
 *
 * `drivers/*​/device.mts` n'a aucun banc d'essai : instancier un `Homey.Device` n'est pas possible
 * ici. Cette vérification lit donc la source, faute de mieux — mais elle mord, ce qu'un test
 * inatteignable ne ferait pas.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Le corps d'`onInit`, commentaires retirés pour ne pas confondre une mention et un appel. */
function onInitBody(source: string): string {
  const start = source.indexOf('override async onInit(');
  assert.ok(start >= 0, 'onInit introuvable');

  // Jusqu'à l'accolade fermante de la méthode, à l'indentation de deux espaces.
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, 'fin d\'onInit introuvable');

  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

for (const driver of ['vtherm', 'central']) {
  test(`${driver} : aucune écriture de capability avant setAvailable() dans onInit`, () => {
    const body = onInitBody(readFileSync(`drivers/${driver}/device.mts`, 'utf8'));

    const available = body.indexOf('this.setAvailable()');
    assert.ok(available >= 0, 'setAvailable() absent d\'onInit');

    const write = body.indexOf('this.setCapabilityValue(');
    if (write < 0) return; // aucun écriture : rien à ordonner.

    assert.ok(
      write > available,
      'une écriture de capability précède `setAvailable()` : sur un appareil marqué indisponible '
      + '— ce que fait ce même `onInit` plus haut, et l\'état survit au redémarrage — elle est '
      + 'silencieusement empêchée par Homey',
    );
  });
}
