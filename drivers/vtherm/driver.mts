/**
 * `drivers/vtherm/driver.mts` — pairing, réparation et cartes Flow du thermostat.
 *
 * Le driver ne fait que du câblage : il liste des appareils, mémorise les identifiants choisis et
 * relaie les ordres des cartes Flow vers le participant. Les déclencheurs, eux, ne partent pas
 * d'ici : ils naissent dans `outputs.events` et transitent par `DeviceHost.triggerFlow`.
 */

import { randomUUID } from 'node:crypto';
import Homey from 'homey';

import type { Preset } from '../../lib/types.mjs';
import type { PresenceOverride } from '../../runtime/participants.mjs';
import type VThermApp from '../../app.mjs';
import VThermDevice, { SOURCE_STORE_KEYS, toPreset, type SourceKey } from './device.mjs';

/** `@types/homey` n'exporte pas `PairSession` : on le reprend de la signature qui l'emploie. */
type PairSession = Parameters<Homey.Driver['onPair']>[0];

/** Événement émis par la vue de pairing, et clé de source qu'il désigne. */
const SELECT_EVENTS: ReadonlyArray<{ event: string; key: SourceKey }> = [
  { event: 'select_room_sensor', key: 'room' },
  { event: 'select_emitter', key: 'emitter' },
  { event: 'select_outdoor', key: 'outdoor' },
  { event: 'select_window', key: 'window' },
  { event: 'select_motion', key: 'motion' },
  { event: 'select_presence', key: 'presence' },
];

const PRESENCE_OVERRIDES: readonly PresenceOverride[] = ['auto', 'home', 'away'];

interface CandidateSummary {
  id: string;
  name: string;
  zoneName: string | null;
}

export default class VThermDriver extends Homey.Driver {

  override async onInit(): Promise<void> {
    this.registerConditions();
    this.registerActions();
  }

  // --- Pairing ----------------------------------------------------------------

  override async onPair(session: PairSession): Promise<void> {
    const selection = new Map<SourceKey, string | null>();

    session.setHandler('list_candidates', async (data: unknown) => this.listCandidates(data));

    for (const { event, key } of SELECT_EVENTS) {
      session.setHandler(event, async (deviceId: unknown) => {
        selection.set(key, asDeviceId(deviceId));
        return true;
      });
    }

    // `onPairListDevices` n'est plus appelé dès qu'un `onPair` existe : la vue `add_devices`
    // interroge ce gestionnaire, et lui seul.
    session.setHandler('list_devices', async () => [await this.buildDevice(selection)]);
  }

  /**
   * Réparation : re-désigner une source dont l'identifiant a changé (risque n°12 du PLAN).
   *
   * Un appareil Zigbee2MQTT ré-appairé revient sous un autre identifiant. Sans cette voie, la seule
   * issue serait de supprimer le thermostat et de refaire le pairing — en perdant son historique,
   * ses réglages et toutes les Flows qui le nomment.
   */
  override async onRepair(session: PairSession, device: Homey.Device): Promise<void> {
    const target = device as VThermDevice;

    session.setHandler('list_candidates', async (data: unknown) => this.listCandidates(data));

    for (const { event, key } of SELECT_EVENTS) {
      session.setHandler(event, async (deviceId: unknown) => {
        await target.rebindSource(key, asDeviceId(deviceId));
        return true;
      });
    }
  }

  /** Lu du manifeste plutôt qu'écrit en dur : l'identifiant de l'app changera à la publication. */
  private get appId(): string {
    const manifest = this.homey.manifest as { id?: unknown } | undefined;
    return typeof manifest?.id === 'string' ? manifest.id : '';
  }

  private async listCandidates(data: unknown): Promise<CandidateSummary[]> {
    const capability = isRecord(data) && typeof data.capability === 'string' ? data.capability : null;
    if (capability === null) return [];

    const summaries = await this.app.hub.listDevicesByCapability(capability);
    return summaries
      // Ne jamais se proposer soi-même. Un thermostat de cette app porte `target_temperature` et
      // apparaîtrait donc dans la liste des émetteurs ; le désigner créerait une boucle où chacun
      // écrit la consigne que l'autre relit, et la vanne dériverait jusqu'à sa butée.
      .filter((summary) => !isOwnDevice(summary.driverUri, this.appId))
      .map((summary) => ({
        id: summary.id,
        name: summary.name,
        zoneName: summary.zoneName,
      }));
  }

