/**
 * Fausse dorsale Zigbee2MQTT.
 *
 * Elle enregistre les quatre publications qui n'existent comme aucune capability Homey, et sait
 * les REFUSER. Ce refus n'est pas un cas exotique : la seule situation où l'app tente de rendre
 * une vanne est celle où la dorsale vient justement de tomber. Un faux qui accepte toujours ne
 * testerait que le cas où il n'y a rien à craindre.
 */

import type { ValveBackend } from '../../runtime/valveBackend.mjs';

export class FakeValveBackend implements ValveBackend {
  readonly openings: { deviceId: string; percent: number }[] = [];
  readonly externalTemps: number[] = [];
  readonly sensorSelects: ('internal' | 'external')[] = [];
  readonly calibrations: number[] = [];

  available = true;
  /** À faux, toute publication est refusée proprement — le broker ne répond plus. */
  succeeds = true;
  stopped = false;

  async setValveOpening(deviceId: string, percent: number): Promise<boolean> {
    if (!this.succeeds) return false;
    this.openings.push({ deviceId, percent });
    return true;
  }

  async setExternalTemperature(_deviceId: string, celsius: number): Promise<boolean> {
    if (!this.succeeds) return false;
    this.externalTemps.push(celsius);
    return true;
  }

  async setTemperatureSensorSelect(_deviceId: string, source: 'internal' | 'external'): Promise<boolean> {
    if (!this.succeeds) return false;
    this.sensorSelects.push(source);
    return true;
  }

  async setLocalTemperatureCalibration(_deviceId: string, offsetC: number): Promise<boolean> {
    if (!this.succeeds) return false;
    this.calibrations.push(offsetC);
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** Dernière ouverture réellement publiée : l'état PHYSIQUE de la vanne, pas l'intention. */
  get lastOpening(): number | undefined {
    return this.openings[this.openings.length - 1]?.percent;
  }
}
