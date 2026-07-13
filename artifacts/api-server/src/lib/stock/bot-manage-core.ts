// Pure exit-decision logic extracted from managePositions() so it can be
// unit-tested without a DB connection, live broker, or any async side effects.
// bot.ts imports and delegates to evaluateExitReason(); only the DB/broker
// calls (openBets, getLatestPrice, updatePeak, exitPosition) remain there.

import type { TradingMode, StockBotConfig } from "./types.ts";

// ── Constants (mirrors the ones in bot.ts) ───────────────────────────────────
export const DAY_EOD_BUFFER_MS = 15 * 60 * 1000;
export const SWING_STOP_PCT = 4;
export const SWING_TARGET_PCT = 8;
export const LONG_MIN_RESEARCH_CONF = 60;
export const LONG_TRAIL_STOP_PCT = 6;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExitBetInput {
  tradingMode: TradingMode;
  /** "long" = bought stock, profits when price rises. "short" = sold short, profits when price falls. Defaults to "long". */
  side?: "long" | "short";
  entryPrice: number;
  stopLoss: number | null;
  targetPrice: number | null;
  /**
   * Long positions: running peak price (for trailing stop from high).
   * Short positions: running trough price (for trailing stop from low).
   * Null until first tick.
   */
  peakPrice: number | null;
  createdAt: Date;
}

export interface ExitResearch {
  stance: string;
  confidence: number;
}

export interface EvaluateExitParams {
  bet: ExitBetInput;
  /** Current market price for this ticker. */
  price: number;
  cfg: StockBotConfig;
  /** Whether the equity market is currently open. */
  marketOpen: boolean;
  /** True when the market is open AND within DAY_EOD_BUFFER_MS of its close. */
  nearClose: boolean;
  /** Date.now() at the start of the evaluation — injected for determinism. */
  nowMs: number;
  /**
   * Latest research report for this ticker (swing / long only).
   * - stance === "avoid" triggers research_avoid exit.
   * - confidence < LONG_MIN_RESEARCH_CONF triggers research_downgrade for longs.
   * Pass null when no research is available or for day trades.
   */
  research: ExitResearch | null;
}

