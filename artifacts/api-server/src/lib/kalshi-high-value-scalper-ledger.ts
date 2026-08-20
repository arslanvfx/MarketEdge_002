import type { BotMode } from "./kalshi-bot-state";

type Allocation = { mode: BotMode; amount: number };

/**
 * Scanner-wide provisional budget. JavaScript is single-threaded between
 * awaits, so acquiring here before the next await makes independent symbol
 * scans observe each other's pending risk and prevents cap oversubscription.
 */
export class HighValueScalpReservationLedger {
  private readonly allocations = new Map<string, Allocation>();

  reservedAmount(mode: BotMode): number {
    let total = 0;
    for (const allocation of this.allocations.values()) {
      if (allocation.mode === mode) total += allocation.amount;
    }
    return total;
  }

  tryReserve(input: {
    key: string;
    mode: BotMode;
    amount: number;
    currentExposure: number;
    maxExposure: number;
    currentDailySpend: number;
    maxDailySpend: number;
  }): boolean {
    if (this.allocations.has(input.key) || !Number.isFinite(input.amount) || input.amount <= 0) return false;
    const pending = this.reservedAmount(input.mode);
    if (input.currentExposure + pending + input.amount > input.maxExposure) return false;
    if (input.currentDailySpend + pending + input.amount > input.maxDailySpend) return false;
    this.allocations.set(input.key, { mode: input.mode, amount: input.amount });
    return true;
  }

  release(key: string): void {
    this.allocations.delete(key);
  }
}

export const highValueScalpReservationLedger = new HighValueScalpReservationLedger();