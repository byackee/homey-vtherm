/**
 * `runtime/hub.mts` — la couche d'accès aux appareils tiers.
 *
 * SEUL module de tout le projet qui importe `homey-api`. C'est aussi le module le plus risqué de
 * l'app : c'est lui qui décide si la régulation pilote une vraie mesure ou une valeur morte.
 *
 * Les interfaces `Api*` plus bas décrivent la surface de `homey-api@3.19` réellement utilisée.
 * Elles sont écrites d'après le code source du paquet installé, pas d'après sa documentation :
 * `HomeyAPI.createAppAPI()` est typé `Promise<any>` par Athom, et ce fichier est la seule barrière
 * entre ce `any` et le reste de l'app.
 */

import { EventEmitter } from 'node:events';
import type Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import { matchesCapability } from '../lib/capabilityMatch.mjs';

import { computeStale, resolveTimestamp, toEpochMs } from '../lib/freshness.mjs';
import { shouldWrite } from '../lib/writePolicy.mjs';
import type { CapValue, LastWrite, WriteOptions } from '../lib/writePolicy.mjs';

export type { CapValue } from '../lib/writePolicy.mjs';

/**
 * TODO: importer depuis lib/step.mjs quand le lot 1bis aura atterri.
 * Forme figée par le lot 1bis : `{ value: T; atMs: number; stale: boolean }`.
 */
export interface Reading<T> {
  value: T;
  atMs: number;
  stale: boolean;
}

/** L'instance Homey passée à l'app. `@types/homey` n'exporte pas la classe directement. */
type HomeyInstance = Homey.App['homey'];

type Logger = (...args: unknown[]) => void;

export interface HomeyApiHubOptions {
  log?: Logger;
  error?: Logger;
}

// --- Réglages de comportement ---------------------------------------------

/**
 * Back-off du ré-abonnement après un `'destroy'` de capability. Une app tierce qui redémarre en
 * boucle ne doit pas nous faire marteler l'API : le quota Athom se déclenche aussi en production.
 */
const RESUBSCRIBE_MIN_MS = 5_000;
const RESUBSCRIBE_MAX_MS = 5 * 60_000;

/**
 * Intervalle minimal entre deux `getDevices()` réseau. L'ordonnanceur coalesce ses ticks, mais un
 * recalcul hors cycle (consigne, preset, fenêtre) peut en produire une rafale : sans ce plancher,
 * le filet de sécurité deviendrait lui-même la cause du dépassement de quota.
 */
const REFRESH_MIN_INTERVAL_MS = 60_000;

// --- Surface utilisée de homey-api ----------------------------------------

interface ApiCapabilityObj {
  value?: unknown;
  /** `Date` après `Device.transformGet`, mais nombre ou chaîne ISO selon le chemin emprunté. */
  lastUpdated?: unknown;
  setable?: boolean;
  getable?: boolean;
}

interface ApiDeviceCapability {
  value: CapValue | null;
  /** Vient du `transactionTime` de l'émetteur, donc `null` dès qu'il ne l'envoie pas. */
  lastChanged: Date | null;
  setValue(value: CapValue, opts?: object): Promise<void>;
  on(event: 'destroy', fn: () => void): unknown;
  destroy(): void;
}

interface ApiDevice {
  id: string;
  name: string;
  /** Identifiant de zone. `Device.zoneName` est déprécié et retourne `undefined`. */
  zone: string;
  class: string;
  capabilities: string[];
  capabilitiesObj: Record<string, ApiCapabilityObj | undefined> | null;
  available: boolean;
  makeCapabilityInstance(
    capabilityId: string,
    listener: (value: CapValue | null) => void,
  ): ApiDeviceCapability;
  setCapabilityValue(opts: { capabilityId: string; value: CapValue }): Promise<void>;
}

interface ApiZone {
  id: string;
  name: string;
}

interface ApiManagerDevices {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getDevices(opts?: { $cache?: boolean; $updateCache?: boolean }): Promise<Record<string, ApiDevice | undefined>>;
  getDevice(opts: { id: string }): Promise<ApiDevice>;
}

interface ApiManagerZones {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getZones(opts?: { $cache?: boolean }): Promise<Record<string, ApiZone | undefined>>;
}

