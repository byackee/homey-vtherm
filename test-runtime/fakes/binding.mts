/**
 * Fausse liaison vers une capability d'un appareil tiers.
 *
 * Elle existe pour reproduire les trois issues que le vrai `SourceBinding` distingue, et dont la
 * confusion est la cause racine des défauts les plus graves trouvés en revue :
 *   — l'écriture part            → `true`
 *   — l'écriture est dédupliquée → `false`   (volontaire, inoffensif)
 *   — l'écriture échoue          → elle LÈVE (l'appelant doit le voir)
 *
 * Un faux qui ne saurait pas échouer ne testerait que le beau temps, c'est-à-dire précisément ce
 * qui marchait déjà.
 */

import type { Reading } from '../../lib/step.mjs';
import { shouldWrite, type LastWrite } from '../../lib/writePolicy.mjs';
import { UnresolvedBindingError } from '../../runtime/hub.mjs';
import type { CapValue, SourceBinding, WriteRequest } from '../../runtime/hub.mjs';

export interface FakeWrite {
  value: CapValue;
  nowMs: number;
  /** Les options telles que l'appelant les a passées — c'est là que vit `maxIntervalMs`. */
  opts: WriteRequest;
}

export class FakeBinding implements SourceBinding {
  /** Toutes les écritures réellement parties, dans l'ordre. */
  readonly writes: FakeWrite[] = [];
  /**
   * Toutes les TENTATIVES, y compris celles qui lèvent ou sont dédupliquées.
   *
   * `writes` ne dit pas tout : une écriture qui échoue a quand même coûté son appel d'API, et
   * c'est ce que doit compter un test qui vérifie un espacement anti-rafale. Compter `writes`
   * laissait passer un garde-fou entièrement supprimé — sur un appareil injoignable, la liste ne
   * bougeait d'aucun côté.
   */
  readonly attempts: FakeWrite[] = [];
  destroyed = false;

  /** Prochaines écritures : `true` = part, `false` = dédupliquée, `Error` = échoue. */
  private outcome: true | false | Error = true;
  /** Quand vrai, la déduplication réelle tranche au lieu de `outcome`. Voir `policyWrites()`. */
  private policy = false;
  private lastPolicyWrite: LastWrite | null = null;
  private reading: Reading<CapValue> | null = null;

  /** Identité annoncée par l'`UnresolvedBindingError` que produit `unresolve()`. */
  deviceId = 'fake-device';
  capabilityId = 'fake-capability';

  constructor(value?: CapValue, atMs = 0) {
    if (value !== undefined) this.setReading(value, atMs);
  }

  /** Fixe ce que la source rapporte. */
  setReading(value: CapValue, atMs: number, stale = false): void {
    this.reading = { value, atMs, stale };
  }

  /** La source ne rapporte plus rien : device disparu, ou valeur non datable. */
  silence(): void {
    this.reading = null;
  }

  /** Les prochaines écritures échoueront — appareil injoignable, dorsale tombée. */
  failWrites(message = 'appareil injoignable'): void {
    this.outcome = new Error(message);
  }

  /**
   * La liaison n'a pas (ou plus) d'appareil résolu : l'écriture LÈVE, exactement comme le vrai
   * `Binding`. C'est l'état des premières secondes de l'app, et la cause de la journée sans
   * chauffage — confondu avec une déduplication, il faisait croire l'ordre parti.
   */
  unresolve(): void {
    this.outcome = new UnresolvedBindingError(this.deviceId, this.capabilityId);
  }

  /** Les prochaines écritures seront dédupliquées — cas légitime, à ne pas confondre. */
  dedupeWrites(): void {
    this.outcome = false;
  }

  acceptWrites(): void {
    this.outcome = true;
  }

  /**
   * Applique la VRAIE déduplication (`lib/writePolicy.mjs`) au lieu d'un verdict fixé d'avance.
   *
   * Sans ce mode, un faux qui accepte tout rend indétectable l'oubli d'un `maxIntervalMs` : la
   * valeur réécrite est identique à la précédente, `shouldWrite` la supprimerait, et le test
   * verrait quand même passer l'écriture. C'est exactement le trou qu'une revue a trouvé en
   * supprimant le forçage sans faire tomber un seul test.
   */
  policyWrites(): void {
    this.policy = true;
    this.outcome = true;
  }

  read(nowMs: number, freshnessMs: number): Reading<CapValue> | null {
    const reading = this.reading;
    if (reading === null) return null;
    // Péremption calculée comme le vrai hub : c'est le seuil de l'APPELANT qui tranche.
    const stale = reading.stale || (nowMs - reading.atMs > freshnessMs);
    return { ...reading, stale };
  }

  async write(value: CapValue, opts: WriteRequest): Promise<boolean> {
    this.attempts.push({ value, nowMs: opts.nowMs, opts });
    if (this.outcome instanceof Error) throw this.outcome;
    if (this.outcome === false) return false;

    if (this.policy && !shouldWrite(this.lastPolicyWrite, value, opts, opts.nowMs).write) {
      return false;
    }
    this.lastPolicyWrite = { value, atMs: opts.nowMs };

    this.writes.push({ value, nowMs: opts.nowMs, opts });
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  get lastWrite(): FakeWrite | undefined {
    return this.writes[this.writes.length - 1];
  }
}
