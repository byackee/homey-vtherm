/**
 * Faux appareil Homey vu par un participant.
 *
 * Enregistre tout ce qui sort du participant — capabilities publiées, avertissements, cartes Flow
 * déclenchées, écritures dans le `store` — pour que les tests assertionnent des CONSÉQUENCES
 * plutôt que des appels. Une revue a montré qu'un test qui n'affirme que le mécanisme laisse
 * passer la panne physique qu'il était censé couvrir.
 */

import type { CapValue } from '../../runtime/hub.mjs';
import type { DeviceHost, ParticipantEvent } from '../../runtime/participants.mjs';

export class FakeDeviceHost implements DeviceHost {
  readonly published: { capabilityId: string; value: CapValue; nowMs: number }[] = [];
  readonly warnings: (string | null)[] = [];
  readonly flows: ParticipantEvent[] = [];
  readonly logs: string[] = [];
  readonly errors: string[] = [];

  private readonly capabilities = new Map<string, CapValue>();
  private readonly store = new Map<string, unknown>();

  /** Fait échouer la publication d'une capability précise, pour vérifier que rien ne s'effondre. */
  failPublishOf: string | null = null;

  constructor(readonly id = 'fake-device') {}

  /** Horloge de l'hôte : les tests la fixent pour dater les publications. */
  nowMs = 0;

  translate(key: string): string {
    // Rendre la clé : les tests assertionnent une clé, pas une phrase traduite qui peut changer.
    return key;
  }

  getCapabilityValue(capabilityId: string): CapValue | null {
    return this.capabilities.get(capabilityId) ?? null;
  }

  async setCapabilityValue(capabilityId: string, value: CapValue): Promise<void> {
    if (this.failPublishOf === capabilityId) throw new Error(`publication refusée : ${capabilityId}`);
    this.capabilities.set(capabilityId, value);
    this.published.push({ capabilityId, value, nowMs: this.nowMs });
  }

  async setWarning(message: string | null): Promise<void> {
    this.warnings.push(message);
  }

  getStoreValue(key: string): unknown {
    return this.store.get(key);
  }

  async setStoreValue(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async triggerFlow(event: ParticipantEvent): Promise<void> {
    this.flows.push(event);
  }

  log(...args: unknown[]): void {
    this.logs.push(args.map(String).join(' '));
  }

  error(...args: unknown[]): void {
    this.errors.push(args.map(String).join(' '));
  }

  // --- Aides d'assertion ---------------------------------------------------

  /** Dernière valeur publiée pour cette capability, ou `undefined` si jamais publiée. */
  lastPublished(capabilityId: string): CapValue | undefined {
    for (let i = this.published.length - 1; i >= 0; i -= 1) {
      const entry = this.published[i];
      if (entry !== undefined && entry.capabilityId === capabilityId) return entry.value;
    }
    return undefined;
  }

  get lastWarning(): string | null | undefined {
    return this.warnings[this.warnings.length - 1];
  }

  flowKinds(): string[] {
    return this.flows.map((e) => e.kind);
  }
}