interface HomeyApiClient {
  devices: ApiManagerDevices;
  zones: ApiManagerZones;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  destroy(): void;
}

// --- Contrat public --------------------------------------------------------

export interface DeviceSummary {
  id: string;
  name: string;
  zoneName: string | null;
  class: string;
  capabilities: string[];
  /**
   * Indispensable : une capability peut être présente sans être inscriptible. La détection du mode
   * d'un émetteur (SPEC §5.1, lot 4) doit lire ceci, pas la seule présence de l'identifiant.
   */
  setable: Record<string, boolean>;
  available: boolean;
  /**
   * URI du driver propriétaire, du genre `homey:app:com.gruijter.zigbee2mqtt:device`.
   *
   * Sert à ce qu'un thermostat de cette app ne puisse pas être proposé comme émetteur d'un autre :
   * le désigner créerait une boucle de régulation où chacun écrit la consigne que l'autre relit.
   * `null` quand l'API ne le donne pas — dans ce cas on ne filtre rien plutôt que de tout masquer.
   */
  driverUri: string | null;
}

export interface WriteRequest extends WriteOptions {
  nowMs: number;
}

export interface SourceBinding {
  /**
   * SYNCHRONE et ne lève JAMAIS. `null` quand le device a disparu, n'a pas de valeur, ou que sa
   * valeur n'est pas datable.
   */
  read(nowMs: number, freshnessMs: number): Reading<CapValue> | null;
  /**
   * Écrit si — et seulement si — la politique de `lib/writePolicy.mts` le permet.
   * Retourne `true` quand un appel est réellement parti, `false` quand il a été dédupliqué.
   * Lève quand l'appel est parti mais a échoué (émetteur indisponible) : c'est une information
   * que l'appelant doit voir, pas un `false` de plus.
   */
  write(value: CapValue, opts: WriteRequest): Promise<boolean>;
  destroy(): void;
}

// --- Implémentation --------------------------------------------------------

