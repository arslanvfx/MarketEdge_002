/**
 * Coalesce work only for the same key. A slow request for one symbol must not
 * prevent fresh requests for every other symbol on the next sampling cycle.
 */
export class PerKeyInFlight {
  private readonly active = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.active.get(key);
    if (existing) return existing;

    let run: Promise<void>;
    run = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.active.get(key) === run) this.active.delete(key);
      });
    this.active.set(key, run);
    return run;
  }

  clear(): void {
    this.active.clear();
  }
}