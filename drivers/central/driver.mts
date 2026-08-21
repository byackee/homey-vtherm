/**
 * `drivers/central/driver.mts` — pairing, réparation et cartes Flow de la configuration centrale.
 *
 * L'unicité de l'appareil central se joue d'abord ici : refuser le second au pairing évite à
 * l'utilisateur de créer un appareil qui n'aurait jamais servi qu'à se mettre indisponible.
 */

import { randomUUID } from 'node:crypto';
import Homey from 'homey';

import type VThermApp from '../../app.mjs';
import CentralDevice, { BOILER_STORE_KEY, toCentralMode } from './device.mjs';

/** `@types/homey` n'exporte pas `PairSession` : on le reprend de la signature qui l'emploie. */
type PairSession = Parameters<Homey.Driver['onPair']>[0];

interface CandidateSummary {
  id: string;
  name: string;
  zoneName: string | null;
}

export default class CentralDriver extends Homey.Driver {

  override async onInit(): Promise<void> {
    this.homey.flow.getConditionCard('boiler_is_active').registerRunListener(
      async (args: { device: CentralDevice }) => args.device.isBoilerActive(),
    );

    this.homey.flow.getConditionCard('central_mode_is').registerRunListener(
      async (args: { device: CentralDevice; mode: string }) => args.device.currentMode() === args.mode,
    );

    this.homey.flow.getActionCard('set_central_mode').registerRunListener(
      async (args: { device: CentralDevice; mode: string }) => {
        const mode = toCentralMode(args.mode);
        if (mode === null) throw new Error(`Mode central inconnu : ${args.mode}`);
        await args.device.applyCentralMode(mode);
      },
    );
  }

  // --- Pairing ----------------------------------------------------------------

  override async onPair(session: PairSession): Promise<void> {
    let boilerId: string | null = null;

    session.setHandler('list_candidates', async (data: unknown) => this.listCandidates(data));

    session.setHandler('select_boiler', async (deviceId: unknown) => {
      boilerId = asDeviceId(deviceId);
      return true;
    });

    session.setHandler('list_devices', async () => {
      // Premier des deux verrous d'unicité (SPEC §9.2). Le second est dans `app.registerCentral`,
      // parce qu'une restauration de sauvegarde n'emprunte pas le chemin du pairing.
      if (this.getDevices().length > 0) {
        throw new Error(this.homey.__('device.central_duplicate'));
      }

      return [{
        name: this.homey.__('pair.central_name'),
        data: { id: randomUUID() },
        store: { [BOILER_STORE_KEY]: boilerId },
      }];
    });
  }

  /** Re-désigne le relais de chaudière quand il a changé d'identifiant (risque n°12 du PLAN). */
  override async onRepair(session: PairSession, device: Homey.Device): Promise<void> {
    const target = device as CentralDevice;

    session.setHandler('list_candidates', async (data: unknown) => this.listCandidates(data));

    session.setHandler('select_boiler', async (deviceId: unknown) => {
      await target.rebindBoiler(asDeviceId(deviceId));
      return true;
    });
  }

  private async listCandidates(data: unknown): Promise<CandidateSummary[]> {
    const capability = isRecord(data) && typeof data.capability === 'string' ? data.capability : null;
    if (capability === null) return [];

    const summaries = await this.app.hub.listDevicesByCapability(capability);
    return summaries.map((summary) => ({
      id: summary.id,
      name: summary.name,
      zoneName: summary.zoneName,
    }));
  }

  private get app(): VThermApp {
    return this.homey.app as VThermApp;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asDeviceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
