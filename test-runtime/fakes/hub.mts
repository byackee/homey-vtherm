/**
 * Faux hub, vu par l'adaptateur d'émetteur.
 *
 * `HomeyEmitterAdapter` n'utilise du hub que deux méthodes : `getDeviceSummary` pour détecter le
 * mode, et `bind` pour ouvrir un canal d'écriture. On reproduit cette surface-là, pas la classe
 * entière — le reste du hub est testé pour lui-même, sans passer par un émetteur.
 *
 * Chaque capability liée reçoit sa propre `FakeBinding`, retrouvable par son identifiant : c'est
 * ce qui permet d'affirmer que la consigne est partie sur `target_temperature.local` et non sur
 * l'identifiant nu, distinction qui décide si l'écriture atteint la vanne ou tombe dans le vide.
 */

import type { DeviceSummary, HomeyApiHub, SourceBinding } from '../../runtime/hub.mjs';
import { FakeBinding } from './binding.mjs';

export class FakeHub {
  /** Une liaison par capability, dans l'ordre où l'émetteur les a demandées. */
  readonly bindings = new Map<string, FakeBinding>();
  summary: DeviceSummary | null = null;

  async getDeviceSummary(_deviceId: string): Promise<DeviceSummary | null> {
    return this.summary;
  }

  bind(deviceId: string, capabilityId: string): SourceBinding {
    const existing = this.bindings.get(capabilityId);
    if (existing !== undefined) {
      existing.destroyed = false;
      return existing;
    }
    const binding = new FakeBinding();
    binding.deviceId = deviceId;
    binding.capabilityId = capabilityId;
    this.bindings.set(capabilityId, binding);
    return binding;
  }

  /** La liaison ouverte sur cette capability, ou `undefined` si l'émetteur ne l'a jamais demandée. */
  binding(capabilityId: string): FakeBinding | undefined {
    return this.bindings.get(capabilityId);
  }

  /** Le hub concret n'est demandé que pour son type : l'émetteur n'en touche que deux méthodes. */
  asHub(): HomeyApiHub {
    return this as unknown as HomeyApiHub;
  }
}

/** Résumé d'appareil minimal : `setable` est faux par défaut, comme le vrai hub le rapporte. */
export function summaryOf(options: {
  id?: string;
  name?: string;
  deviceClass?: string;
  capabilities: readonly string[];
  setable?: readonly string[];
  available?: boolean;
  driverUri?: string | null;
}): DeviceSummary {
  const setable: Record<string, boolean> = {};
  for (const id of options.capabilities) {
    setable[id] = options.setable?.includes(id) === true;
  }
  return {
    id: options.id ?? 'emitter-1',
    name: options.name ?? 'Vanne salon',
    zoneName: 'Salon',
    class: options.deviceClass ?? 'thermostat',
    capabilities: [...options.capabilities],
    setable,
    available: options.available ?? true,
    driverUri: options.driverUri ?? 'homey:app:com.tiers:device',
  };
}
