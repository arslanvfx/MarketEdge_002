import type { TradingMode } from "./types";

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
