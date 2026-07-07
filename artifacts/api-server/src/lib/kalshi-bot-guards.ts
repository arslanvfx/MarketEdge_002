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
 * Guard 7b — Window Monitor STAY_AWAY gate.
 *
 * Returns:
 *   "block"    — signal is ready AND recommendation === "stay_away" AND
 *                requireMonitorReady is true.  Caller must add the coin to
 *                filteredByNewGuards (full-window block) and push a SKIP result.
 *   "advisory" — signal is stay_away but requireMonitorReady is false.
 *                Caller should log a warning and continue.
 *   "pass"     — no stay_away condition; proceed normally.
 *
 * Unlike the readiness gate (Guard 7), STAY_AWAY is a full-window block when
 * monitorRequired is true — the monitor signal is stable and won't improve
 * during the same 15-min window.
 *
 * Pass `signal = null` (monitor not yet computed) to get "pass" — the
 * readiness gate (Guard 7) will already have deferred this tick.
 */
export function checkWindowMonitorStayAwayGuard(
  signal: { ready: boolean; recommendation: string } | null,
  requireMonitorReady: boolean,
): "block" | "advisory" | "pass" {
  if (!signal?.ready || signal.recommendation !== "stay_away") return "pass";
  return requireMonitorReady ? "block" : "advisory";
}

/**
 * Outcome returned by applyStayAwayGateDecision.
 *
 * "block"    — coin was added to filteredByNewGuards; caller must push a SKIP
 *              result and `continue` (skip Phase 4 entirely for this coin).
 * "advisory" — stay_away but gate is in advisory mode; no guard state mutated.
 * "pass"     — no stay_away condition; proceed to the next Phase-3 check.
 */
export type StayAwayGateOutcome =
  | { action: "block"; reason: string }
  | { action: "advisory" }
  | { action: "pass" };

/**
 * Guard 7b application layer: evaluates the STAY_AWAY signal and, when the
 * outcome is "block", immediately adds `sym` to `filteredByNewGuards` so
 * Phase 4 cannot independently place an order for this coin.
 *
 * Separating the side-effect (Set mutation) from pure logic
 * (checkWindowMonitorStayAwayGuard) lets unit tests inject a mocked signal
 * and assert both the returned outcome and the Set mutation without needing
 * to run the full bot loop or any I/O dependencies.
 */
export function applyStayAwayGateDecision(
  sym: string,
  signal: { ready: boolean; recommendation: string } | null,
  monitorRequired: boolean,
  filteredByNewGuards: Set<string>,
): StayAwayGateOutcome {
  const verdict = checkWindowMonitorStayAwayGuard(signal, monitorRequired);
  if (verdict === "block") {
    filteredByNewGuards.add(sym);
    return {
      action: "block",
      reason: "window_monitor_stay_away — predictor STAY AWAY badge active; skipping entry",
    };
  }
  if (verdict === "advisory") return { action: "advisory" };
  return { action: "pass" };
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
// Manual-order guards — checked by placeManualOrder / closeManualPosition
// ---------------------------------------------------------------------------

/**
 * Guard: duplicate manual position.
 *
 * Returns true (blocked) when there is already an open position for the symbol.
 * Prevents placing a second order before the first is closed.
 */
export function checkDuplicatePositionGuard(hasPosition: boolean): boolean {
  return hasPosition;
}

/**
 * Guard: position must exist for manual close.
 *
 * Throws when no position is found in the map.  Extracted so tests can verify
 * the error message and condition without importing kalshi-bot.ts (which has
 * DB-importing transitive deps incompatible with the native-ESM test runner).
 */
export function checkManualPositionExistsGuard(
  pos: unknown,
  sym: string,
): void {
  if (!pos) {
    throw new Error(`No open position for ${sym}`);
  }
}

/**
 * Guard: position must have been opened via placeManualOrder.
 *
 * Throws when the position's source is not "manual" — bot-opened positions
 * must be managed through the bot controls, not the manual-close endpoint.
 */
export function checkManualSourceGuard(
  source: string,
  sym: string,
): void {
  if (source !== "manual") {
    throw new Error(
      `Position for ${sym} was opened by the bot — use the bot controls to manage it`,
    );
  }
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
  const pauseWindows = coinStreakPauseWindows ?? 4;

  if (limit > 0 && updated.consecutiveLosses >= limit && !updated.pauseUntilWindowKey) {
    const pauseMs = pauseWindows * 15 * 60_000;
    const pauseUntil = new Date(now + pauseMs).toISOString().slice(0, 16);
    updated.pauseUntilWindowKey = pauseUntil;
    updated.consecutiveLosses = 0;
  }

  return updated;
}