function isCapValue(value: unknown): value is CapValue {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

class Binding implements SourceBinding {

  private device: ApiDevice | null = null;
  private instance: ApiDeviceCapability | null = null;
  private lastWrite: LastWrite | null = null;

  /**
   * Instant où le listener a effectivement tiré. Troisième et dernière source d'horodatage :
   * moins précise que les deux autres, mais c'est un minorant honnête de l'âge de la mesure.
   */
  private listenerFiredAtMs: number | null = null;

  private destroyed = false;
  /**
   * Vrai pendant qu'on remplace volontairement l'instance. Sans ce drapeau, le `'destroy'` que
   * nous provoquons nous-mêmes en ré-abonnant serait pris pour une disparition du device et
   * armerait un ré-abonnement de plus : un ré-abonnement toutes les cinq secondes, indéfiniment.
   */
  private detaching = false;
  private resubscribeTimer: NodeJS.Timeout | null = null;
  private resubscribeDelayMs = RESUBSCRIBE_MIN_MS;

  constructor(
    private readonly hub: HomeyApiHub,
    readonly deviceId: string,
    readonly capabilityId: string,
    private readonly onChange?: (reading: Reading<CapValue>) => void,
  ) {}

  /** Vrai quand la liaison n'a plus de device résolu : `refresh()` tentera de la réparer. */
  get orphaned(): boolean {
    return !this.destroyed && this.device === null;
  }

  read(nowMs: number, freshnessMs: number): Reading<CapValue> | null {
    // Infaillible par contrat : l'ordonnanceur prend un instantané de tous les VTherm en un pas,
    // une exception ici ferait tomber le tick entier — donc toute la régulation, pas un seul VTherm.
    try {
      if (this.destroyed) return null;

      const device = this.device;
      if (device === null) return null;

      // Les objets `Device` du cache sont mis à jour EN PLACE par le websocket : lire est un accès
      // mémoire, pas un appel réseau. C'est ce qui rend cette méthode synchrone.
      const capObj = device.capabilitiesObj?.[this.capabilityId];

      const rawValue = capObj !== undefined && capObj.value !== undefined
        ? capObj.value
        : this.instance?.value ?? null;
      if (!isCapValue(rawValue)) return null;

      const resolved = resolveTimestamp({
        lastUpdatedMs: toEpochMs(capObj?.lastUpdated),
        lastChangedMs: toEpochMs(this.instance?.lastChanged),
        listenerFiredAtMs: this.listenerFiredAtMs,
      });
      // Non datable ⇒ absente. Retomber sur `Date.now()` fabriquerait une lecture qui ne paraîtrait
      // jamais périmée, donc une chaudière qui continue de chauffer sur un capteur muet.
      if (resolved === null) return null;

      const stale = computeStale({
        atMs: resolved.atMs,
        nowMs,
        // Le seuil vient de l'appelant, par nature de source. Jamais d'un seuil global ici.
        freshnessMs,
        available: device.available !== false,
      });

      return { value: rawValue, atMs: resolved.atMs, stale };
    } catch {
      return null;
    }
  }

  async write(value: CapValue, opts: WriteRequest): Promise<boolean> {
    if (this.destroyed) return false;

    const device = this.device;
    if (device === null) return false;

    const decision = shouldWrite(this.lastWrite, value, opts, opts.nowMs);
    if (!decision.write) return false;

    // `DeviceCapability.setValue` met aussi à jour `capabilitiesObj` en place, donc la lecture
    // suivante voit la valeur écrite sans attendre l'écho du websocket.
    if (this.instance !== null) {
      await this.instance.setValue(value);
    } else {
      await device.setCapabilityValue({ capabilityId: this.capabilityId, value });
    }

    // Enregistré APRÈS l'appel : un échec ne doit pas armer le garde-fou d'intervalle, sans quoi
    // une panne transitoire bloquerait la prochaine tentative pendant tout `minIntervalMs`.
    this.lastWrite = { value, atMs: opts.nowMs };
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearResubscribeTimer();
    this.dropInstance();
    this.device = null;
    this.hub.forget(this);
  }

  /** Résout le device par son id et s'abonne. Idempotent : rejoué à chaque reconnexion. */
  async attach(api: HomeyApiClient): Promise<void> {
    if (this.destroyed) return;

    // Servi depuis le cache quand `devices.connect()` a été appelé : aucun appel réseau.
    const device = await api.devices.getDevice({ id: this.deviceId });

    if (this.destroyed) return;

    this.dropInstance();
    this.device = device;

    const instance = device.makeCapabilityInstance(this.capabilityId, (value) => {
      this.onCapabilityValue(value);
    });

    // `DeviceCapability` s'auto-détruit en silence quand son device disparaît (app tierce
    // redémarrée, device ré-appairé) et émet `'destroy'` AVANT de retirer ses listeners : c'est
    // le seul point d'accroche pour se ré-abonner. Sans lui, la liaison rapporterait éternellement
    // la dernière valeur vue, sans lever la moindre erreur.
    instance.on('destroy', () => {
      if (this.destroyed || this.detaching) return; // destruction volontaire : rien à réparer.
      this.instance = null;
      this.scheduleResubscribe();
    });

    this.instance = instance;
    this.resubscribeDelayMs = RESUBSCRIBE_MIN_MS;
  }

  private onCapabilityValue(value: CapValue | null): void {
    // Seul endroit du hub qui lit l'horloge : l'événement arrive hors de tout tick, il n'y a donc
    // pas de `nowMs` à recevoir. `runtime/` a le droit de lire l'horloge, `lib/` non.
    const firedAtMs = Date.now();
    this.listenerFiredAtMs = firedAtMs;

    if (value === null || this.onChange === undefined) return;

    // Une valeur qui vient d'arriver est fraîche par construction : seul l'indisponibilité de
    // l'appareil peut encore la disqualifier, d'où `freshnessMs: Infinity`.
    const reading = this.read(firedAtMs, Number.POSITIVE_INFINITY);
    if (reading === null) return;

    try {
      this.onChange(reading);
    } catch (err) {
      this.hub.logError(`onChange ${this.deviceId}/${this.capabilityId}:`, err);
    }
  }

  private scheduleResubscribe(): void {
    if (this.destroyed || this.resubscribeTimer !== null) return;

    const delayMs = this.resubscribeDelayMs;
    this.resubscribeDelayMs = Math.min(this.resubscribeDelayMs * 2, RESUBSCRIBE_MAX_MS);

    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      void this.resubscribe();
    }, delayMs);
    this.resubscribeTimer.unref?.();
  }

  private async resubscribe(): Promise<void> {
    if (this.destroyed) return;

    const api = this.hub.client;
    if (api === null) {
      this.scheduleResubscribe();
      return;
    }

    try {
      await this.attach(api);
      this.hub.log(`Ré-abonné à ${this.deviceId}/${this.capabilityId}.`);
    } catch (err) {
      // Le device n'est pas revenu (encore). On le marque orphelin : `read()` renverra `null`,
      // ce qui est la bonne réponse — une source morte, pas une valeur figée.
      this.device = null;
      this.hub.logError(`Ré-abonnement à ${this.deviceId}/${this.capabilityId} échoué :`, err);
      this.scheduleResubscribe();
    }
  }

  private dropInstance(): void {
    const instance = this.instance;
    this.instance = null;
    if (instance === null) return;

    this.detaching = true;
    try {
      instance.destroy();
    } catch {
      // Une instance déjà détruite est exactement l'état voulu.
    } finally {
      this.detaching = false;
    }
  }

  private clearResubscribeTimer(): void {
    if (this.resubscribeTimer === null) return;
    clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = null;
  }
}

