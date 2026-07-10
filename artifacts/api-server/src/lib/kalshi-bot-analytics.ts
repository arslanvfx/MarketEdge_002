// Pure DB-read analytics for the Kalshi bot dashboard.
// No shared module state — all functions only query the database and return
// results, making them safe to extract without circular-state concerns.

import { db, kalshiBotBetsTable, botAutoTuneLogTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
export { backtestModeApproval } from "./kalshi-bot-backtest-core.js";
import { backtestModeApproval } from "./kalshi-bot-backtest-core.js";

type BotMode = "paper" | "live";
type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous" | "position_confirm" | "conviction";

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getBotHistory(limit = 20, filterMode?: BotMode, resetAt?: string | null): Promise<unknown[]> {
  try {
    // Only return terminal outcomes for the recent table — bet entries and
    // intermediate marks (e.g. exit_failed) are excluded for fidelity.
    const modeClause = filterMode ? sql` AND ${kalshiBotBetsTable.mode} = ${filterMode}` : sql``;
    const resetClause = (resetAt && filterMode === "live")
      ? sql` AND ${kalshiBotBetsTable.createdAt} >= ${resetAt}`
      : sql``;
    return await db
      .select()
      .from(kalshiBotBetsTable)
      .where(sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')${modeClause}${resetClause}`)
      .orderBy(desc(kalshiBotBetsTable.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

// Returns the last `limit` completed bets in chronological order (oldest → newest)
// with a rolling 10-bet win rate pre-computed so the frontend can render a sparkline
// without any extra processing.
export interface TrendPoint {
  betNumber: number;
  outcome: "win" | "loss";
  symbol: string;
  pnl: number;
  createdAt: string;
  rollingWinRate: number;  // 10-bet rolling window, 0–1
}

export async function getBotTrend(limit = 50, filterMode?: BotMode, resetAt?: string | null): Promise<TrendPoint[]> {
  try {
    const modeClause = filterMode ? sql` AND ${kalshiBotBetsTable.mode} = ${filterMode}` : sql``;
    const resetClause = (resetAt && filterMode === "live")
      ? sql` AND ${kalshiBotBetsTable.createdAt} >= ${resetAt}`
      : sql``;
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        outcome: kalshiBotBetsTable.outcome,
        createdAt: kalshiBotBetsTable.createdAt,
      })
      .from(kalshiBotBetsTable)
      .where(sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
        AND ${kalshiBotBetsTable.outcome} IS NOT NULL${modeClause}${resetClause}`)
      .orderBy(desc(kalshiBotBetsTable.createdAt))
      .limit(limit);

    // Reverse so the array runs oldest-first for the chart.
    rows.reverse();

    const WINDOW = 10;
    return rows.map((r, i) => {
      const slice = rows.slice(Math.max(0, i - WINDOW + 1), i + 1);
      const wins = slice.filter(s => s.outcome === "win").length;
      return {
        betNumber: i + 1,
        outcome: (r.outcome ?? "loss") as "win" | "loss",
        symbol: r.symbol,
        pnl: parseFloat(r.pnl ?? "0"),
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        rollingWinRate: slice.length > 0 ? wins / slice.length : 0,
      };
    });
  } catch {
    return [];
  }
}

// Returns bet-action records for the bot dashboard. Excludes routine warmup-buffer
// skip rows (one per coin per window — too noisy) but includes gate-skip records
// so entry-veto reasons (consensus, stale-signal, candle-reversal) appear in history.
export async function getBotAllHistory(limit = 100, offset = 0, filterMode?: BotMode, resetAt?: string | null): Promise<unknown[]> {
  try {
    const modeClause = filterMode ? sql` AND ${kalshiBotBetsTable.mode} = ${filterMode}` : sql``;
    const resetClause = (resetAt && filterMode === "live")
      ? sql` AND ${kalshiBotBetsTable.createdAt} >= ${resetAt}`
      : sql``;
    return await db
      .select()
      .from(kalshiBotBetsTable)
      .where(sql`
        ${kalshiBotBetsTable.action} NOT IN ('warmup')
        AND NOT (${kalshiBotBetsTable.action} = 'skip' AND ${kalshiBotBetsTable.signals}->>'reason' IN ('warmup-buffer', 'candle-cache-not-warm'))
        AND ${kalshiBotBetsTable.archivedAt} IS NULL${modeClause}${resetClause}`)
      .orderBy(desc(kalshiBotBetsTable.createdAt))
      .limit(limit)
      .offset(offset);
  } catch {
    return [];
  }
}

export interface CoinBotStats {
  symbol: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
}

export async function getBotStats(filterSymbol?: string, filterMode?: BotMode, resetAt?: string | null): Promise<{
  totalBets: number;
  wins: number;
  losses: number;
  totalPnl: number;
  paperBets: number;
  liveBets: number;
  paperWins: number;
  paperLosses: number;
  liveWins: number;
  liveLosses: number;
  bySymbol: CoinBotStats[];
}> {
  try {
    const baseWhere = sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired') AND ${kalshiBotBetsTable.archivedAt} IS NULL`;
    let whereClause = filterSymbol
      ? sql`${baseWhere} AND ${kalshiBotBetsTable.symbol} = ${filterSymbol.toUpperCase()}`
      : baseWhere;
    if (filterMode) {
      whereClause = sql`${whereClause} AND ${kalshiBotBetsTable.mode} = ${filterMode}`;
    }
    if (resetAt && filterMode === "live") {
      whereClause = sql`${whereClause} AND ${kalshiBotBetsTable.createdAt} >= ${resetAt}`;
    }

    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        mode: kalshiBotBetsTable.mode,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        outcome: kalshiBotBetsTable.outcome,
      })
      .from(kalshiBotBetsTable)
      .where(whereClause);

    let totalBets = 0, wins = 0, losses = 0, totalPnl = 0;
    let paperBets = 0, liveBets = 0;
    let paperWins = 0, paperLosses = 0, liveWins = 0, liveLosses = 0;
    const coinMap = new Map<string, CoinBotStats>();

    for (const r of rows) {
      const p = parseFloat(r.pnl ?? "0");
      const isPaper = r.mode === "paper";
      // Use persisted outcome when available; fall back to pnl sign for rows
      // that haven't been evaluated yet.
      const isWin  = r.outcome ? r.outcome === "win"  : p > 0;
      const isLoss = r.outcome ? r.outcome === "loss" : p < 0;

      totalBets++;
      totalPnl += p;
      if (isWin)  wins++;
      if (isLoss) losses++;
      if (isPaper) {
        paperBets++;
        if (isWin)  paperWins++;
        if (isLoss) paperLosses++;
      } else {
        liveBets++;
        if (isWin)  liveWins++;
        if (isLoss) liveLosses++;
      }

      const sym = r.symbol ?? "UNKNOWN";
      const coin = coinMap.get(sym) ?? { symbol: sym, bets: 0, wins: 0, losses: 0, pnl: 0 };
      coin.bets++;
      coin.pnl += p;
      if (isWin)  coin.wins++;
      if (isLoss) coin.losses++;
      coinMap.set(sym, coin);
    }

    const bySymbol = Array.from(coinMap.values()).sort((a, b) => b.bets - a.bets);

    return {
      totalBets, wins, losses, totalPnl,
      paperBets, liveBets,
      paperWins, paperLosses, liveWins, liveLosses,
      bySymbol,
    };
  } catch {
    return {
      totalBets: 0, wins: 0, losses: 0, totalPnl: 0,
      paperBets: 0, liveBets: 0,
      paperWins: 0, paperLosses: 0, liveWins: 0, liveLosses: 0,
      bySymbol: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Auto-tune log
// ---------------------------------------------------------------------------

export async function getBotAutoTuneLog(limit = 20): Promise<unknown[]> {
  try {
    return await db
      .select()
      .from(botAutoTuneLogTable)
      .orderBy(desc(botAutoTuneLogTable.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

export interface LogicModeStats {
  mode: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  avgConfidence: number | null;
}

/**
 * Returns per-decision-mode win/loss/accuracy stats from settled bets.
 * Historical bets with a null decision_mode are bucketed as "classic".
 * avgConfidence is computed from the statConfidence/claudeConfidence fields
 * stored in the signals JSONB snapshot at bet-placement time.
 */
export async function getBotLogicPerformance(filterMode?: BotMode): Promise<LogicModeStats[]> {
  try {
    const modeClause = filterMode ? sql` AND ${kalshiBotBetsTable.mode} = ${filterMode}` : sql``;
    const rows = await db
      .select({
        decisionMode: kalshiBotBetsTable.decisionMode,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        outcome: kalshiBotBetsTable.outcome,
        signals: kalshiBotBetsTable.signals,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.archivedAt} IS NULL${modeClause}`,
      );

    const modeMap = new Map<string, { bets: number; wins: number; losses: number; pnl: number; confSum: number; confCount: number }>();

    for (const r of rows) {
      const mode = r.decisionMode ?? "classic";
      const p = parseFloat(r.pnl ?? "0");
      const isWin  = r.outcome ? r.outcome === "win"  : p > 0;
      const isLoss = r.outcome ? r.outcome === "loss" : p < 0;

      // Use effectiveConfidence (the actual decision threshold) from the signals snapshot.
      // This is the value the bot compared against minConfidence when placing the bet,
      // so it accurately reflects how strongly the system committed to the trade.
      const sigs = r.signals as Record<string, unknown> | null;
      const avgConf = typeof sigs?.effectiveConfidence === "number" ? sigs.effectiveConfidence : null;

      const entry = modeMap.get(mode) ?? { bets: 0, wins: 0, losses: 0, pnl: 0, confSum: 0, confCount: 0 };
      entry.bets++;
      entry.pnl += p;
      if (isWin)  entry.wins++;
      if (isLoss) entry.losses++;
      if (avgConf != null) { entry.confSum += avgConf; entry.confCount++; }
      modeMap.set(mode, entry);
    }

    const ALL_MODES: DecisionMode[] = ["classic", "ml_gate", "consensus", "unanimous"];
    const result: LogicModeStats[] = [];

    const toStats = (e: { bets: number; wins: number; losses: number; pnl: number; confSum: number; confCount: number }, m: string): LogicModeStats => ({
      mode: m,
      bets: e.bets,
      wins: e.wins,
      losses: e.losses,
      pnl: e.pnl,
      winRate: e.bets > 0 ? e.wins / e.bets : null,
      avgConfidence: e.confCount > 0 ? Math.round(e.confSum / e.confCount * 10) / 10 : null,
    });

    for (const m of ALL_MODES) {
      result.push(toStats(modeMap.get(m) ?? { bets: 0, wins: 0, losses: 0, pnl: 0, confSum: 0, confCount: 0 }, m));
    }

    for (const [m, e] of modeMap.entries()) {
      if (!(ALL_MODES as string[]).includes(m)) {
        result.push(toStats(e, m));
      }
    }

    return result;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Conviction price threshold analysis
// ---------------------------------------------------------------------------

export interface ConvictionPriceBand {
  /** Label shown in UI, e.g. "88–90¢" */
  band: string;
  /** Lower bound (inclusive), 0–1 scale */
  lowerBound: number;
  /** Upper bound (exclusive), 0–1 scale */
  upperBound: number;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
}

/**
 * Returns win-rate / P&L breakdown of conviction-mode bets by YES-price band.
 * Bands: <88¢, 88–90¢, 90–92¢, 92–95¢, ≥95¢
 * Also returns a suggestedLockPrice (band lower-bound with highest win rate, ≥5 bets).
 */
export async function getConvictionThresholdAnalysis(
  filterMode?: BotMode,
): Promise<{ bands: ConvictionPriceBand[]; suggestedLockPrice: number | null; totalBets: number }> {
  const BANDS: Array<{ band: string; lo: number; hi: number }> = [
    { band: "<88¢",   lo: 0,    hi: 0.88 },
    { band: "88–90¢", lo: 0.88, hi: 0.90 },
    { band: "90–92¢", lo: 0.90, hi: 0.92 },
    { band: "92–95¢", lo: 0.92, hi: 0.95 },
    { band: "≥95¢",   lo: 0.95, hi: 1.01 },
  ];

  try {
    const modeClause = filterMode ? sql` AND ${kalshiBotBetsTable.mode} = ${filterMode}` : sql``;
    const rows = await db
      .select({
        direction: kalshiBotBetsTable.direction,
        entryYesPrice: kalshiBotBetsTable.entryYesPrice,
        outcome: kalshiBotBetsTable.outcome,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.decisionMode} = 'conviction'
          AND ${kalshiBotBetsTable.entryYesPrice} IS NOT NULL
          AND ${kalshiBotBetsTable.archivedAt} IS NULL${modeClause}`,
      );

    const acc = BANDS.map(b => ({ ...b, bets: 0, wins: 0, losses: 0, pnl: 0 }));

    for (const r of rows) {
      const rawPrice = parseFloat(String(r.entryYesPrice));
      if (isNaN(rawPrice) || rawPrice <= 0) continue;
      // For NO bets the stored price is the YES side (low price) — use the
      // effective "locked" side to match conviction logic.
      const dir = r.direction as string | null;
      const lockedPrice = dir === "no" ? 1 - rawPrice : rawPrice;
      const p = parseFloat(r.pnl ?? "0");
      const isWin  = r.outcome === "win"  || (r.outcome == null && p > 0);
      const isLoss = r.outcome === "loss" || (r.outcome == null && p < 0);

      for (const b of acc) {
        if (lockedPrice >= b.lo && lockedPrice < b.hi) {
          b.bets++;
          b.pnl += p;
          if (isWin)  b.wins++;
          if (isLoss) b.losses++;
          break;
        }
      }
    }

    const bands: ConvictionPriceBand[] = acc.map(b => ({
      band: b.band,
      lowerBound: b.lo,
      upperBound: b.hi,
      bets: b.bets,
      wins: b.wins,
      losses: b.losses,
      pnl: b.pnl,
      winRate: b.bets > 0 ? b.wins / b.bets : null,
    }));

    // Suggest the lower-bound of the best band that has ≥5 bets
    const eligible = bands.filter(b => b.bets >= 5 && b.lowerBound > 0 && b.winRate != null);
    const bestBand = eligible.reduce<ConvictionPriceBand | null>(
      (best, b) => (best == null || b.winRate! > best.winRate! ? b : best),
      null,
    );

    return {
      bands,
      suggestedLockPrice: bestBand ? bestBand.lowerBound : null,
      totalBets: rows.length,
    };
  } catch {
    return { bands: [], suggestedLockPrice: null, totalBets: 0 };
  }
}

// ---------------------------------------------------------------------------
// Decision mode backtest
// ---------------------------------------------------------------------------

export interface BacktestModeStats {
  mode: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  /** Fraction of total settled bets this mode would have taken (0–1). */
  coverage: number;
}

/**
 * Replays all settled bets through each mode's gating logic using the stored
 * signals snapshot (statAbove / claudeAbove / mlAbove) and returns projected
 * win-rate, P&L, and coverage for each mode.
 *
 * classic  — approves every existing bet (the cascade placed them all)
 * ml_gate  — runs core pair (PATH B/C) without ML; then vetoes if ML disagrees
 * consensus — requires ≥2 of [stat, claude, ml] to agree on majority direction;
 *             falls back to classic when fewer than 2 signals are available
 */
export async function getBacktestModes(): Promise<BacktestModeStats[]> {
  try {
    const rows = await db
      .select({
        direction: kalshiBotBetsTable.direction,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        outcome: kalshiBotBetsTable.outcome,
        signals: kalshiBotBetsTable.signals,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.archivedAt} IS NULL`,
      );

    const ALL_MODES = ["classic", "ml_gate", "consensus", "unanimous"] as const;
    const modeAcc = new Map<string, { bets: number; wins: number; losses: number; pnl: number }>(
      ALL_MODES.map(m => [m, { bets: 0, wins: 0, losses: 0, pnl: 0 }]),
    );
    const total = rows.length;

    for (const r of rows) {
      const dir = r.direction as string | null;
      if (!dir) continue;

      const sigs = r.signals as Record<string, unknown> | null;
      const statAbove   = typeof sigs?.statAbove   === "boolean" ? sigs.statAbove   : null;
      const claudeAbove = typeof sigs?.claudeAbove === "boolean" ? sigs.claudeAbove : null;
      const mlAbove     = typeof sigs?.mlAbove     === "boolean" ? sigs.mlAbove     : null;
      const statConf    = typeof sigs?.statConfidence   === "number" ? sigs.statConfidence   : null;
      const claudeConf  = typeof sigs?.claudeConfidence === "number" ? sigs.claudeConfidence : null;
      const mlConf      = typeof sigs?.mlConfidence     === "number" ? sigs.mlConfidence     : null;

      const p      = parseFloat(r.pnl ?? "0");
      const isWin  = r.outcome ? r.outcome === "win"  : p > 0;
      const isLoss = r.outcome ? r.outcome === "loss" : p < 0;

      // Does a signal agree with the actual bet direction?
      const aboveExpected = dir === "yes";

      for (const mode of ALL_MODES) {
        const approved = backtestModeApproval(mode, aboveExpected, statAbove, claudeAbove, mlAbove, statConf, claudeConf, mlConf);

        if (approved) {
          const e = modeAcc.get(mode)!;
          e.bets++;
          e.pnl += p;
          if (isWin)  e.wins++;
          if (isLoss) e.losses++;
        }
      }
    }

    return ALL_MODES.map(mode => {
      const e = modeAcc.get(mode)!;
      return {
        mode,
        bets: e.bets,
        wins: e.wins,
        losses: e.losses,
        pnl: e.pnl,
        winRate: e.bets > 0 ? e.wins / e.bets : null,
        coverage: total > 0 ? e.bets / total : 1,
      };
    });
  } catch {
    return [];
  }
}
