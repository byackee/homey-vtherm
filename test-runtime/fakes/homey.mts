/**
 * Fausse instance Homey.
 *
 * Le vrai SDK n'est pas installable hors d'un Homey — le paquet npm `homey` est le CLI. On
 * reproduit donc la surface réellement utilisée par `runtime/`, qui est minuscule : quatre
 * fonctions de minuterie.
 *
 * Les minuteries sont MANUELLES. Un test qui attend réellement dix secondes est un test qu'on
 * finit par désactiver ; ici le temps est une valeur qu'on avance à la main, ce qui rend
 * observables des enchaînements — un tick en vol pendant l'arrêt de l'app, par exemple — que le
 * temps réel rendrait ingérables.
 */

interface Scheduled {
  id: number;
  dueAtMs: number;
  intervalMs: number | null;
  fn: () => void;
}

export class FakeHomey {
  private nowMs = 0;
  private nextId = 1;
  private readonly scheduled = new Map<number, Scheduled>();

  /** Traductions : rend la clé, pour que les tests assertionnent des clés et non des phrases. */
  readonly __ = (key: string): string => key;

  /**
   * `ManagerSettings`, réduit à ce que l'app en lit : les réglages de la dorsale MQTT. Sans
   * `enabled`, `applyBrokerSettings()` démonte la dorsale et ne touche à aucun broker — ce qui est
   * exactement l'état voulu par les tests, qui branchent la leur à la main.
   */
  readonly settings = {
    values: new Map<string, unknown>(),
    get(key: string): unknown {
      return this.values.get(key) ?? null;
    },
    on(_event: string, _fn: (key: string) => void): void {
      // Aucun réglage ne change en cours de test : rien à notifier.
    },
  };

  /** L'app s'y range elle-même sur un vrai Homey ; les drivers la relisent par ce chemin. */
  app: unknown = null;

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.scheduled.set(id, { id, dueAtMs: this.nowMs + ms, intervalMs: null, fn });
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.scheduled.set(id, { id, dueAtMs: this.nowMs + ms, intervalMs: ms, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.scheduled.delete(id);
  }

  clearInterval(id: number): void {
    this.scheduled.delete(id);
  }

  /** Nombre de minuteries encore armées — un `onUninit` correct doit les laisser à zéro. */
  get pending(): number {
    return this.scheduled.size;
  }

  /**
   * Avance le temps et exécute ce qui devient dû, dans l'ordre chronologique.
   *
   * Les rappels asynchrones ne sont pas attendus ici : c'est justement ce que fait le vrai
   * `setInterval`, et plusieurs défauts trouvés en revue vivent dans cet écart.
   */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.scheduled.values()]
        .filter((s) => s.dueAtMs <= target)
        .sort((a, b) => a.dueAtMs - b.dueAtMs)[0];
      if (due === undefined) break;

      this.nowMs = due.dueAtMs;
      if (due.intervalMs === null) this.scheduled.delete(due.id);
      else due.dueAtMs = this.nowMs + due.intervalMs;
      due.fn();
    }
    this.nowMs = target;
  }

  /** Laisse les promesses déjà résolues s'exécuter, sans avancer l'horloge. */
  static async flush(times = 4): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  /**
   * Laisse la boucle d'événements écouler TOUT ce qui est déjà prêt, sans avancer l'horloge.
   *
   * `flush()` ne rend que quelques tours de microtâches ; un cycle complet de l'app en enchaîne
   * bien davantage, et compter les `await` à la main serait un test qui casse au premier
   * réagencement du code de production.
   */
  static async settle(times = 4): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }
}