export class HomeyApiHub {

  private api: HomeyApiClient | null = null;
  private readonly bindings = new Set<Binding>();
  private readonly events = new EventEmitter();

  private starting: Promise<void> | null = null;
  private stopped = false;

  /**
   * Les réaffirmations de connexion sont sérialisées : `connect` et `reconnect` peuvent arriver
   * coup sur coup, et deux `reattachAll()` concurrents se détruiraient mutuellement leurs
   * instances de capability.
   */
  private affirmChain: Promise<void> = Promise.resolve();

  private refreshInFlight: Promise<void> | null = null;
  private lastRefreshAtMs = Number.NEGATIVE_INFINITY;

  readonly log: Logger;
  readonly logError: Logger;

  constructor(private readonly homey: HomeyInstance, options: HomeyApiHubOptions = {}) {
    this.events.setMaxListeners(0);
    this.log = options.log ?? (() => undefined);
    this.logError = options.error ?? (() => undefined);
  }

  /** @internal Utilisé par les liaisons pour se ré-abonner. */
  get client(): HomeyApiClient | null {
    return this.api;
  }

  /**
   * Vrai seulement quand le namespace `devices` est réellement abonné. C'est la seule définition
   * honnête : hors de cet état, les objets `Device` ne sont plus rafraîchis par personne.
   */
  get connected(): boolean {
    const api = this.api;
    if (api === null) return false;
    try {
      return api.devices.isConnected();
    } catch {
      return false;
    }
  }

  on(event: 'connected' | 'disconnected', fn: () => void): void {
    this.events.on(event, fn);
  }

