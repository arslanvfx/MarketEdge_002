import type { TradingMode, StockBotConfig } from "./types";

// ── ATR-adaptive stop/target clamps ─────────────────────────────────────────
export const ATR_STOP_MIN_PCT = 0.75;
export const ATR_STOP_MAX_PCT = 12;
export const ATR_TARGET_MIN_PCT = 1.5;
export const ATR_TARGET_MAX_PCT = 25;

export interface RiskControlsInput {
  mode: TradingMode;
  cfg: StockBotConfig;
  /** ATR as % of price, or null when unavailable. */
  atrPct: number | null;
  effectiveConfidence: number;
  equity: number;
  price: number;
  /**
   * Position side. A short's sell limit can fill ABOVE the limit price
   * (price improvement), inflating notional and thus dollar stop-loss beyond
   * the risk budget sized at the limit. Shorts are therefore sized against a
   * conservatively padded price so the risk cap holds even on improved fills.
   */
  side?: "long" | "short";
}

/** Padding applied to the sizing price for shorts (see RiskControlsInput.side). */
export const SHORT_FILL_BUFFER_PCT = 2;

export interface RiskControls {
  stopPct: number;
  targetPct: number;
  useAtr: boolean;
  notional: number;
  qty: number;
}

/**
 * Pure risk engine: ATR-adaptive (or fixed) stop/target distances plus
 * confidence- and risk-based position sizing.
 *  - stop  = atrPct × atrStopMult × horizonScale, clamped to sane bounds
 *  - target = atrPct × atrTargetMult × horizonScale, clamped
 *  - horizonScale: day 1×, swing 1.5×, long 2.5×
 *  - notional: % of equity (optionally confidence-scaled), then capped so a
 *    full stop-out loses at most riskPerTradePct % of equity.
 */
export function computeRiskControls({ mode, cfg, atrPct, effectiveConfidence, equity, price, side }: RiskControlsInput): RiskControls {
  // Conservative sizing price for shorts (improved fills raise exposure).
  const sizingPrice = side === "short" ? price * (1 + SHORT_FILL_BUFFER_PCT / 100) : price;
  const fixedStopPct = mode === "day" ? (cfg.dayStopLossPct ?? cfg.stopLossPct)
    : mode === "swing" ? (cfg.swingStopLossPct ?? cfg.stopLossPct)
    : (cfg.longStopLossPct ?? cfg.stopLossPct);
  const fixedTargetPct = mode === "day" ? (cfg.dayTargetGainPct ?? cfg.targetGainPct)
    : mode === "swing" ? (cfg.swingTargetGainPct ?? cfg.targetGainPct)
    : (cfg.longTargetGainPct ?? cfg.targetGainPct);
  const horizonScale = mode === "day" ? 1 : mode === "swing" ? 1.5 : 2.5;
  const useAtr = cfg.atrStops !== false && typeof atrPct === "number" && atrPct > 0;
  const stopPct = useAtr
    ? Math.min(ATR_STOP_MAX_PCT, Math.max(ATR_STOP_MIN_PCT, atrPct! * (cfg.atrStopMult ?? 1.5) * horizonScale))
    : fixedStopPct;
  const targetPct = useAtr
    ? Math.min(ATR_TARGET_MAX_PCT, Math.max(ATR_TARGET_MIN_PCT, atrPct! * (cfg.atrTargetMult ?? 3) * horizonScale))
    : fixedTargetPct;

  const baseNotional = Math.max(1, (equity * cfg.positionSizePct) / 100);
  let notional: number;
  if (cfg.dynamicSizing) {
    const minConf = cfg.minConfidence;
    const maxConf = 80;
    const t = Math.min(1, Math.max(0, (effectiveConfidence - minConf) / Math.max(1, maxConf - minConf)));
    const maxNotional = cfg.maxPositionDollars ?? baseNotional * 1.5;
    notional = baseNotional + t * (Math.max(maxNotional, baseNotional) - baseNotional);
  } else {
    notional = cfg.maxPositionDollars != null ? Math.min(baseNotional, cfg.maxPositionDollars) : baseNotional;
  }
  if ((cfg.riskPerTradePct ?? 0) > 0 && stopPct > 0) {
    const riskDollars = (equity * cfg.riskPerTradePct) / 100;
    notional = Math.min(notional, riskDollars / (stopPct / 100));
  }
  const qty = sizingPrice > 0 ? Math.floor(notional / sizingPrice) : 0;
  return { stopPct, targetPct, useAtr, notional, qty };
}

/**
 * Exit levels anchored to the CONFIRMED fill price, not the pre-order signal
 * price. A limit order can fill away from the signal price (especially GTC
 * orders filling in a later session), so stops/targets must be derived from
 * the actual entry or the configured distances silently drift.
 * Shorts flip the direction: stop ABOVE entry, target BELOW entry.
 */
export function computeExitLevels(
  filledPrice: number,
  stopPct: number,
  targetPct: number,
  side: "long" | "short",
): { stopLoss: number; targetPrice: number } {
  return side === "short"
    ? { stopLoss: filledPrice * (1 + stopPct / 100), targetPrice: filledPrice * (1 - targetPct / 100) }
    : { stopLoss: filledPrice * (1 - stopPct / 100), targetPrice: filledPrice * (1 + targetPct / 100) };
}

export interface EntryModeInput {
  ticker: string;
  /** Research-recommended horizon, or null for flexible candidates. */
  horizon: TradingMode | null;
  /** Set of held `${ticker}:${mode}` keys for currently open positions. */
  held: ReadonlySet<string>;
  /** Open-position counts per horizon (including entries made this cycle). */
  modeCounts: Readonly<Record<TradingMode, number>>;
  /** Per-horizon position caps. */
  caps: Readonly<Record<TradingMode, number>>;
  /** Horizons the bot is configured to trade. */
  activeModes: readonly TradingMode[];
  /** Pattern-day-trader guard: blocks new day entries when true. */
  pdtBlocked: boolean;
}

export const ENTRY_MODE_PREFERENCE: readonly TradingMode[] = ["day", "swing", "long"];

export function heldKey(ticker: string, mode: TradingMode): string {
  return `${ticker}:${mode}`;
}

/**
 * Resolve which horizon a candidate entry should use.
 *
 * The held guard is per (ticker, horizon): the same ticker may hold concurrent
 * day/swing/long positions, but never two positions in the same horizon.
 * Research-driven candidates only consider their recommended horizon; flexible
 * candidates take the first active mode with capacity (day → swing → long).
 *
 * Returns the chosen mode, or null when no horizon is eligible. `allHeld` is
 * true when every wanted horizon is already held for this ticker (a benign
 * skip that should not be logged as a capacity failure).
 */
export function selectEntryMode(input: EntryModeInput): {
  mode: TradingMode | null;
  allHeld: boolean;
} {
  const wanted: readonly TradingMode[] = input.horizon
    ? [input.horizon]
    : ENTRY_MODE_PREFERENCE;

  const mode =
    wanted.find((m) => {
      if (input.held.has(heldKey(input.ticker, m))) return false;
      if (!input.activeModes.includes(m)) return false;
      if (m === "day" && input.pdtBlocked) return false;
      return (input.modeCounts[m] ?? 0) < (input.caps[m] ?? 0);
    }) ?? null;

  const allHeld = wanted.every((m) => input.held.has(heldKey(input.ticker, m)));
  return { mode, allHeld };
}
