// Pure, zero-dependency guard logic for the Kalshi bot entry and close-position flows.
//
// All functions here are intentionally free of I/O, module-level state, and
// DB imports so they can be unit-tested with node:test + native TS strip.
//
// Each function mirrors an inline guard block in kalshi-bot.ts.  The real
// module delegates to these functions so wiring can be verified in tests by
// reading the source.

// ---------------------------------------------------------------------------
// Entry guards — checked before every bet attempt
// ---------------------------------------------------------------------------

/**
 * Guard 1: Hard bet-size cap.
 *
 * Returns true (blocked) when the computed betAmount would exceed the
 * configured maxBetSize.  A $0.01 tolerance covers floating-point dust.
 */
export function checkMaxBetSizeGuard(betAmount: number, maxBetSize: number): boolean {
  return betAmount > maxBetSize + 0.01;
}

/**
 * Guard 2: Per-coin daily loss cap.
 *
 * Returns true (blocked) when the coin's cumulative losses today have reached
 * or exceeded the configured cap.  A cap of 0 disables the guard.
 */
export function checkDailyLossGuard(coinLossToday: number, maxDailyLossPerCoin: number): boolean {
  return maxDailyLossPerCoin > 0 && coinLossToday >= maxDailyLossPerCoin;
}

/**
 * Guard 3: Per-coin consecutive-window streak pause.
 *
 * Returns `{ blocked: true }` when the coin is still within its pause window.
 * Returns `{ blocked: false, expired: true }` when the pause has just elapsed —
 * the caller should clear `pauseUntilWindowKey` in state.
 * Returns `{ blocked: false, expired: false }` when no pause is active.
 */
export function checkStreakPauseGuard(
  pauseUntilWindowKey: string | null,
  windowKey: string,
): { blocked: boolean; expired: boolean } {
  if (!pauseUntilWindowKey) return { blocked: false, expired: false };
  if (windowKey <= pauseUntilWindowKey) return { blocked: true, expired: false };
  return { blocked: false, expired: true };
}

/**
 * Guard 4 (live-only): Slippage-strike gate.
 *
 * Returns true (blocked) when a coin accumulated ≥3 slippage strikes in a
 * previous window.  The one-window penalty is applied only once — the caller
 * must delete the strike entry after blocking so the following window is clear.
 */
export function checkSlippageStrikeGuard(
  slipInfo: { strikes: number; windowKey: string } | null | undefined,
  currentWindowKey: string,
): boolean {
  if (!slipInfo) return false;
  return slipInfo.strikes >= 3 && slipInfo.windowKey < currentWindowKey;
}

/**
 * Guard 5 (live-only): Account balance floor.
 *
 * Returns true (blocked) when the live Kalshi available balance is below the
 * configured minimum.
 */
export function checkBalanceGuard(liveBal: number, minAccountBalance: number): boolean {
  return liveBal < minAccountBalance;
}

/**
 * Guard 7: Window Monitor readiness gate.
 *
 * Returns true (blocked/deferred) when the window monitor has not yet
 * collected enough intra-window data to produce a reliable signal.
 *
 * This is a per-tick defer (not a permanent window block) — the coin is
 * re-evaluated on the next bot tick (≈60 s) rather than skipped for the
 * whole 15-min window.
 *
 * Pass `requireMonitorReady = false` to disable the gate entirely.
 */
export function checkWindowMonitorReadyGuard(
  wmReady: boolean,
  requireMonitorReady: boolean,
): boolean {
  return requireMonitorReady && !wmReady;
}

/**
 * Guard 8 (live-only): Total open-exposure cap.
 *
 * Returns true (blocked) when adding this bet would push the total open dollar
 * exposure over the configured cap.  A $0.01 tolerance covers floating-point dust.
 */
export function checkExposureGuard(
  openExposure: number,
  betAmount: number,
  maxTotalExposure: number,
): boolean {
  return openExposure + betAmount > maxTotalExposure + 0.01;
}

// ---------------------------------------------------------------------------
// closePosition state helpers
// ---------------------------------------------------------------------------

/**
 * Returns an updated coinDailyLoss map after a position closes.
 *
 * Only accumulates when:
 *   - the position was a loss (pnl < 0), AND
 *   - the position's entry mode matches the current bot mode (avoids
 *     cross-contaminating paper and live daily budgets).
 *
 * Returns a new Map (does not mutate the input).
 */
export function applyDailyLossUpdate(
  coinDailyLoss: Map<string, number>,
  symbol: string,
  pnl: number,
  entryMode: string,
  currentMode: string,
): Map<string, number> {
  const updated = new Map(coinDailyLoss);
  if (pnl < 0 && entryMode === currentMode) {
    const prev = updated.get(symbol) ?? 0;
    updated.set(symbol, prev + Math.abs(pnl));
  }
  return updated;
}

/**
 * Streak state for a single coin (mirrors coinStreakState Map values).
 */
export interface CoinStreakState {
  consecutiveLosses: number;
  pauseUntilWindowKey: string | null;
}

/**
 * Returns updated per-coin streak state after a position closes.
 *
 * On a loss:
 *   - Increments consecutiveLosses.
 *   - When the limit is reached and no pause is already active, arms a new
 *     pause (pauseUntilWindowKey = now + pauseWindows × 15 min) and resets
 *     the counter so the NEXT N-loss streak can trigger a fresh pause.
 *
 * On a win:
 *   - Resets consecutiveLosses to 0 and clears any pending pause.
 *
 * `now` is passed in (milliseconds since epoch) so callers can inject a fixed
 * timestamp in tests without mocking Date.
 */
export function applyStreakUpdate(
  existing: CoinStreakState,
  pnl: number,
  coinStreakLossLimit: number,
  coinStreakPauseWindows: number,
  now: number,
): CoinStreakState {
  if (pnl >= 0) {
    return { consecutiveLosses: 0, pauseUntilWindowKey: null };
  }

  const updated: CoinStreakState = { ...existing };
  updated.consecutiveLosses++;

  const limit = coinStreakLossLimit ?? 3;
  const pauseWindows = coinStreakPauseWindows ?? 2;

  if (limit > 0 && updated.consecutiveLosses >= limit && !updated.pauseUntilWindowKey) {
    const pauseMs = pauseWindows * 15 * 60_000;
    const pauseUntil = new Date(now + pauseMs).toISOString().slice(0, 16);
    updated.pauseUntilWindowKey = pauseUntil;
    updated.consecutiveLosses = 0;
  }

  return updated;
}
