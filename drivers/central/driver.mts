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

const DRIVER_TAG = 'central';

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

    // Une erreur JavaScript dans une vue de pairing est autrement invisible : la page reste
    // blanche, et une app installée par CLI n'a pas de log lisible. La vue nous les renvoie ici.
    session.setHandler('viewLog', async (message: unknown) => {
      this.app.trace(`[${DRIVER_TAG}] vue : ${String(message)}`);
      return true;
    });

    // Les mêmes vues servent au pairing et à la réparation. Sans cette réponse, la vue
    // terminale proposerait « créer l'appareil » pendant une réparation, où l'appareil existe déjà.
    session.setHandler('pair_mode', async () => 'pair');

    session.setHandler('list_candidates', async (data: unknown) => this.listCandidates(data));

    session.setHandler('select_boiler', async (deviceId: unknown) => {
      boilerId = asDeviceId(deviceId);
      return true;
    });

    // La vue crée l'appareil elle-même. Naviguer d'une vue custom vers le template
    // `add_devices` ferme l'assistant sans rien créer sur Homey Pro 2023 ; les apps publiées
    // appellent `Homey.createDevice()` puis `Homey.done()` depuis la vue, c'est ce qu'on fait.
    session.setHandler('build_device', async () => {
      // Premier des deux verrous d'unicité (SPEC §9.2). Le second est dans `app.registerCentral`,
      // parce qu'une restauration de sauvegarde n'emprunte pas le chemin du pairing.
      if (this.getDevices().length > 0) {
        throw new Error(this.homey.__('device.central_duplicate'));
      }

      return {
        name: this.homey.__('pair.central_name'),
        data: { id: randomUUID() },
        store: { [BOILER_STORE_KEY]: boilerId },
      };
    });
  }

  /** Re-désigne le relais de chaudière quand il a changé d'identifiant (risque n°12 du PLAN). */
  override async onRepair(session: PairSession, device: Homey.Device): Promise<void> {
    const target = device as CentralDevice;

    // Une erreur JavaScript dans une vue de pairing est autrement invisible : la page reste
    // blanche, et une app installée par CLI n'a pas de log lisible. La vue nous les renvoie ici.
    session.setHandler('viewLog', async (message: unknown) => {
      this.app.trace(`[${DRIVER_TAG}] vue : ${String(message)}`);
      return true;
    });

    session.setHandler('pair_mode', async () => 'repair');

    // La vue ne devrait jamais l'appeler en réparation — mais si elle le fait, mieux vaut un
    // message qu'un « no such event » opaque affiché à l'utilisateur.
    session.setHandler('build_device', async () => {
      throw new Error(this.homey.__('pair.error.repair_no_create'));
    });

    session.setHandler('list_candidates', async (data: unknown) => this.listCandidates(data));

    session.setHandler('select_boiler', async (deviceId: unknown) => {
      await target.rebindBoiler(asDeviceId(deviceId));
      return true;
    });
  }

  private async listCandidates(data: unknown): Promise<CandidateSummary[]> {
    const capability = isRecord(data) && typeof data.capability === 'string' ? data.capability : null;
    if (capability === null) {
      this.app.trace(`[${DRIVER_TAG}] list_candidates SANS capability : ${JSON.stringify(data)}`);
      return [];
    }
    if (!this.app.hub.connected) {
      // Cause n°1 d'une liste vide, et la seule qui ne vienne pas de la vue : sans le hub, l'app
      // ne voit aucun appareil de l'utilisateur. Mieux vaut le dire que rendre un tableau vide.
      this.app.trace(`[${DRIVER_TAG}] list_candidates(${capability}) REFUSÉ : hub non connecté`);
      throw new Error(this.homey.__('pair.error.no_api'));
    }

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
