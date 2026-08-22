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
import VThermDevice, { SOURCE_STORE_KEYS, toPreset, type SourceKey, SOURCE_CAPABILITIES } from './device.mjs';

/** `@types/homey` n'exporte pas `PairSession` : on le reprend de la signature qui l'emploie. */
type PairSession = Parameters<Homey.Driver['onPair']>[0];

const DRIVER_TAG = 'vtherm';

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

/** Un appareil proposable pour une source. Exporté : `api.mts` le rend tel quel à la page de réglages. */
export interface CandidateSummary {
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

    for (const { event, key } of SELECT_EVENTS) {
      session.setHandler(event, async (deviceId: unknown) => {
        selection.set(key, asDeviceId(deviceId));
        return true;
      });
    }

    // La vue crée l'appareil elle-même. Naviguer d'une vue custom vers le template
    // `add_devices` ferme l'assistant sans rien créer sur Homey Pro 2023 ; les apps publiées
    // appellent `Homey.createDevice()` puis `Homey.done()` depuis la vue, c'est ce qu'on fait.
    session.setHandler('build_device', async () => this.buildDevice(selection));
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

    // Une erreur JavaScript dans une vue de pairing est autrement invisible : la page reste
    // blanche, et une app installée par CLI n'a pas de log lisible. La vue nous les renvoie ici.
    session.setHandler('viewLog', async (message: unknown) => {
      this.app.trace(`[${DRIVER_TAG}] vue : ${String(message)}`);
      return true;
    });

    session.setHandler('pair_mode', async () => 'repair');

    // La page d'édition montre d'où l'on part : sans ça, l'utilisateur choisit à l'aveugle et
    // ne peut pas vérifier ce qui est lié aujourd'hui.
    session.setHandler('current_sources', async () => target.currentSources());

    // La vue ne devrait jamais l'appeler en réparation — mais si elle le fait, mieux vaut un
    // message qu'un « no such event » opaque affiché à l'utilisateur.
    session.setHandler('build_device', async () => {
      throw new Error(this.homey.__('pair.error.repair_no_create'));
    });

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

  /**
   * Publique, et pas seulement pour les vues de pairing : `GET /candidates` de `api.mts` passe par
   * ici. C'est le seul endroit qui sache traduire une source en capabilities acceptées, et la page
   * de réglages doit proposer exactement les mêmes appareils que le pairing — pas « presque ».
   */
  async listCandidates(data: unknown): Promise<CandidateSummary[]> {
    // La vue demande une SOURCE, pas une capability : la correspondance vit dans
    // `SOURCE_CAPABILITIES`, à côté du code qui lie réellement l'appareil. Recopier la liste
    // dans les vues créerait une seconde vérité, et c'est déjà ce qui a rendu les détecteurs de
    // présence introuvables — ils publient `alarm_presence`, pas `alarm_motion`.
    const source = isRecord(data) && typeof data.source === 'string' ? data.source : null;
    const wanted = source !== null && source in SOURCE_CAPABILITIES
      ? SOURCE_CAPABILITIES[source as SourceKey]
      : null;
    if (wanted === null) {
      this.app.trace(`[${DRIVER_TAG}] list_candidates SANS source connue : ${JSON.stringify(data)}`);
      return [];
    }
    const capability = wanted.join('/');
    if (!this.app.hub.connected) {
      // Cause n°1 d'une liste vide, et la seule qui ne vienne pas de la vue : sans le hub, l'app
      // ne voit aucun appareil de l'utilisateur. Mieux vaut le dire que rendre un tableau vide.
      this.app.trace(`[${DRIVER_TAG}] list_candidates(${capability}) REFUSÉ : hub non connecté`);
      throw new Error(this.homey.__('pair.error.no_api'));
    }

    // Union des capabilities acceptées, dédupliquée : un appareil qui en porte deux ne doit
    // pas apparaître deux fois dans la liste.
    const byId = new Map<string, Awaited<ReturnType<typeof this.app.hub.listDevicesByCapability>>[number]>();
    for (const accepted of wanted) {
      for (const summary of await this.app.hub.listDevicesByCapability(accepted)) {
        if (!byId.has(summary.id)) byId.set(summary.id, summary);
      }
    }
    const summaries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    const candidates = summaries
      // Ne jamais se proposer soi-même. Un thermostat de cette app porte `target_temperature` et
      // apparaîtrait donc dans la liste des émetteurs ; le désigner créerait une boucle où chacun
      // écrit la consigne que l'autre relit, et la vanne dériverait jusqu'à sa butée.
      .filter((summary) => !isOwnDevice(summary.driverUri, this.appId))
      .map((summary) => ({
        id: summary.id,
        name: summary.name,
        zoneName: summary.zoneName,
      }));

    this.app.trace(
      `[${DRIVER_TAG}] list_candidates(${capability}) : ${summaries.length} trouvé(s), `
      + `${candidates.length} transmis — ${candidates.map((c) => c.name).join(' | ') || 'aucun'}`,
    );
    return candidates;
  }