export interface EvaluateExitResult {
  /** Exit reason string, or null if the position should remain open. */
  reason: string | null;
  /**
   * Updated peak price for long positions (to be persisted via updatePeak).
   * Null means the peak did not advance and no DB write is needed.
   */
  newPeak: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function maxHoldMs(mode: TradingMode, cfg: StockBotConfig): number {
  if (mode === "day") return 6.5 * 60 * 60 * 1000;
  if (mode === "swing") return cfg.swingMaxHoldDays * 24 * 60 * 60 * 1000;
  return cfg.longMaxHoldDays * 24 * 60 * 60 * 1000;
}

// ── Core pure decision ────────────────────────────────────────────────────────

/**
 * Given a bet and its current market snapshot, returns the exit reason (if any)
 * and whether the peak/trough price should be updated.
 *
 * Handles both long and short positions:
 *   Long:  profits when price rises. Stop below entry, target above entry.
 *          Trailing stop tracks the running PEAK (highest price reached).
 *   Short: profits when price falls. Stop above entry, target below entry.
 *          Trailing stop tracks the running TROUGH (lowest price reached).
 *
 * All inputs are plain values — no I/O, no side effects.
 */
export function evaluateExitReason({
  bet,
  price,
  cfg,
  marketOpen,
  nearClose,
  nowMs,
  research,
}: EvaluateExitParams): EvaluateExitResult {
  const heldMs = nowMs - bet.createdAt.getTime();
  const side = bet.side ?? "long";

  // Directional gain: positive = profit for either side
  const gainPct = bet.entryPrice > 0
    ? side === "short"
      ? ((bet.entryPrice - price) / bet.entryPrice) * 100
      : ((price - bet.entryPrice) / bet.entryPrice) * 100
    : 0;

  let reason: string | null = null;
  let newPeak: number | null = null;

  // Research-avoid override: exit swing/long when Claude says stay away.
  // For shorts: research_avoid means Claude says the stock is recovering — cover.
  if (bet.tradingMode !== "day" && research?.stance === "avoid") {
    reason = side === "short"
      ? "research_cover (Claude: stock recovering — cover short)"
      : "research_avoid (Claude: stay away/sell)";
  } else if (bet.tradingMode === "day") {
    // Day trades: hard stop/target if set, then forced flat near or after close.
    const hitStop = bet.stopLoss != null && (
      side === "short" ? price >= bet.stopLoss : price <= bet.stopLoss
    );
    const hitTarget = bet.targetPrice != null && (
      side === "short" ? price <= bet.targetPrice : price >= bet.targetPrice
    );
    if (hitStop) {
      reason = "stop_loss";
    } else if (hitTarget) {
      reason = "target";
    } else if (nearClose || !marketOpen) {
      reason = "eod_close";
    } else if (heldMs >= maxHoldMs("day", cfg)) {
      reason = "max_hold";
    }
  } else if (bet.tradingMode === "swing") {
    const swingStop = cfg.swingStopLossPct ?? cfg.stopLossPct;
    const swingTarget = cfg.swingTargetGainPct ?? cfg.targetGainPct;
    const hitHardStop = bet.stopLoss != null && (
      side === "short" ? price >= bet.stopLoss : price <= bet.stopLoss
    );
    if (gainPct <= -swingStop) {
      reason = "swing_stop";
    } else if (gainPct >= swingTarget) {
      reason = "swing_target";
    } else if (hitHardStop) {
      reason = "stop_loss";
    } else if (heldMs >= maxHoldMs("swing", cfg)) {
      reason = "max_hold";
    }
  } else {
    // Long/Short multi-week position: trailing stop.
    const longTrailStop = cfg.longStopLossPct ?? cfg.stopLossPct;

    if (side === "short") {
      // Short: trough = lowest price (stored in peakPrice field for simplicity).
      const trough = Math.min(bet.peakPrice ?? bet.entryPrice, price);
      if (trough < (bet.peakPrice ?? bet.entryPrice)) newPeak = trough;
      // Drawdown = how far price has rebounded from the trough
      const reboundPct = trough > 0 ? ((price - trough) / trough) * 100 : 0;
      const hitHardStop = bet.stopLoss != null && price >= bet.stopLoss;

      if (research != null && research.confidence < LONG_MIN_RESEARCH_CONF) {
        reason = `research_downgrade (conf ${research.confidence})`;
      } else if (cfg.longTargetGainPct != null && gainPct >= cfg.longTargetGainPct) {
        reason = "long_target";
      } else if (reboundPct >= longTrailStop) {
        reason = "trailing_stop";
      } else if (hitHardStop) {
        reason = "stop_loss";
      } else if (heldMs >= maxHoldMs("long", cfg)) {
        reason = "max_hold";
      }
    } else {
      // Long: peak = highest price.
      const peak = Math.max(bet.peakPrice ?? bet.entryPrice, price);
      if (peak > (bet.peakPrice ?? 0)) newPeak = peak;
      const drawdownPct = peak > 0 ? ((peak - price) / peak) * 100 : 0;
      const hitHardStop = bet.stopLoss != null && price <= bet.stopLoss;

      if (research != null && research.confidence < LONG_MIN_RESEARCH_CONF) {
        reason = `research_downgrade (conf ${research.confidence})`;
      } else if (cfg.longTargetGainPct != null && gainPct >= cfg.longTargetGainPct) {
        reason = "long_target";
      } else if (drawdownPct >= longTrailStop) {
        reason = "trailing_stop";
      } else if (hitHardStop) {
        reason = "stop_loss";
      } else if (heldMs >= maxHoldMs("long", cfg)) {
        reason = "max_hold";
      }
    }
  }

  return { reason, newPeak };
}
