// Pure DB-read analytics for the Kalshi bot dashboard.
// No shared module state — all functions only query the database and return
// results, making them safe to extract without circular-state concerns.

import { db, kalshiBotBetsTable, botAutoTuneLogTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
export { backtestModeApproval } from "./kalshi-bot-backtest-core.js";
import { backtestModeApproval } from "./kalshi-bot-backtest-core.js";

type BotMode = "paper" | "live";
type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous" | "conviction";

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

// ---------------------------------------------------------------------------
// Conviction stability analysis
// ---------------------------------------------------------------------------

export interface StabilityThresholdRow {
  /** Human-readable threshold label, e.g. "ER ≥ 0.30" */
  label: string;
  threshold: number;
  /** Bets classified as "stable" at this threshold */
  stableBets: number;
  stableWins: number;
  stableWinRate: number | null;
  stablePnl: number;
  /** Bets classified as "volatile" at this threshold */
  volatileBets: number;
  volatileWins: number;
  volatileWinRate: number | null;
  volatilePnl: number;
  /** Win-rate difference (stable − volatile); positive = stable outperforms */
  winRateDelta: number | null;
}

export interface StabilityDimensionAnalysis {
  dimension: "er" | "osc" | "volPct" | "mlConf";
  label: string;
  /** Higher/lower = stable classification direction */
  direction: "above" | "below";
  rows: StabilityThresholdRow[];
  /** Threshold that maximises win-rate delta for stable vs volatile (≥5 stable bets) */
  suggestedThreshold: number | null;
  currentDefault: number;
}

export interface ConvictionStabilityAnalysis {
  totalBets: number;
  /** Bets with stability metrics stored (stabilityEr != null) */
  betsWithStabilityData: number;
  /** Overall stable-classified win rate vs volatile-classified win rate */
  overallStableWinRate: number | null;
  overallVolatileWinRate: number | null;
  /** Per-dimension threshold scans */
  dimensions: StabilityDimensionAnalysis[];
  /** Composite: win rate when ALL four current defaults are met */
  currentDefaultsStableWinRate: number | null;
  currentDefaultsStableBets: number;
  currentDefaultsVolatileWinRate: number | null;
  currentDefaultsVolatileBets: number;
  /** Suggested updated defaults based on empirical data (null when insufficient data) */
  suggestedDefaults: {
    minER: number | null;
    maxOsc: number | null;
    maxVolPct: number | null;
    minMLConf: number | null;
  };
}

/**
 * Analyses historical conviction-mode bets to determine optimal stability thresholds.
 *
 * Each bet's signals JSONB must contain stabilityEr/stabilityOsc/stabilityVolPct/
 * stabilityMlConf (persisted since Task #393). For each dimension, we scan a range
 * of candidate thresholds and compute the win-rate split between "stable" and
 * "volatile" classifications. The threshold that maximises the stable–volatile delta
 * with ≥5 stable bets is surfaced as the suggested threshold.
 */
export async function getConvictionStabilityAnalysis(
  filterMode?: BotMode,
): Promise<ConvictionStabilityAnalysis> {
  const EMPTY: ConvictionStabilityAnalysis = {
    totalBets: 0,
    betsWithStabilityData: 0,
    overallStableWinRate: null,
    overallVolatileWinRate: null,
    dimensions: [],
    currentDefaultsStableWinRate: null,
    currentDefaultsStableBets: 0,
    currentDefaultsVolatileWinRate: null,
    currentDefaultsVolatileBets: 0,
    suggestedDefaults: { minER: null, maxOsc: null, maxVolPct: null, minMLConf: null },
  };

  try {
    const modeClause = filterMode ? sql` AND ${kalshiBotBetsTable.mode} = ${filterMode}` : sql``;

    const rows = await db
      .select({
        outcome: kalshiBotBetsTable.outcome,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        signals: kalshiBotBetsTable.signals,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.decisionMode} = 'conviction'
          AND ${kalshiBotBetsTable.archivedAt} IS NULL${modeClause}`,
      );

    if (rows.length === 0) return { ...EMPTY, totalBets: 0 };

    // Extract stability metrics from signals JSONB for each settled bet.
    interface BetRecord {
      win: boolean;
      loss: boolean;
      pnl: number;
      er: number | null;
      osc: number | null;
      volPct: number | null;
      mlConf: number | null;
      stable: boolean | null;
    }

    const bets: BetRecord[] = rows.map(r => {
      const sig = (r.signals ?? {}) as Record<string, unknown>;
      const p = parseFloat(r.pnl ?? "0");
      const isWin  = r.outcome === "win"  || (r.outcome == null && p > 0);
      const isLoss = r.outcome === "loss" || (r.outcome == null && p < 0);
      return {
        win: isWin,
        loss: isLoss,
        pnl: p,
        er:      sig.stabilityEr     != null ? Number(sig.stabilityEr)     : null,
        osc:     sig.stabilityOsc    != null ? Number(sig.stabilityOsc)    : null,
        volPct:  sig.stabilityVolPct != null ? Number(sig.stabilityVolPct) : null,
        mlConf:  sig.stabilityMlConf != null ? Number(sig.stabilityMlConf) : null,
        stable:  sig.stabilityStable != null ? Boolean(sig.stabilityStable) : null,
      };
    });

    const betsWithData = bets.filter(b => b.er !== null);
    const totalBets = bets.length;

    // Current defaults (must stay in sync with DEFAULT_BOT_CONFIG in engine-core.ts).
    const CUR_MIN_ER    = 0.30;
    const CUR_MAX_OSC   = 8;
    const CUR_MAX_VOL   = 3.0;
    const CUR_MIN_ML    = 52;

    // Helper: compute win-rate accumulator for a boolean split.
    function split(list: BetRecord[], isStable: (b: BetRecord) => boolean) {
      let sw = 0, sl = 0, sp = 0, vw = 0, vl = 0, vp = 0;
      for (const b of list) {
        if (isStable(b)) { if (b.win) sw++; if (b.loss) sl++; sp += b.pnl; }
        else             { if (b.win) vw++; if (b.loss) vl++; vp += b.pnl; }
      }
      const sb = sw + sl, vb = vw + vl;
      return { stableWins: sw, stableLosses: sl, stableBets: sb, stablePnl: sp,
               volatileWins: vw, volatileLosses: vl, volatileBets: vb, volatilePnl: vp,
               stableWinRate: sb > 0 ? sw / sb : null,
               volatileWinRate: vb > 0 ? vw / vb : null };
    }

    // Overall stable vs volatile using the stabilityStable flag stored at entry.
    const betsWithFlag = bets.filter(b => b.stable !== null);
    const overall = split(betsWithFlag, b => b.stable === true);
    const overallStableWinRate  = overall.stableWinRate;
    const overallVolatileWinRate = overall.volatileWinRate;

    // Current-defaults composite split (only bets with all four metrics).
    const betsAll = bets.filter(b =>
      b.er !== null && b.osc !== null && b.volPct !== null,
    );
    const defSplit = split(betsAll, b =>
      b.er! >= CUR_MIN_ER &&
      b.osc! <= CUR_MAX_OSC &&
      b.volPct! <= CUR_MAX_VOL &&
      (b.mlConf === null || b.mlConf >= CUR_MIN_ML),
    );

    // Per-dimension threshold scan.
    // For each dimension we enumerate candidate thresholds, split, and record the delta.
    const MIN_STABLE_BETS = 5; // require at least 5 stable bets before suggesting

    function scanDimension(
      dimension: StabilityDimensionAnalysis["dimension"],
      label: string,
      direction: "above" | "below",
      candidates: number[],
      currentDefault: number,
      getValue: (b: BetRecord) => number | null,
    ): StabilityDimensionAnalysis {
      const eligible = bets.filter(b => getValue(b) !== null);
      const rows_: StabilityThresholdRow[] = candidates.map(thr => {
        const isStable = direction === "above"
          ? (b: BetRecord) => (getValue(b) ?? -Infinity) >= thr
          : (b: BetRecord) => (getValue(b) ?? Infinity) <= thr;
        const s = split(eligible, isStable);
        const delta = s.stableWinRate != null && s.volatileWinRate != null
          ? s.stableWinRate - s.volatileWinRate
          : null;
        return {
          label: direction === "above" ? `${label} ≥ ${thr}` : `${label} ≤ ${thr}`,
          threshold: thr,
          stableBets: s.stableBets,
          stableWins: s.stableWins,
          stableWinRate: s.stableWinRate,
          stablePnl: s.stablePnl,
          volatileBets: s.volatileBets,
          volatileWins: s.volatileWins,
          volatileWinRate: s.volatileWinRate,
          volatilePnl: s.volatilePnl,
          winRateDelta: delta,
        };
      });

      // Best threshold = highest delta with ≥ MIN_STABLE_BETS stable bets.
      const eligible_ = rows_.filter(r => r.stableBets >= MIN_STABLE_BETS && r.winRateDelta != null);
      const best = eligible_.reduce<StabilityThresholdRow | null>(
        (acc, r) => (acc == null || r.winRateDelta! > acc.winRateDelta! ? r : acc),
        null,
      );

      return { dimension, label, direction, rows: rows_, suggestedThreshold: best?.threshold ?? null, currentDefault };
    }

    const dimensions: StabilityDimensionAnalysis[] = [
      scanDimension(
        "er", "ER", "above",
        [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50],
        CUR_MIN_ER,
        b => b.er,
      ),
      scanDimension(
        "osc", "Oscillations", "below",
        [4, 5, 6, 7, 8, 9, 10, 12],
        CUR_MAX_OSC,
        b => b.osc,
      ),
      scanDimension(
        "volPct", "Volatility %", "below",
        [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0],
        CUR_MAX_VOL,
        b => b.volPct,
      ),
      scanDimension(
        "mlConf", "ML Confidence", "above",
        [50, 52, 54, 56, 58, 60, 62, 65],
        CUR_MIN_ML,
        // null ML passes the gate — treat as the minimum threshold for scan purposes.
        b => b.mlConf ?? 50,
      ),
    ];

    const suggestedDefaults = {
      minER:    dimensions[0].suggestedThreshold,
      maxOsc:   dimensions[1].suggestedThreshold,
      maxVolPct: dimensions[2].suggestedThreshold,
      minMLConf: dimensions[3].suggestedThreshold != null
        ? Math.round(dimensions[3].suggestedThreshold)
        : null,
    };

    return {
      totalBets,
      betsWithStabilityData: betsWithData.length,
      overallStableWinRate,
      overallVolatileWinRate,
      dimensions,
      currentDefaultsStableWinRate: defSplit.stableWinRate,
      currentDefaultsStableBets: defSplit.stableBets,
      currentDefaultsVolatileWinRate: defSplit.volatileWinRate,
      currentDefaultsVolatileBets: defSplit.volatileBets,
      suggestedDefaults,
    };
  } catch {
    return EMPTY;
  }
}

// ---------------------------------------------------------------------------
// Scale Phase Tracker
// ---------------------------------------------------------------------------

export const SCALE_PHASE_PRESETS = [
  { phase: 1, betSize: 3,  maxBetSize: 6,  targetBets: 150, winRateGate: 0.85, label: "Test"  },
  { phase: 2, betSize: 7,  maxBetSize: 15, targetBets: 150, winRateGate: 0.85, label: "Build" },
  { phase: 3, betSize: 10, maxBetSize: 25, targetBets: 0,   winRateGate: 0,    label: "Full"  },
] as const;

export interface PhaseStatus {
  phase: number;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number;
  betTargetPassed: boolean;
  winRatePassed: boolean;
  pnlPassed: boolean;
  allPassed: boolean;
  isLastPhase: boolean;
  targetBets: number;
  betSize: number;
  maxBetSize: number;
  label: string;
  nextBetSize: number | null;
  nextMaxBetSize: number | null;
}

export async function getPhaseStatus(phase: number, phaseStartedAt: string | null | undefined): Promise<PhaseStatus> {
  const preset = SCALE_PHASE_PRESETS.find(p => p.phase === phase) ?? SCALE_PHASE_PRESETS[0];
  const nextPreset = SCALE_PHASE_PRESETS.find(p => p.phase === phase + 1) ?? null;
  const isLastPhase = phase >= 3;

  try {
    let whereClause = sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
      AND ${kalshiBotBetsTable.archivedAt} IS NULL
      AND ${kalshiBotBetsTable.mode} = 'live'
      AND ${kalshiBotBetsTable.exitedAt} IS NOT NULL`;

    if (phaseStartedAt) {
      whereClause = sql`${whereClause} AND ${kalshiBotBetsTable.createdAt} >= ${phaseStartedAt}`;
    }

    const rows = await db
      .select({
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        outcome: kalshiBotBetsTable.outcome,
      })
      .from(kalshiBotBetsTable)
      .where(whereClause);

    let bets = 0, wins = 0, losses = 0, pnl = 0;
    for (const r of rows) {
      const p = parseFloat(r.pnl ?? "0");
      const isWin  = r.outcome ? r.outcome === "win"  : p > 0;
      const isLoss = r.outcome ? r.outcome === "loss" : p < 0;
      bets++;
      pnl += p;
      if (isWin)  wins++;
      if (isLoss) losses++;
    }

    const winRate = bets > 0 ? wins / bets : 0;
    const betTargetPassed = isLastPhase || bets >= preset.targetBets;
    const winRatePassed   = isLastPhase || winRate >= preset.winRateGate;
    const pnlPassed       = isLastPhase || pnl > 0;
    const allPassed       = !isLastPhase && betTargetPassed && winRatePassed && pnlPassed;

    return {
      phase,
      bets, wins, losses,
      pnl: Math.round(pnl * 100) / 100,
      winRate,
      betTargetPassed, winRatePassed, pnlPassed, allPassed,
      isLastPhase,
      targetBets: preset.targetBets,
      betSize: preset.betSize,
      maxBetSize: preset.maxBetSize,
      label: preset.label,
      nextBetSize: nextPreset?.betSize ?? null,
      nextMaxBetSize: nextPreset?.maxBetSize ?? null,
    };
  } catch {
    return {
      phase, bets: 0, wins: 0, losses: 0, pnl: 0, winRate: 0,
      betTargetPassed: false, winRatePassed: false, pnlPassed: false, allPassed: false,
      isLastPhase,
      targetBets: preset.targetBets,
      betSize: preset.betSize,
      maxBetSize: preset.maxBetSize,
      label: preset.label,
      nextBetSize: nextPreset?.betSize ?? null,
      nextMaxBetSize: nextPreset?.maxBetSize ?? null,
    };
  }
}