  /**
   * Capabilities toujours présentes, quelles que soient les sources choisies.
   *
   * Le manifeste ne déclare que celles-ci. Les autres dépendent de ce que l'utilisateur a
   * désigné au pairing et sont ajoutées ici, appareil par appareil : une tuile « Fenêtre »
   * perpétuellement fausse sur un thermostat sans capteur d'ouverture est une promesse que
   * l'app ne tient pas.
   *
   * Elles sont fixées à la CRÉATION et jamais modifiées ensuite : `addCapability` et
   * `removeCapability` détruisent l'historique Insights de l'appareil.
   */
  private static readonly BASE_CAPABILITIES = [
    'onoff', 'target_temperature', 'measure_temperature',
    'vtherm_preset', 'vtherm_state',
    'vtherm_regulated_setpoint', 'vtherm_power_percent', 'vtherm_valve_open', 'vtherm_slope',
  ] as const;

  private async buildDevice(selection: ReadonlyMap<SourceKey, string | null>): Promise<{
    name: string;
    data: { id: string };
    store: Record<string, string | null>;
    capabilities: string[];
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

    const capabilities: string[] = [...VThermDriver.BASE_CAPABILITIES];
    if (selection.get('window')) capabilities.push('alarm_contact');
    if (selection.get('motion') || selection.get('presence')) capabilities.push('alarm_motion');

    // La pile n'est affichée que si l'émetteur en rapporte une : un radiateur sur secteur n'en
    // a pas, et une tuile de pile vide sur un appareil branché n'apprend rien à personne.
    const emitter = await this.app.hub.getDeviceSummary(emitterId);
    if (emitter?.capabilities.some((id) => id === 'measure_battery' || id.startsWith('measure_battery.'))) {
      capabilities.push('vtherm_emitter_battery');
    }

    return {
      name: await this.proposeName(roomId),
      // Tiré une fois, immuable : `data` est l'identité du device pour Homey et le `tickId` du
      // participant. Le dériver d'une source le rendrait mortel dès la première réparation.
      data: { id: randomUUID() },
      store,
      capabilities,
    };
  }

  /** La pièce du capteur, à défaut son nom : l'utilisateur peut renommer juste après. */
  private async proposeName(roomId: string): Promise<string> {
    // Une seule nouvelle tentative si le hub n'a pas encore répondu. Le pairing suit souvent de
    // près l'installation de l'app, et un thermostat créé pendant ce trou s'appelle « Thermostat »
    // — ce qui devient illisible dès qu'il y en a cinq. Renommer après coup serait plus intrusif
    // qu'attendre une seconde ici.
    let summary = await this.app.hub.getDeviceSummary(roomId);
    if (summary === null) {
      await new Promise<void>((resolve) => { this.homey.setTimeout(resolve, 1_000); });
      summary = await this.app.hub.getDeviceSummary(roomId);
    }
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
