import type { KalshiTopOfBook } from "./kalshi-orderbook-store.ts";

export interface ConvictionBookCandidate {
  readonly sym: string;
  readonly windowKey: string;
  readonly ticker: string;
  readonly target: number;
  readonly lockPrice: number;
  readonly lockPriceCap: number;
}

type ConvictionBookDispatchDependencies = {
  isActive: () => boolean;
  isFresh: (ticker: string) => boolean;
  getTopOfBook: (ticker: string) => KalshiTopOfBook | null;
  candidatesForTicker: (ticker: string) => readonly ConvictionBookCandidate[];
  dispatch: (
    candidate: ConvictionBookCandidate,
    yesAsk: number | null,
    noAsk: number | null,
    book: KalshiTopOfBook,
  ) => void | Promise<void>;
  telemetry?: (event: string, fields: Record<string, unknown>) => void;
};

/**
 * Process-local choke point shared by public-poller and authenticated-book
 * triggers. The durable order intent remains the cross-process authority.
 */
export class ConvictionDispatchInFlightGate {
  private readonly keys = new Set<string>();

  run(key: string, dispatch: () => void | Promise<void>): Promise<void> | null {
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    return Promise.resolve()
      .then(dispatch)
      .finally(() => this.keys.delete(key));
  }
}

/**
 * Turns an accepted authenticated-book change into a guarded conviction
 * callback. This deliberately knows no order logic: the callback still enters
 * the normal Bot 1 tick and all final guards/reservations remain authoritative.
 */
export class ConvictionBookDispatchCoordinator {
  private readonly queuedTickers = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly deps: ConvictionBookDispatchDependencies;

  constructor(deps: ConvictionBookDispatchDependencies) {
    this.deps = deps;
  }

  onAcceptedBookUpdate(ticker: string): void {
    if (this.queuedTickers.has(ticker)) return;
    this.queuedTickers.add(ticker);
    queueMicrotask(() => {
      this.queuedTickers.delete(ticker);
      try {
        this.flush(ticker);
      } catch (error) {
        this.emit("error", { ticker, stage: "flush", error });
      }
    });
  }

  private emit(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.telemetry?.(event, fields);
    } catch {
      // Telemetry can never make an accepted book update process-fatal.
    }
  }

  private flush(ticker: string): void {
    // A reconnect, sequence gap, or stale book makes either of these false.
    // Do not retain/carry a pre-reconnect event into a later snapshot.
    if (!this.deps.isActive() || !this.deps.isFresh(ticker)) return;
    const top = this.deps.getTopOfBook(ticker);
    if (!top) return;
    const yesAsk = top.yesAsk;
    const noAsk = top.noAsk;
    for (const candidate of this.deps.candidatesForTicker(ticker)) {
      // Keep identity fail-closed even if a future candidate provider is
      // broadened: an update may only dispatch for its exact market ticker.
      if (candidate.ticker !== ticker) continue;
      const key = `${candidate.sym}:${candidate.windowKey}:${candidate.ticker}`;
      if (this.inFlight.has(key)) {
        this.emit("coalesced", { sym: candidate.sym, windowKey: candidate.windowKey, ticker });
        continue;
      }
      const yesInZone = yesAsk != null && yesAsk >= candidate.lockPrice && yesAsk <= candidate.lockPriceCap;
      const noInZone = noAsk != null && noAsk >= candidate.lockPrice && noAsk <= candidate.lockPriceCap;
      if (!yesInZone && !noInZone) continue;
      this.inFlight.add(key);
      this.emit("detected", {
        sym: candidate.sym, windowKey: candidate.windowKey, ticker,
        yesAsk, noAsk, lockPrice: candidate.lockPrice, lockPriceCap: candidate.lockPriceCap,
        side: yesInZone ? "YES" : "NO", bookVersion: top.bookVersion,
        bookUpdatedAt: top.updatedAt,
        bookUpdateToDispatchMs: Math.max(0, Date.now() - top.updatedAt),
      });
      Promise.resolve()
        .then(() => this.deps.dispatch(candidate, yesAsk, noAsk, top))
        .catch((error) => this.emit("error", {
          sym: candidate.sym,
          windowKey: candidate.windowKey,
          ticker,
          stage: "dispatch",
          error,
        }))
        .finally(() => this.inFlight.delete(key));
    }
  }
}