  async start(): Promise<void> {
    if (this.starting !== null) return this.starting;

    this.stopped = false;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private async doStart(): Promise<void> {
    const api = await HomeyAPI.createAppAPI({ homey: this.homey }) as HomeyApiClient;
    if (this.stopped) {
      api.destroy();
      return;
    }
    this.api = api;

    api.on('reconnect', () => {
      // Point 1 du contrat, seconde moitié. Une reconnexion socket ne réabonne PAS les namespaces
      // des managers : sans ce rappel, `ManagerDevices` reste `__connected: false`, son cache n'est
      // plus alimenté et `scheduleRefresh()` ne rejoue plus rien. `connect()` est idempotent
      // (`RealtimeConsumer` réutilise sa souscription), donc le rappeler ne coûte rien.
      this.log('Websocket reconnecté — réaffirmation de devices.connect().');
      void this.affirmConnections();
    });

    api.on('connect', () => {
      void this.affirmConnections();
    });

    api.on('disconnect', () => {
      this.log('Websocket déconnecté.');
      this.events.emit('disconnected');
    });

    api.on('connect_error', (err: unknown) => {
      this.logError('Erreur de connexion websocket :', err);
    });

    await this.affirmConnections();
  }

  /**
   * NE PAS SUPPRIMER `devices.connect()` en croyant `getDevices()` suffisant.
   *
   * `Manager.__request` ne place les items en cache que si `this.isConnected()`, et `isConnected()`
   * n'est vrai qu'après un `connect()` explicite sur CE manager. Sans lui :
   *  - `getDevices()` retourne des `Device` orphelins, jamais mis en cache ;
   *  - `ManagerDevices.scheduleRefresh()` sort immédiatement, donc rien ne se resynchronise après
   *    une coupure websocket ;
   *  - les `DeviceCapability` rapportent éternellement la dernière valeur vue, sans lever d'erreur.
   *
   * C'est le mode de panne le plus dangereux du projet : la régulation continue de tourner, sur
   * des données mortes, et rien dans les journaux ne le signale. La ligne ci-dessous est ce qui
   * l'empêche.
   */
  private affirmConnections(): Promise<void> {
    // La chaîne ne rejette jamais : elle est réveillée depuis des gestionnaires d'événements
    // websocket, où un rejet non traité ferait tomber le processus de l'app.
    const next = this.affirmChain
      .then(() => this.doAffirmConnections(), () => this.doAffirmConnections())
      .catch((err: unknown) => {
        this.logError('Réaffirmation de la connexion :', err);
      });

    this.affirmChain = next;
    return next;
  }

  private async doAffirmConnections(): Promise<void> {
    const api = this.api;
    if (api === null || this.stopped) return;

    try {
      await api.devices.connect();
      // Les zones ne servent qu'à nommer les appareils au pairing ; leur cache évite un
      // aller-retour réseau par appel de `listDevicesByCapability()`.
      await api.zones.connect();
    } catch (err) {
      this.logError('devices.connect() a échoué :', err);
      return;
    }

    if (this.stopped) return;

    await this.reattachAll();
    this.events.emit('connected');
  }

  /** Ré-abonne toutes les liaisons. Rejoué après chaque reconnexion : les `Device` du cache ont pu être remplacés. */
  private async reattachAll(): Promise<void> {
    const api = this.api;
    if (api === null) return;

    await Promise.allSettled(
      [...this.bindings].map(async (binding) => {
        try {
          await binding.attach(api);
        } catch (err) {
          this.logError(`Abonnement à ${binding.deviceId}/${binding.capabilityId} impossible :`, err);
        }
      }),
    );
  }

  bind(
    deviceId: string,
    capabilityId: string,
    onChange?: (reading: Reading<CapValue>) => void,
  ): SourceBinding {
    const binding = new Binding(this, deviceId, capabilityId, onChange);
    this.bindings.add(binding);

    const api = this.api;
    if (api !== null) {
      binding.attach(api).catch((err: unknown) => {
        // Échec non bloquant : `read()` renverra `null` jusqu'au prochain `refresh()`.
        this.logError(`Abonnement à ${deviceId}/${capabilityId} impossible :`, err);
      });
    }

    return binding;
  }

  /** @internal */
  forget(binding: Binding): void {
    this.bindings.delete(binding);
  }

  /**
   * Le filet sous les événements websocket, pas la source principale des lectures.
   *
   * Au plus UN appel réseau par tick, et jamais plus d'un par `REFRESH_MIN_INTERVAL_MS`.
   * `$cache: false` force l'aller-retour ; `$updateCache: true` met à jour EN PLACE les `Device`
   * déjà en cache — `available` et `capabilitiesObj` compris — donc les liaisons existantes voient
   * les valeurs fraîches sans être refaites.
   *
   * Ne lève jamais : le tick de l'ordonnanceur ne doit pas tomber parce que le réseau a hoqueté.
   */
  async refresh(nowMs: number): Promise<void> {
    if (this.stopped || !this.connected) return;
    if (this.refreshInFlight !== null) return;
    if (nowMs - this.lastRefreshAtMs < REFRESH_MIN_INTERVAL_MS) return;

    const api = this.api;
    if (api === null) return;

    this.lastRefreshAtMs = nowMs;
    this.refreshInFlight = (async () => {
      try {
        await api.devices.getDevices({ $cache: false, $updateCache: true });
        await this.reattachOrphans();
      } catch (err) {
        this.logError('refresh() a échoué :', err);
      }
    })().finally(() => {
      this.refreshInFlight = null;
    });

    await this.refreshInFlight;
  }

  /** Répare les liaisons dont le device avait disparu : il a pu être ré-appairé entre deux ticks. */
  private async reattachOrphans(): Promise<void> {
    const api = this.api;
    if (api === null) return;

    const orphans = [...this.bindings].filter((binding) => binding.orphaned);
    if (orphans.length === 0) return;

    await Promise.allSettled(orphans.map((binding) => binding.attach(api)));
  }

  async listDevicesByCapability(capabilityId: string): Promise<DeviceSummary[]> {
    const api = this.api;
    if (api === null) return [];

    const [devices, zoneNames] = await Promise.all([
      api.devices.getDevices(),
      this.zoneNames(),
    ]);

    return Object.values(devices)
      .filter((device): device is ApiDevice => device !== undefined)
      .filter((device) => Array.isArray(device.capabilities)
        && matchesCapability(device.capabilities, capabilityId))
      .map((device) => this.toSummary(device, zoneNames))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getDeviceSummary(deviceId: string): Promise<DeviceSummary | null> {
    const api = this.api;
    if (api === null) return null;

    try {
      const [device, zoneNames] = await Promise.all([
        api.devices.getDevice({ id: deviceId }),
        this.zoneNames(),
      ]);
      if (device === undefined || device === null) return null;
      return this.toSummary(device, zoneNames);
    } catch {
      // Device supprimé ou API muette : l'absence est une réponse valide, pas une erreur.
      return null;
    }
  }

  /**
   * Réglages bruts d'un appareil tiers, tels que l'app propriétaire les stocke.
   *
   * Sert uniquement à retrouver le `friendly_name` Zigbee2MQTT d'une vanne : l'identifiant Homey
   * ne se déduit pas d'un topic MQTT, et l'app Zigbee2MQTT range ce nom dans les réglages de
   * l'appareil. La forme n'est pas garantie — c'est `extractDeviceHint()` qui la valide.
   */
  async getDeviceSettings(deviceId: string): Promise<unknown> {
    const api = this.api;
    if (api === null) return null;
    try {
      const device = await api.devices.getDevice({ id: deviceId });
      if (device === undefined || device === null) return null;
      return (device as unknown as { settings?: unknown }).settings ?? null;
    } catch {
      return null;
    }
  }

  private toSummary(device: ApiDevice, zoneNames: ReadonlyMap<string, string>): DeviceSummary {
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    const setable: Record<string, boolean> = {};

    for (const capabilityId of capabilities) {
      // Présent n'est pas inscriptible : `setable` est faux par défaut, jamais supposé vrai.
      setable[capabilityId] = device.capabilitiesObj?.[capabilityId]?.setable === true;
    }

    return {
      id: device.id,
      name: device.name,
      zoneName: zoneNames.get(device.zone) ?? null,
      class: device.class,
      capabilities,
      setable,
      available: device.available !== false,
      driverUri: readDriverUri(device),
    };
  }

  /** Servi depuis le cache du manager `zones` une fois `connect()` passé : pas d'appel réseau. */
  private async zoneNames(): Promise<ReadonlyMap<string, string>> {
    const api = this.api;
    if (api === null) return new Map();

    try {
      const zones = await api.zones.getZones();
      const names = new Map<string, string>();
      for (const zone of Object.values(zones)) {
        if (zone !== undefined) names.set(zone.id, zone.name);
      }
      return names;
    } catch {
      // Un nom de zone manquant n'empêche personne de chauffer.
      return new Map();
    }
  }

  /** Appelé depuis `onUninit`. Détruit les liaisons puis ferme la connexion. */
  async stop(): Promise<void> {
    this.stopped = true;

    for (const binding of [...this.bindings]) {
      binding.destroy();
    }
    this.bindings.clear();

    const api = this.api;
    this.api = null;

    if (api !== null) {
      try {
        await api.devices.disconnect();
        await api.zones.disconnect();
      } catch (err) {
        this.logError('Fermeture des namespaces :', err);
      }
      try {
        api.destroy();
      } catch (err) {
        this.logError('Destruction de l\'API :', err);
      }
    }

    this.events.removeAllListeners();
  }
}

/**
 * L'URI du driver n'a pas le même nom selon la version de l'API : `driverUri` sur les Homey
 * récents, `driverId` auparavant. On accepte les deux plutôt que de dépendre d'une seule.
 */
function readDriverUri(device: unknown): string | null {
  const record = device as { driverUri?: unknown; driverId?: unknown };
  const value = record.driverUri ?? record.driverId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

