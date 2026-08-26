export type ConvictionOrderbookWarmupWork = () => Promise<void>;

interface WarmupRecord {
  ticker: string;
  promise: Promise<void>;
  completedAt: number | null;
}

/**
 * Coalesces one exact-ticker warmup per symbol and briefly retains completed
 * outcomes, including failures. Retention lets the critical path distinguish
 * "the prepared request failed" from "no prepared request existed" and avoids
 * an immediate duplicate network call.
 */
export class ConvictionOrderbookWarmupCoordinator {
  private readonly records = new Map<string, WarmupRecord>();
  private readonly completedRetentionMs: number;

  constructor(completedRetentionMs = 2_000) {
    this.completedRetentionMs = completedRetentionMs;
  }

  start(sym: string, ticker: string, work: ConvictionOrderbookWarmupWork): void {
    const existing = this.getCurrent(sym, ticker);
    if (existing) return;

    const record: WarmupRecord = {
      ticker,
      promise: Promise.resolve(),
      completedAt: null,
    };
    record.promise = Promise.resolve()
      .then(work)
      .catch(() => {
        // Failure is an intentional retained outcome. The caller's strict
        // fallback decides whether entry remains eligible.
      })
      .finally(() => {
        record.completedAt = Date.now();
        const timer = setTimeout(() => {
          if (this.records.get(sym) === record) this.records.delete(sym);
        }, this.completedRetentionMs);
        timer.unref?.();
      });
    this.records.set(sym, record);
  }

  async wait(sym: string, ticker: string, timeoutMs: number): Promise<boolean> {
    const record = this.getCurrent(sym, ticker);
    if (!record) return false;
    if (record.completedAt == null) {
      await Promise.race([
        record.promise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
    }
    return true;
  }

  clear(): void {
    this.records.clear();
  }

  private getCurrent(sym: string, ticker: string): WarmupRecord | null {
    const record = this.records.get(sym);
    if (!record || record.ticker !== ticker) return null;
    if (
      record.completedAt != null
      && Date.now() - record.completedAt > this.completedRetentionMs
    ) {
      this.records.delete(sym);
      return null;
    }
    return record;
  }
}