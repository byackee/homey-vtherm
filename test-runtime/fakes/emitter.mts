/**
 * Faux émetteur.
 *
 * Enregistre ce qui est réellement commandé — consigne, ouverture de vanne, état d'interrupteur —
 * et sait reproduire les états dégradés que les revues ont désignés comme dangereux : une
 * ouverture qui n'a pas pu partir, une dorsale tombée, un relais dévié à la main.
 *
 * Le dernier cas mérite d'être disponible dans une doublure : l'app ne réécrit que sur bascule,
 * donc un relais coupé par quelqu'un d'autre reste coupé indéfiniment tant que la demande est
 * saturée. Sans moyen de simuler cette divergence, le test ne peut pas exister.
 */

import type { Reading } from '../../lib/step.mjs';
import type { SyncMode } from '../../lib/types.mjs';
import type { EmitterAdapter, EmitterWriteMode } from '../../runtime/emitter.mjs';
import type { ValveBackend } from '../../runtime/valveBackend.mjs';

export class FakeEmitter implements EmitterAdapter {
  readonly setpoints: { value: number; nowMs: number }[] = [];
  readonly valves: { percent: number; nowMs: number }[] = [];
  readonly switches: { on: boolean; nowMs: number }[] = [];
  readonly roomTemps: { celsius: number; mode: SyncMode; nowMs: number }[] = [];
  readonly safeStates: number[] = [];
  detections = 0;
  backend: ValveBackend | null = null;

  readonly caps = {
    setpoint: true, valve: false, switch: false,
    externalTemp: false, calibration: false, heatingState: false,
  };

  /** L'état RÉEL du relais, qui peut diverger de ce que l'app croit avoir commandé. */
  private realHeating: boolean | null = null;
  private battery: number | null = null;

  mode: EmitterWriteMode = 'setpoint';
  available = true;
  valveUnconfirmed = false;
  switchUnconfirmed = false;
  /** Quand vrai, `applySwitch` ne commande RIEN : la liaison est orpheline, comme après un
   *  ré-appairage de la prise. C'est le cas que `switchUnconfirmed` existe pour signaler. */
  switchWriteFails = false;

  constructor(readonly deviceId = 'fake-emitter') {}

  /** Quelqu'un a coupé le convecteur à la main, ou la prise est revenue de coupure en OFF. */
  setRealHeating(on: boolean | null): void {
    this.realHeating = on;
  }

  setBattery(percent: number | null): void {
    this.battery = percent;
  }

  /**
   * Retient toutes les commandes jusqu'à ce que la fonction rendue soit appelée.
   *
   * Sert aux deux courses à l'arrêt : sans moyen de garder un pas EN VOL, ni la garde de
   * réentrance ni l'attente de `scheduler.stop()` ne sont observables — et ce sont précisément
   * les deux endroits où une écriture atterrit après la remise en état sûr.
   */
  pause(): () => void {
    let open = (): void => undefined;
    this.gate = new Promise<void>((resolve) => { open = resolve; });
    return () => {
      this.gate = null;
      open();
    };
  }

  private gate: Promise<void> | null = null;

  private async waitGate(): Promise<void> {
    const gate = this.gate;
    if (gate !== null) await gate;
  }

  async applySetpoint(v: number, nowMs: number): Promise<void> {
    await this.waitGate();
    this.setpoints.push({ value: v, nowMs });
  }

  async applyValve(percent: number, nowMs: number): Promise<void> {
    await this.waitGate();
    this.valves.push({ percent, nowMs });
  }

  readonly headCount = 1;

  readHeatingHeads(nowMs: number): readonly (Reading<boolean> | null)[] {
    return [this.readHeating(nowMs)];
  }

  async applySwitch(states: readonly (boolean | null)[], nowMs: number): Promise<void> {
    const on = states[0] ?? null;
    if (on === null) return;

    await this.waitGate();
    if (this.switchWriteFails) {
      // Rien n'est parti : ni trace de commutation, ni changement d'état réel du relais.
      this.switchUnconfirmed = true;
      return;
    }
    this.switchUnconfirmed = false;
    this.switches.push({ on, nowMs });
    this.realHeating = on;
  }

  async pushRoomTemperature(t: number, mode: SyncMode, nowMs: number): Promise<void> {
    await this.waitGate();
    this.roomTemps.push({ celsius: t, mode, nowMs });
  }

  readHeating(nowMs: number): Reading<boolean> | null {
    if (this.realHeating === null) return null;
    return { value: this.realHeating, atMs: nowMs, stale: false };
  }

  readBattery(nowMs: number): Reading<number> | null {
    if (this.battery === null) return null;
    return { value: this.battery, atMs: nowMs, stale: false };
  }

  /**
   * Jamais retenue par `pause()` : une sortie propre doit aller au bout, c'est tout son intérêt.
   *
   * Un émetteur de type interrupteur en ressort ÉTEINT, comme le fait le vrai adaptateur. Sans
   * cette fidélité-là, l'ordre « attendre le pas en vol PUIS rendre l'état sûr » ne serait
   * observable sur aucun relais, et c'est précisément ce que le test doit constater.
   */
  async restoreSafeState(userSetpoint: number): Promise<void> {
    this.safeStates.push(userSetpoint);
    if (this.mode !== 'switch') return;
    // Hors de tout tick : la remise en état sûr n'a pas d'instant de cycle à porter.
    this.switches.push({ on: false, nowMs: 0 });
    this.realHeating = false;
  }

  /**
   * Remise de la vanne à 100 % quand la dorsale disparaît. `releaseSucceeds` à faux reproduit le
   * cas qui compte : la dorsale est justement tombée, la publication ne part pas, et la vanne
   * reste figée sur sa dernière ouverture — c'est ce cas-là qui doit avertir l'utilisateur.
   */
  readonly valveReleases: number[] = [];
  releaseSucceeds = true;

  async releaseValve(nowMs: number): Promise<boolean> {
    this.valveReleases.push(nowMs);
    if (this.releaseSucceeds) this.valves.push({ percent: 100, nowMs });
    return this.releaseSucceeds;
  }

  async detect(_nowMs: number): Promise<void> {
    this.detections += 1;
  }

  invalidateDetection(): void {
    this.detections = 0;
  }

  detectionDue(_nowMs: number): boolean {
    return false;
  }

  setBackend(backend: ValveBackend | null): void {
    this.backend = backend;
  }

  /** Compté : un `onUninit` ou un `onDeleted` correct doit détruire ses liaisons. */
  destroyed = false;

  destroy(): void {
    this.destroyed = true;
  }

  get lastSwitch(): boolean | undefined {
    return this.switches[this.switches.length - 1]?.on;
  }

  get lastValve(): number | undefined {
    return this.valves[this.valves.length - 1]?.percent;
  }
}