  private async buildDevice(selection: ReadonlyMap<SourceKey, string | null>): Promise<{
    name: string;
    data: { id: string };
    store: Record<string, string | null>;
  }> {
    const roomId = selection.get('room') ?? null;
    const emitterId = selection.get('emitter') ?? null;
    if (roomId === null || emitterId === null) {
      throw new Error(this.homey.__('pair.error.incomplete'));
    }

    const store: Record<string, string | null> = {};
    for (const key of Object.keys(SOURCE_STORE_KEYS) as SourceKey[]) {
      store[SOURCE_STORE_KEYS[key]] = selection.get(key) ?? null;
    }

    return {
      name: await this.proposeName(roomId),
      // Tiré une fois, immuable : `data` est l'identité du device pour Homey et le `tickId` du
      // participant. Le dériver d'une source le rendrait mortel dès la première réparation.
      data: { id: randomUUID() },
      store,
    };
  }

  /** La pièce du capteur, à défaut son nom : l'utilisateur peut renommer juste après. */
  private async proposeName(roomId: string): Promise<string> {
    const summary = await this.app.hub.getDeviceSummary(roomId);
    return summary?.zoneName ?? summary?.name ?? this.homey.__('pair.default_name');
  }

  // --- Cartes Flow ------------------------------------------------------------

  private registerConditions(): void {
    this.homey.flow.getConditionCard('preset_is').registerRunListener(
      async (args: { device: VThermDevice; preset: string }) =>
        args.device.currentPreset() === args.preset,
    );

    this.homey.flow.getConditionCard('window_is_open').registerRunListener(
      async (args: { device: VThermDevice }) => args.device.isWindowOpen(),
    );

    this.homey.flow.getConditionCard('is_calling_for_heat').registerRunListener(
      async (args: { device: VThermDevice }) => args.device.isCallingForHeat(),
    );

    this.homey.flow.getConditionCard('someone_is_home').registerRunListener(
      async (args: { device: VThermDevice }) => args.device.isSomeoneHome(),
    );
  }

  private registerActions(): void {
    this.homey.flow.getActionCard('set_preset').registerRunListener(
      async (args: { device: VThermDevice; preset: string }) => {
        args.device.applyPreset(this.requirePreset(args.preset));
      },
    );

    this.homey.flow.getActionCard('set_preset_timed').registerRunListener(
      async (args: { device: VThermDevice; preset: string; minutes: number }) => {
        args.device.applyTimedPreset(this.requirePreset(args.preset), args.minutes);
      },
    );

    this.homey.flow.getActionCard('cancel_timed_preset').registerRunListener(
      async (args: { device: VThermDevice }) => {
        args.device.cancelTimedPreset();
      },
    );

    this.homey.flow.getActionCard('set_target_temperature').registerRunListener(
      async (args: { device: VThermDevice; temperature: number }) => {
        args.device.applyTargetTemperature(args.temperature);
      },
    );

    this.homey.flow.getActionCard('set_window_bypass').registerRunListener(
      async (args: { device: VThermDevice; bypass: string }) => {
        args.device.applyWindowBypass(args.bypass === 'on');
      },
    );

    this.homey.flow.getActionCard('force_presence').registerRunListener(
      async (args: { device: VThermDevice; presence: string }) => {
        const override = PRESENCE_OVERRIDES.find((value) => value === args.presence);
        if (override === undefined) throw new Error(`Présence inconnue : ${args.presence}`);
        args.device.applyPresenceOverride(override);
      },
    );

    this.homey.flow.getActionCard('set_tpi_parameters').registerRunListener(
      async (args: { device: VThermDevice; coef_int: number; coef_ext: number }) => {
        await args.device.applyTpiCoefficients(args.coef_int, args.coef_ext);
      },
    );
  }

  private requirePreset(value: string): Preset {
    const preset = toPreset(value);
    if (preset === null) throw new Error(`Preset inconnu : ${value}`);
    return preset;
  }

  private get app(): VThermApp {
    return this.homey.app as VThermApp;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Une vue de pairing envoie `null` pour « aucune source ». Tout le reste est traité comme tel. */
function asDeviceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Vrai quand l'appareil appartient à cette app, quel que soit son driver.
 *
 * On compare sur l'identifiant de l'app plutôt que sur celui du driver : le thermostat comme la
 * configuration centrale doivent être exclus, et un futur driver le serait automatiquement.
 * `null` (API muette sur le propriétaire) ⇒ on ne filtre pas : masquer par excès de prudence
 * priverait l'utilisateur de ses vrais appareils.
 */
function isOwnDevice(driverUri: string | null, appId: string): boolean {
  return driverUri !== null && appId.length > 0 && driverUri.includes(appId);
}
