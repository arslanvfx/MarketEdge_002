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
  entryPrice: number;
  stopLoss: number | null;
  targetPrice: number | null;
  /** Running peak price persisted by the bot; null until first long tick. */
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
 * and whether the long-horizon peak price should be updated.
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
  const gainPct = bet.entryPrice > 0 ? ((price - bet.entryPrice) / bet.entryPrice) * 100 : 0;
  let reason: string | null = null;
  let newPeak: number | null = null;

  // Research-avoid override: exit swing/long when Claude says stay away.
  if (bet.tradingMode !== "day" && research?.stance === "avoid") {
    reason = "research_avoid (Claude: stay away/sell)";
  } else if (bet.tradingMode === "day") {
    // Day trades: hard stop/target if set, then forced flat near or after close.
    if (bet.stopLoss != null && price <= bet.stopLoss) {
      reason = "stop_loss";
    } else if (bet.targetPrice != null && price >= bet.targetPrice) {
      reason = "target";
    } else if (nearClose || !marketOpen) {
      reason = "eod_close";
    } else if (heldMs >= maxHoldMs("day", cfg)) {
      reason = "max_hold";
    }
  } else if (bet.tradingMode === "swing") {
    // Swing: per-mode pct if configured, otherwise fall back to global config.
    const swingStop = cfg.swingStopLossPct ?? cfg.stopLossPct;
    const swingTarget = cfg.swingTargetGainPct ?? cfg.targetGainPct;
    if (gainPct <= -swingStop) {
      reason = "swing_stop";
    } else if (gainPct >= swingTarget) {
      reason = "swing_target";
    } else if (bet.stopLoss != null && price <= bet.stopLoss) {
      reason = "stop_loss";
    } else if (heldMs >= maxHoldMs("swing", cfg)) {
      reason = "max_hold";
    }
  } else {
    // Long: trailing stop from per-mode config, falling back to global config.
    const longTrailStop = cfg.longStopLossPct ?? cfg.stopLossPct;
    const peak = Math.max(bet.peakPrice ?? bet.entryPrice, price);
    if (peak > (bet.peakPrice ?? 0)) newPeak = peak;
    const drawdownPct = peak > 0 ? ((peak - price) / peak) * 100 : 0;

    if (research != null && research.confidence < LONG_MIN_RESEARCH_CONF) {
      reason = `research_downgrade (conf ${research.confidence})`;
    } else if (cfg.longTargetGainPct != null && gainPct >= cfg.longTargetGainPct) {
      reason = "long_target";
    } else if (drawdownPct >= longTrailStop) {
      reason = "trailing_stop";
    } else if (bet.stopLoss != null && price <= bet.stopLoss) {
      reason = "stop_loss";
    } else if (heldMs >= maxHoldMs("long", cfg)) {
      reason = "max_hold";
    }
  }

  return { reason, newPeak };
}
