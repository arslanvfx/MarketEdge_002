// Kalshi auto-betting bot — orchestration layer.
//
// State machine:
//   IDLE → (window opens + BET decision) → OPEN_POSITION
//   OPEN_POSITION → (exit guard clears OR window closes) → IDLE
//
// Paper mode: all trade calls are simulated; DB records are written with mode="paper".
// Live mode: requires KALSHI_API_KEY secret and explicit user toggle.

import { db, kalshiBotBetsTable, botConfigTable, botAutoTuneLogTable } from "@workspace/db";
import { isAiFeatureEnabled } from "./ai-spend";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  DEFAULT_BOT_CONFIG,
  BET_PROFILES,
  makeBotDecision,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  checkMomentumOverride,
  deriveRegime,
  type BotConfig,
  type BotDecision,
  type CircuitBreakerState,
  type PriceRegime,
  type DecisionMode,
} from "./kalshi-bot-engine";
import {
  makeInitialExitState,
  runExitGuard,
  type ExitState,
  type GuardStates,
} from "./kalshi-bot-exit";
import { buyYes, buyNo, sellYes, sellNo, getBalance, isKalshiConfigured, placeOrderWithRetry } from "./kalshi-trader";
import {
  getKalshiWindowContext,
  getTimingAnalysis,
  intraWindowMetrics,
  getCachedPrediction,
  getKalshiCachedData,
  fetchKalshiTarget,
  fetchLiveDirection,
  fetchTrendStabilityForBot,
  getPredictionAnalytics,
  getConfirmedTargetMs,
  CRYPTO_COINS,
  KALSHI_SERIES,
  type TrendStability,
} from "./crypto";
import {
  computePerformanceReport,
  runAutoTuneRules,
  decrementPausedCoins,
  type PerformanceReport,
  type AutoTuneMutation,
  type SettledBetRecord,
} from "./kalshi-bot-performance";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BotMode = "paper" | "live";
export type BotStatus = "idle" | "position_open" | "paused" | "daily_limit_hit";

export interface OpenPosition {
  id: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  direction: "yes" | "no";
  entryYesPrice: number;    // fraction 0-1
  contractCount: number;
  betAmount: number;        // $ spent
  kalshiTarget: number;
  openedAt: number;         // ms timestamp
  cryptoPriceAtEntry: number | null; // spot price of the coin when the bet was placed
  exitState: ExitState;
  entryDecision: BotDecision;
  phase2Activated: boolean;
}

// OpenPosition augmented with live display data (P&L, guard states) for the
// dashboard.  Only used in the outbound API snapshot — not stored in DB.
export interface OpenPositionDisplay extends OpenPosition {
  currentYesPrice: number | null;   // live Kalshi yes-price for mark-to-market
  unrealizedPnl: number | null;     // estimated P&L at current mark
  guardStates: GuardStates | null;  // most-recent exit-guard evaluation for this position
  guardReason: string | null;
}

export interface BotStateSnapshot {
  mode: BotMode;
  status: BotStatus;
  paused: boolean;
  config: BotConfig;
  openPositions: OpenPositionDisplay[];  // one entry per symbol with an open bet
  dailyPnl: number;
  dailyLossCount: number;
  dailyDate: string;        // YYYY-MM-DD in UTC
  accountBalance: number | null;
  lastUpdatedAt: string;
  configured: boolean;      // KALSHI_API_KEY present
  // Seconds remaining in the 45-second warmup period at the start of each window.
  // null when warmup is over or positions are already open.
  warmupSecondsRemaining: number | null;
  // Circuit breaker: how many windows remain before new entries are re-enabled.
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  // Whether the current UTC hour falls within the configured quiet-hours window.
  isInQuietHours: boolean;
}

// Per-coin evaluation result from the best-market selection pass.
// Populated by runBotLoopTick and exposed via getWindowEvaluation().
export interface WindowCoinEvaluation {
  symbol: string;
  action: "BET_YES" | "BET_NO" | "SKIP";
  confidence: number;          // 0-100 from makeBotDecision
  score: number;               // composite: confidence × timingAcc / 100 × stabilityMultiplier
  reason: string;              // short human-readable explanation
  windowKey: string;
  selected: boolean;           // true for the coin chosen for the bet
  evaluatedAt: string;         // ISO timestamp
  trendStability: TrendStability | null; // from window-open Claude analysis (null = not yet ready)
  regime: PriceRegime | null;  // price-trend regime derived from recent Kalshi strikes
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let botMode: BotMode = "paper";
let paused = false;
let config: BotConfig = { ...DEFAULT_BOT_CONFIG };
// Keyed by symbol — each coin that has an open bet gets its own slot.
const openPositions = new Map<string, OpenPosition>();
// Tracks mid-exits this window so re-entry can flip direction intelligently.
// Key = symbol, value = { windowKey, direction that was exited }.
const midExitedWindows = new Map<string, { windowKey: string; direction: "yes" | "no" }>();
let dailyPnl = 0;
let dailyLossCount = 0;
let dailyDate = todayUTC();
// Paper mode balance: starts at null and is populated by loadPaperBalanceFromDB()
// on startup. Live mode reads from Kalshi. Using null (not 100) prevents the balance
// from being incorrectly reset to $100 on every server restart / republish.
let accountBalance: number | null = null;
// Per-symbol exit-guard diagnostics — updated every tick a position is managed.
const lastGuardStatesMap = new Map<string, GuardStates>();
const lastGuardReasonMap = new Map<string, string>();

// Circuit breaker state — persists across windows (not just daily).
// Restored from recent bet history on startup via loadDailyPnlFromDB.
let cbState: CircuitBreakerState = { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };
// Last window key seen for circuit-breaker countdown decrement.
let lastCircuitBreakerWindowKey = "";
// Tracks the last window key for which a decision (SKIP or BET) was logged per symbol.
// Prevents duplicate SKIP records across successive 30s ticks within the same window.
const lastDecisionWindowKey: Map<string, string> = new Map();

// Tracks the last Kalshi ticker for which the eager Claude prefetch was fired, keyed
// by symbol.  Fires when a *new ticker* first appears (true ticker transition), not at
// local window-key rollover — so the prefetch is not wasted on a stale market.
const prefetchedTicker: Map<string, string> = new Map();

// Tracks how many bets have been placed per (symbol, windowKey) in the current window.
// Key format: "${sym}:${windowKey}".  Bounded by config.maxBetsPerWindow.
// Old entries are purged lazily when a new window key is seen for a symbol.
const windowBetCounts: Map<string, number> = new Map();

// Direction-cap tracking: counts YES and NO bets placed in the current 15-min window
// across all symbols. Reset on each window transition. Key: "yes" | "no".
const windowDirectionCounts: Map<"yes" | "no", number> = new Map();

// Per-coin auto-pause: coins with ≥5 consecutive losses are paused for 4
// windows by the auto-tune job. Maps symbol → windows remaining paused.
// Decremented on each window transition; deleted when it reaches 0.
const pausedCoins: Map<string, number> = new Map();

// Per-window outcome tracking for the doubt-penalty signal.
// Key: windowKey (ISO string "YYYY-MM-DDTHH:mm"), Value: { wins, losses }.
// Populated at startup from DB and updated live as bets settle in evalClosedBets.
// When the last 1-2 completed windows had <40% win rate the bot raises its
// effective confidence floor to filter out marginal signals that may be noise.
const recentWindowOutcomes: Map<string, { wins: number; losses: number }> = new Map();

// Cached performance report from the most recent auto-tune run (null before
// the first run fires, typically ~15 min after startup).
let cachedPerformanceReport: PerformanceReport | null = null;

// Recent Kalshi strike prices per symbol (chronological, oldest first).
// Maintained from DB on startup and updated after each position close.
// Used for momentum filter and regime indicator.
const recentKalshiTargets: Map<string, number[]> = new Map();

// Border-proximity guard cache: sym → avg |closePrice−strike|/strike × 100 (%)
// Refreshed once per window from DB. Used to skip bets when price has been
// hovering within a noise band around the strike across recent settled bets.
let borderProximityCache: Map<string, number> = new Map();
let borderProximityCacheWindow = "";

// Regime cache: sym → "above" | "below" | "neutral"
// Tracks whether the last N settled bets for each coin closed above or below
// the Kalshi strike. Used to penalise against-regime bets.
let regimeCache: Map<string, "above" | "below" | "neutral"> = new Map();
let regimeCacheWindow = "";
// Fallback regime penalty used only before config is loaded from DB.
// The live value is config.regimePenalty (default 8pp via DEFAULT_BOT_CONFIG).
const REGIME_AGAINST_PENALTY_FALLBACK = 8;
const REGIME_STRIKES_MAX = 6; // keep last 6 strike prices per symbol

// Tracks the windowKey for which the window-open parallel trend-stability analysis
// was fired. Reset on window transition so each window gets exactly one batch call.
let lastStabilityWindowKey = "";
// Tracks which coin symbols have already had stability analysis fired for the
// current window. Reset on every window change. Allows subsequent ticks to
// pick up coins whose Kalshi data wasn't ready on the first tick of the window.
let stabilityFiredForCoins = new Set<string>();
// Per-symbol trend stability result from the latest window-open Claude analysis.
// Cleared on each window transition. Populated async — may be null on the first tick.
const windowStabilityCache = new Map<string, TrendStability>();

// Hard seconds-into-window buffer before any bet entry or window evaluation.
// All models (Stat snap, Claude analysis, ML prediction) must run AFTER this
// mark so they use the NEW window's Kalshi strike — not the previous window's.
// Claude is pre-fetched eagerly on ticker detection so it is warm by ~45 s.
const WINDOW_ENTRY_BUFFER_S = 45;

// --- Per-coin direction filters (Task A, data-driven, 2026-07-03) ---
// Based on 223 settled production bets. Coins/directions with no historical edge
// are blocked here rather than relying on signal models to self-correct.
//   BTC YES: 20% WR (15 bets)  ETH YES: 20% WR (10 bets)  DOGE YES: 25% WR (4 bets)
//   SOL NO:  22% WR (9 bets)   SOL YES: 40% WR (5 bets) → no edge either direction
const COIN_YES_BLOCKED: ReadonlySet<string> = new Set(["BTC", "ETH", "DOGE"]);
const COIN_FULLY_BLOCKED: ReadonlySet<string> = new Set(["SOL"]);

// Module-level doubt penalty for the current window — set in runBotWindow Phase 3
// (where it's computed) so _runBotTick can include it in the signals JSON for analytics.
let currentWindowDoubtPenalty = 0;

// Note: entry ceiling (maxEntryMinutes) and floor (minRemainingMinutes) are now
// both driven by BotConfig so they can be toggled from the dashboard.
// 0 = disabled for each: ceiling skipped when 0, floor skipped when 0.

// Timing analysis cache (refreshed every 5 min)
let timingCache: Map<string, number | null> = new Map();
let timingCacheAt = 0;
const TIMING_CACHE_TTL = 5 * 60_000;

// Last per-coin evaluation from the best-market selection pass in runBotLoopTick.
// Cleared on each new tick; exposed via getWindowEvaluation() for the dashboard.
let lastWindowEvaluation: WindowCoinEvaluation[] = [];

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded(): void {
  const today = todayUTC();
  if (today !== dailyDate) {
    dailyDate = today;
    dailyPnl = 0;
    dailyLossCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Public state getters / setters
// ---------------------------------------------------------------------------

export function getBotState(): BotStateSnapshot {
  const status: BotStatus = paused
    ? "paused"
    : dailyPnl <= -config.dailyLossLimit
    ? "daily_limit_hit"
    : openPositions.size > 0
    ? "position_open"
    : "idle";

  // Build display objects for every open position with live P&L and guard diagnostics.
  const openPositionsList: OpenPositionDisplay[] = Array.from(openPositions.values()).map((pos) => {
    const liveKalshi = getKalshiCachedData(pos.symbol);
    let currentYesPrice: number | null = null;
    let unrealizedPnl: number | null = null;
    if (liveKalshi?.yesPrice != null) {
      currentYesPrice = liveKalshi.yesPrice;
      // YES bet: profits when yesPrice rises; NO bet: profits when yesPrice falls
      const priceDelta = pos.direction === "yes"
        ? liveKalshi.yesPrice - pos.entryYesPrice
        : pos.entryYesPrice - liveKalshi.yesPrice;
      unrealizedPnl = priceDelta * pos.contractCount;
    }
    return {
      ...pos,
      exitState: pos.exitState, // reference — callers must not mutate
      currentYesPrice,
      unrealizedPnl,
      guardStates: lastGuardStatesMap.get(pos.symbol) ?? null,
      guardReason: lastGuardReasonMap.get(pos.symbol) ?? null,
    };
  });

  // Compute warmup state: how many seconds remain of the 45-second window
  // buffer before any model bets are allowed. null when warmup is over.
  let warmupSecondsRemaining: number | null = null;
  if (!paused) {
    const firstKalshiCoin = CRYPTO_COINS.find((c) => KALSHI_SERIES[c.symbol]);
    if (firstKalshiCoin) {
      const winCtx = getKalshiWindowContext(firstKalshiCoin.symbol);
      const secondsIntoWindow = winCtx?.secondsElapsed ?? 0;
      const remaining = Math.max(0, WINDOW_ENTRY_BUFFER_S - secondsIntoWindow);
      if (remaining > 0) warmupSecondsRemaining = remaining;
    }
  }

  return {
    mode: botMode,
    status,
    paused,
    config: { ...config },
    openPositions: openPositionsList,
    dailyPnl,
    dailyLossCount,
    dailyDate,
    accountBalance,
    lastUpdatedAt: new Date().toISOString(),
    configured: isKalshiConfigured(),
    warmupSecondsRemaining,
    circuitBreakerWindowsRemaining: cbState.circuitBreakerWindowsRemaining,
    consecutiveLosses: cbState.consecutiveLosses,
    isInQuietHours: isInQuietHours(new Date().getUTCHours(), config.quietHoursStart, config.quietHoursEnd),
  };
}

export function setBotMode(mode: BotMode): void {
  if (mode === "live" && !isKalshiConfigured()) {
    throw new Error("KALSHI_API_KEY not configured — cannot enable live mode");
  }
  botMode = mode;
  logger.info({ mode }, "[kalshi-bot] mode changed");
  // Fire-and-forget — persist mode so it survives server restarts.
  _persistModeToConfig().catch(() => {});
}

async function _persistModeToConfig(): Promise<void> {
  try {
    const snapshot = { ...config, mode: botMode } as Record<string, unknown>;
    await db.execute(sql`
      INSERT INTO bot_config (id, config, updated_at)
      VALUES ('default', ${JSON.stringify(snapshot)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
    `);
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to persist mode to DB (non-fatal)");
  }
}

export function setBotPaused(p: boolean): void {
  paused = p;
  logger.info({ paused }, "[kalshi-bot] paused changed");
}

export async function updateBotConfig(partial: Partial<BotConfig>): Promise<{ config: BotConfig; persisted: boolean }> {
  config = { ...config, ...partial };
  const snapshot = { ...config };
  let persisted = false;
  try {
    // Include mode in the persisted JSON so restarts recover the correct mode.
    const stored = { ...snapshot, mode: botMode } as Record<string, unknown>;
    await db.execute(sql`
      INSERT INTO bot_config (id, config, updated_at)
      VALUES ('default', ${JSON.stringify(stored)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
    `);
    persisted = true;
  } catch (err) {
    logger.error({ err }, "[kalshi-bot] failed to persist config to DB");
  }
  // If paper wallet settings changed, recompute the in-memory balance immediately
  // so the dashboard reflects the new value without a server restart.
  if ("paperStartingBalance" in partial || "paperBalanceResetAt" in partial) {
    await loadPaperBalanceFromDB().catch(() => {});
  }
  return { config: snapshot, persisted };
}

export async function loadBotConfigFromDB(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, "default"))
      .limit(1);
    if (rows.length > 0 && rows[0].config) {
      const saved = rows[0].config as Partial<BotConfig> & { mode?: BotMode };
      config = { ...DEFAULT_BOT_CONFIG, ...saved };
      if (saved.mode === "paper" || saved.mode === "live") {
        botMode = saved.mode;
        logger.info({ mode: botMode }, "[kalshi-bot] mode restored from DB");
      }
      logger.info({ config }, "[kalshi-bot] config loaded from DB");

      // One-time startup migration (2026-07-03): ml_gate → classic.
      // ml_gate mode pins every bet at 65% effective confidence because ML only vetos,
      // never boosts. Classic mode (PATH A/B/C) lets ML conviction differentiate
      // signal quality — strong ML agreement can push effective confidence to 80%+.
      // Production data: 223 bets, all entered at exactly 65%. Zero differentiation.
      if (config.decisionMode === "ml_gate") {
        config.decisionMode = "classic";
        logger.info("[kalshi-bot] startup migration: decisionMode ml_gate → classic (Task-A)");
        updateBotConfig({ decisionMode: "classic" }).catch(err =>
          logger.warn({ err }, "[kalshi-bot] startup migration persist failed (non-fatal)")
        );
      }
    } else {
      logger.info("[kalshi-bot] no saved config in DB — using defaults");
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load config from DB — using defaults (non-fatal)");
  }
}

/**
 * Reconstruct dailyPnl and dailyLossCount from today's evaluated bet rows.
 * Called once at startup after loadBotConfigFromDB() so the loss-limit guard
 * has correct state even after a crash or restart mid-day.
 */
export async function loadDailyPnlFromDB(): Promise<void> {
  try {
    const today = todayUTC();
    // Filter by exitedAt date to match runtime behaviour: dailyPnl is incremented
    // in closePosition() (i.e. at exit time), so reconstruction must use the same
    // day bucket — exitedAt UTC date — not createdAt. This keeps daily state correct
    // even when a position opened before midnight and was closed after.
    const rows = await db
      .select({ pnl: kalshiBotBetsTable.pnl })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNull(kalshiBotBetsTable.archivedAt),
          sql`DATE(${kalshiBotBetsTable.exitedAt} AT TIME ZONE 'UTC') = ${today}`,
          sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')`,
        ),
      );

    let pnlSum = 0;
    let lossCount = 0;
    for (const r of rows) {
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      pnlSum += p;
      if (p < 0) lossCount++;
    }
    dailyPnl = pnlSum;
    dailyLossCount = lossCount;
    dailyDate = today;

    // Restore consecutive-loss streak and recent Kalshi strike prices from recent bets.
    // Both are needed on startup: streak → circuit-breaker restore; strikes → momentum filter.
    // Rows ordered newest-first so we can walk the streak forward from the most recent bet.
    const recentRows = await db
      .select({
        pnl: kalshiBotBetsTable.pnl,
        symbol: kalshiBotBetsTable.symbol,
        kalshiTarget: kalshiBotBetsTable.kalshiTarget,
        windowKey: kalshiBotBetsTable.windowKey,
        exitedAt: kalshiBotBetsTable.exitedAt,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')
          AND ${kalshiBotBetsTable.exitedAt} IS NOT NULL`,
      )
      .orderBy(desc(kalshiBotBetsTable.exitedAt))
      .limit(REGIME_STRIKES_MAX * 8); // fetch enough to populate targets for all coins

    // Streak: count consecutive losses from most-recent row backwards.
    let streak = 0;
    for (const r of recentRows) {
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      if (p < 0) streak++;
      else break; // first non-loss resets the streak
    }

    // Targets: collect all records (newest-first) and reverse to chronological order.
    const targetsBySymbol: Map<string, number[]> = new Map();
    for (const r of recentRows) {
      const sym = (r.symbol ?? "").toUpperCase();
      if (sym && r.kalshiTarget != null) {
        if (!targetsBySymbol.has(sym)) targetsBySymbol.set(sym, []);
        const t = parseFloat(String(r.kalshiTarget));
        if (!isNaN(t)) targetsBySymbol.get(sym)!.push(t);
      }
    }
    for (const [sym, targets] of targetsBySymbol.entries()) {
      // DB returned newest-first; reverse for chronological order then cap size.
      recentKalshiTargets.set(sym, targets.reverse().slice(-REGIME_STRIKES_MAX));
    }

    // Per-coin consecutive loss recovery: if a coin has ≥5 consecutive losses in recent
    // bets AND the most recent bet for that coin was within the last 90 minutes (6 windows),
    // auto-pause it for 4 windows. The recency guard prevents perpetual re-pause on every
    // server restart when the coin has been idle (already served its pause time).
    const perCoinStreak: Map<string, number> = new Map();
    const perCoinLastBetAt: Map<string, Date> = new Map();
    const perCoinStreakDone: Set<string> = new Set();
    const STARTUP_PAUSE_RECENCY_MS = 90 * 60_000; // 90 minutes = 6 windows
    const nowForPause = Date.now();
    for (const r of recentRows) {
      const sym = (r.symbol ?? "").toUpperCase();
      if (!sym || perCoinStreakDone.has(sym)) continue;
      // Track most-recent bet timestamp per coin (rows are newest-first).
      if (!perCoinLastBetAt.has(sym) && r.exitedAt) {
        perCoinLastBetAt.set(sym, new Date(r.exitedAt));
      }
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      if (p < 0) {
        perCoinStreak.set(sym, (perCoinStreak.get(sym) ?? 0) + 1);
      } else {
        perCoinStreakDone.add(sym); // first win resets streak for this coin
      }
    }
    for (const [sym, consecutive] of perCoinStreak.entries()) {
      const lastBet = perCoinLastBetAt.get(sym);
      const isRecent = lastBet && (nowForPause - lastBet.getTime()) < STARTUP_PAUSE_RECENCY_MS;
      if (consecutive >= 5 && !pausedCoins.has(sym) && isRecent) {
        pausedCoins.set(sym, 4);
        logger.warn(
          { sym, consecutive, lastBetAt: lastBet },
          "[kalshi-bot] startup: auto-pausing coin with ≥5 consecutive recent losses",
        );
      } else if (consecutive >= 5 && !isRecent) {
        logger.info(
          { sym, consecutive, lastBetAt: lastBet },
          "[kalshi-bot] startup: skipping auto-pause — last bet too old (coin already served pause time)",
        );
      }
    }

    // Populate per-window outcome tracking from recent settled rows.
    // recentRows is newest-first; we just iterate and bucket by windowKey.
    recentWindowOutcomes.clear();
    for (const r of recentRows) {
      const wk = r.windowKey;
      if (!wk || r.pnl == null) continue;
      const p = parseFloat(String(r.pnl));
      const wo = recentWindowOutcomes.get(wk) ?? { wins: 0, losses: 0 };
      if (p > 0) wo.wins++;
      else if (p < 0) wo.losses++;
      recentWindowOutcomes.set(wk, wo);
    }

    // Restore consecutive-loss streak for in-session tracking only.
    // The circuit-breaker window countdown is NOT restored on restart because:
    //   1. cbState starts at 0 each process start — Math.max(0, N) would always reset
    //      CB to the full configured pause count whenever a streak exists, causing
    //      perpetual blocking across restarts (no new bets → streak never clears → repeat).
    //   2. The CB is a session-level safety feature; the per-coin auto-pause (above)
    //      already handles the "bad recent streak" case on restart with the recency guard.
    // CB re-activates naturally when new losses happen within the running session.
    cbState = { consecutiveLosses: streak, circuitBreakerWindowsRemaining: 0 };

    logger.info({ dailyPnl, dailyLossCount, date: today, cbState }, "[kalshi-bot] daily P&L loaded from DB");
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load daily P&L from DB (non-fatal)");
  }
}

/**
 * Compute and restore the paper-mode account balance from the DB.
 *
 * Balance = paperStartingBalance (from config) + sum of all paper-mode bet PnL
 * settled *after* config.paperBalanceResetAt (or all time when that is null).
 *
 * Called once on startup after loadBotConfigFromDB() so the balance reflects
 * the real state rather than resetting to the hardcoded default on every
 * server restart / republish.
 */
export async function loadPaperBalanceFromDB(): Promise<void> {
  if (botMode === "live") {
    // Live mode: balance is fetched from Kalshi on demand; skip DB computation.
    return;
  }
  try {
    const startingBalance = config.paperStartingBalance ?? 100;
    const resetAt = config.paperBalanceResetAt ? new Date(config.paperBalanceResetAt) : null;

    const conditions = [
      isNotNull(kalshiBotBetsTable.exitedAt),
      eq(kalshiBotBetsTable.mode, "paper"),
      sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')`,
    ];
    if (resetAt) {
      conditions.push(sql`${kalshiBotBetsTable.exitedAt} >= ${resetAt.toISOString()}`);
    }

    const rows = await db
      .select({ pnl: kalshiBotBetsTable.pnl })
      .from(kalshiBotBetsTable)
      .where(and(...conditions));

    let pnlSum = 0;
    for (const r of rows) {
      pnlSum += r.pnl != null ? parseFloat(String(r.pnl)) : 0;
    }
    accountBalance = startingBalance + pnlSum;
    logger.info(
      { startingBalance, pnlSum, accountBalance, resetAt },
      "[kalshi-bot] paper balance loaded from DB",
    );
  } catch (err) {
    accountBalance = config.paperStartingBalance ?? 100;
    logger.warn({ err }, "[kalshi-bot] failed to load paper balance from DB — using starting balance");
  }
}

/**
 * Delete kalshi_bot_bets records older than `hours` hours and reload in-memory
 * daily P&L counters so the bot reflects the trimmed history immediately.
 * Prediction_records (learning data) are never touched.
 */
export async function clearBetHistoryOld(hours = 2): Promise<{ deleted: number }> {
  // Soft-archive: stamp archived_at instead of deleting so that operational queries
  // (recentKalshiTargets seeding, evalClosedBets, border guard, auto-tune) keep
  // working with full history.  Only DISPLAY queries filter archived_at IS NULL.
  const result = await db.execute(
    sql`UPDATE kalshi_bot_bets
        SET archived_at = NOW()
        WHERE created_at < NOW() - (${hours} || ' hours')::interval
          AND archived_at IS NULL`
  );
  const deleted = (result as unknown as { rowCount: number }).rowCount ?? 0;
  logger.info({ archived: deleted, hours }, "[kalshi-bot] clearBetHistoryOld — bet records soft-archived");
  // Reload in-memory daily counters so the running bot reflects the clean slate.
  await loadDailyPnlFromDB();
  return { deleted };
}

/**
 * Recover an open position from the DB after a server restart.
 * Looks for the most recent 'bet' row with no exitedAt within the last 24 hours
 * (24h covers midnight-UTC boundaries so a position opened late in one day is
 * still found on a post-midnight restart). If found:
 *   - Window still active → restores the position into openPositions so the
 *     exit guard resumes on the next tick. No double-entry can occur because
 *     _runBotTick returns early when a position slot is already occupied.
 *   - Window expired → skips restoration; evalClosedBets will settle the row
 *     once the bot-loop window-expiry check closes it.
 */
export async function loadOpenPositionFromDB(): Promise<void> {
  try {
    // Use a 24-hour rolling window instead of a DATE equality so a position
    // opened just before UTC midnight is still found after a post-midnight restart.
    const rows = await db
      .select()
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNull(kalshiBotBetsTable.exitedAt),
          eq(kalshiBotBetsTable.action, "bet"),
          sql`${kalshiBotBetsTable.createdAt} >= NOW() - INTERVAL '24 hours'`,
        ),
      )
      .orderBy(desc(kalshiBotBetsTable.createdAt));

    if (rows.length === 0) {
      logger.info("[kalshi-bot] no open positions found in DB");
      return;
    }

    const currentKey = currentWindowKey();
    let restored = 0;

    for (const row of rows) {
      // Validate required fields before reconstructing in-memory position.
      if (
        !row.direction ||
        !row.ticker ||
        row.entryPrice == null ||
        row.contractCount == null ||
        row.betAmount == null ||
        row.kalshiTarget == null
      ) {
        logger.warn({ id: row.id }, "[kalshi-bot] open position row missing required fields — skipping restore");
        continue;
      }

      const windowKey = row.windowKey;

      if (windowKey !== currentKey) {
        // Window has already expired — skip; evalClosedBets will settle it.
        logger.info(
          { id: row.id, symbol: row.symbol, windowKey, currentKey },
          "[kalshi-bot] recovered position window has expired — leaving for normal evaluator flow",
        );
        continue;
      }

      const entryYesPrice = parseFloat(String(row.entryPrice));
      const direction = row.direction as "yes" | "no";

      openPositions.set(row.symbol, {
        id: row.id,
        symbol: row.symbol,
        windowKey,
        ticker: row.ticker,
        direction,
        entryYesPrice,
        contractCount: row.contractCount,
        betAmount: parseFloat(String(row.betAmount)),
        kalshiTarget: parseFloat(String(row.kalshiTarget)),
        openedAt: row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(String(row.createdAt)).getTime(),
        cryptoPriceAtEntry: (row as Record<string, unknown>)["cryptoPriceAtEntry"] != null
          ? parseFloat(String((row as Record<string, unknown>)["cryptoPriceAtEntry"]))
          : null,
        exitState: makeInitialExitState(entryYesPrice),
        entryDecision: {
          action: direction === "yes" ? "BET_YES" : "BET_NO",
          confidence: 0, // not stored; the exit guard only needs direction + price
          signals: (row.signals ?? {}) as Record<string, unknown>,
        } as unknown as BotDecision,
        phase2Activated: row.phase2Activated ?? false,
      });

      logger.info(
        { id: row.id, symbol: row.symbol, windowKey, direction, entryYesPrice },
        "[kalshi-bot] open position restored from DB — exit guard will resume on next tick",
      );
      restored++;
    }

    if (restored > 0) {
      logger.info({ restored }, "[kalshi-bot] open positions restored from DB");
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to restore open positions from DB (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Border-proximity guard helper
// ---------------------------------------------------------------------------

/**
 * Queries the last `lookback` evaluated bets per symbol and returns a map of
 * sym → avg |closePrice−kalshiTarget| / kalshiTarget × 100 (as a percentage).
 * Only rows that have closePriceAtEval stored in their signals JSONB are counted.
 */
/**
 * Queries the last `lookback` settled bets per symbol and determines whether
 * the close price consistently settled above or below the Kalshi strike.
 * Returns "above" / "below" / "neutral" per symbol.
 * "above" means ALL recent closes were above the strike (lean YES regime).
 * "below" means ALL recent closes were below the strike (lean NO regime).
 */
async function loadRegimeCache(symbols: string[], lookback: number): Promise<Map<string, "above" | "below" | "neutral">> {
  const result = new Map<string, "above" | "below" | "neutral">();
  if (symbols.length === 0 || lookback <= 0) return result;
  try {
    const rows = await db.execute(sql`
      WITH ranked AS (
        SELECT
          symbol,
          kalshi_target::numeric                          AS target,
          (signals->>'closePriceAtEval')::numeric         AS close_price,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY evaluated_at DESC) AS rn
        FROM kalshi_bot_bets
        WHERE outcome IS NOT NULL
          AND evaluated_at IS NOT NULL
          AND signals->>'closePriceAtEval' IS NOT NULL
          AND kalshi_target IS NOT NULL
          AND symbol = ANY(${sql.raw(`ARRAY[${symbols.map(s => `'${s.replace(/'/g, "''")}'`).join(",")}]`)})
      )
      SELECT
        symbol,
        COUNT(*) FILTER (WHERE close_price > target)::int  AS above_count,
        COUNT(*) FILTER (WHERE close_price < target)::int  AS below_count,
        COUNT(*)::int                                       AS sample_count
      FROM ranked
      WHERE rn <= ${lookback}
      GROUP BY symbol
    `);
    for (const row of rows.rows as { symbol: string; above_count: number; below_count: number; sample_count: number }[]) {
      if (row.sample_count < lookback) {
        result.set(row.symbol, "neutral");
      } else if (row.above_count === row.sample_count) {
        result.set(row.symbol, "above");
      } else if (row.below_count === row.sample_count) {
        result.set(row.symbol, "below");
      } else {
        result.set(row.symbol, "neutral");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] loadRegimeCache: query failed — regime filter disabled this tick");
  }
  return result;
}

async function loadBorderProximityCache(symbols: string[], lookback: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbols.length === 0 || lookback <= 0) return result;
  try {
    const rows = await db.execute(sql`
      WITH ranked AS (
        SELECT
          symbol,
          kalshi_target::numeric                          AS target,
          (signals->>'closePriceAtEval')::numeric         AS close_price,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY evaluated_at DESC) AS rn
        FROM kalshi_bot_bets
        WHERE outcome IS NOT NULL
          AND evaluated_at IS NOT NULL
          AND signals->>'closePriceAtEval' IS NOT NULL
          AND kalshi_target IS NOT NULL
          AND symbol = ANY(${sql.raw(`ARRAY[${symbols.map(s => `'${s.replace(/'/g, "''")}'`).join(",")}]`)})
      )
      SELECT
        symbol,
        AVG(ABS(close_price - target) / target * 100)::numeric AS avg_proximity_pct,
        COUNT(*)::int                                           AS sample_count
      FROM ranked
      WHERE rn <= ${lookback}
      GROUP BY symbol
    `);
    for (const row of rows.rows as { symbol: string; avg_proximity_pct: string; sample_count: number }[]) {
      const pct = parseFloat(row.avg_proximity_pct);
      if (!isNaN(pct)) result.set(row.symbol, pct);
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] loadBorderProximityCache: query failed — guard disabled this tick");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Timing accuracy helper
// ---------------------------------------------------------------------------

async function getTimingAccuracy(symbol: string, minutesElapsed: number): Promise<number | null> {
  const nowMs = Date.now();
  if (nowMs - timingCacheAt > TIMING_CACHE_TTL) {
    try {
      const rows = await getTimingAnalysis(); // aggregate across all coins
      const fresh = new Map<string, number | null>();
      for (const r of rows) {
        const key = `${r.symbol ?? "ALL"}:${r.minuteMark}`;
        fresh.set(key, r.accuracy != null ? r.accuracy * 100 : null);
      }
      timingCache = fresh;
      timingCacheAt = nowMs;
    } catch {
      // keep stale cache
    }
  }

  // Look up the closest minute mark (1,3,6,9,12)
  const marks = [1, 3, 6, 9, 12];
  const elapsedMin = Math.floor(minutesElapsed);
  const closest = marks.reduce((prev, m) => Math.abs(m - elapsedMin) < Math.abs(prev - elapsedMin) ? m : prev, marks[0]);
  const markSeconds = closest * 60;

  const symKey = `${symbol}:${markSeconds}`;
  const allKey = `ALL:${markSeconds}`;
  return timingCache.get(symKey) ?? timingCache.get(allKey) ?? null;
}

// ---------------------------------------------------------------------------
// Core tick — called by the prediction tracker every 30 s per coin
// ---------------------------------------------------------------------------

// In-flight guard to prevent overlapping ticks per symbol
const tickInFlight = new Set<string>();

export async function runBotTickForCoin(
  symbol: string,
  kalshiTicker: string | null,
  kalshiTarget: number | null,
  yesPrice: number | null,
  candles: Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>,
): Promise<void> {
  if (!config.enabled) return;

  const sym = symbol.toUpperCase();
  if (tickInFlight.has(sym)) return;
  tickInFlight.add(sym);

  try {
    await _runBotTick(sym, kalshiTicker, kalshiTarget, yesPrice, candles);
  } catch (err) {
    logger.warn({ err, sym }, "[kalshi-bot] tick error (non-fatal)");
  } finally {
    tickInFlight.delete(sym);
  }
}

async function _runBotTick(
  sym: string,
  kalshiTicker: string | null,
  kalshiTarget: number | null,
  yesPrice: number | null,
  candles: Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>,
): Promise<void> {
  resetDailyIfNeeded();

  // Daily loss limit check
  if (dailyPnl <= -config.dailyLossLimit) {
    const limitPos = openPositions.get(sym);
    if (limitPos) {
      logger.warn({ sym }, "[kalshi-bot] daily limit hit — closing position");
      await closePosition(limitPos, yesPrice, kalshiTarget, "daily_loss_limit_hit");
      openPositions.delete(sym);
    }
    return;
  }

  if (paused) return;

  // Get ER from recent candles
  const metrics = candles.length >= 3 ? intraWindowMetrics(candles, 15) : null;
  const erValue = metrics?.efficiencyRatio ?? null;

  const winCtx = getKalshiWindowContext(sym);
  const minutesElapsed = winCtx?.minutesElapsed ?? 0;
  const secondsElapsed = winCtx?.secondsElapsed ?? 0;
  const windowKey = currentWindowKey();

  // ── POSITION MANAGEMENT ──────────────────────────────────────────────────
  // Each coin's tick independently manages its own position slot.  There is no
  // cross-symbol guard — coins are fully independent of one another.

  const pos = openPositions.get(sym);
  if (pos) {
    // Check if the window has changed (expired)
    if (pos.windowKey !== windowKey) {
      midExitedWindows.delete(sym); // clear flip state — new window starts fresh
      await closePosition(pos, yesPrice, kalshiTarget, "window_expired");
      openPositions.delete(sym);
    } else {
      // Use last known yes-price as fallback when the live cache returns null.
      // lastYesPrice is seeded from entryPrice and updated each tick where yesPrice
      // is non-null, so this prevents the exit guard from running blind on a stale cache miss.
      const effectiveYesPrice = yesPrice ?? pos.exitState.phase1.lastYesPrice;

      // Verbose per-tick diagnostics so Phase-2 / exit-guard decisions are observable in logs.
      const rawMovePp = effectiveYesPrice !== null
        ? (pos.direction === "yes"
            ? (pos.entryYesPrice - effectiveYesPrice) * 100
            : (effectiveYesPrice - pos.entryYesPrice) * 100)
        : null;
      logger.debug({
        sym,
        currentYesPrice: effectiveYesPrice,
        entryYesPrice: pos.entryYesPrice,
        movePp: rawMovePp?.toFixed(2),
        phase2ThresholdPp: config.phase2ThresholdPp,
        minutesElapsed,
        direction: pos.direction,
      }, "[kalshi-bot] exit-tick price check");

      // Run exit guard for the current position
      const timingAcc = await getTimingAccuracy(sym, minutesElapsed);
      const guard = runExitGuard(
        sym,
        pos.direction,
        minutesElapsed,
        effectiveYesPrice,
        pos.exitState,
        timingAcc,
        erValue,
        config.midExitSensitivity,
        config.phase2ThresholdPp,
      );

      lastGuardStatesMap.set(sym, guard.guardStates);
      lastGuardReasonMap.set(sym, guard.reason);

      if (guard.guardStates.phase2Active && !pos.phase2Activated) {
        pos.phase2Activated = true;
        logger.info(
          {
            sym,
            yesPrice: effectiveYesPrice,
            entryYesPrice: pos.entryYesPrice,
            movePp: rawMovePp?.toFixed(2),
          },
          "[kalshi-bot] phase2 activated for position",
        );
      }

      logger.debug({
        sym,
        recommendation: guard.recommendation,
        guardReason: guard.reason,
        phase2Active: guard.guardStates.phase2Active,
        flipConfirmed: guard.guardStates.flipConfirmed,
        magnitudeOk: guard.guardStates.magnitudeOk,
        consensusOk: guard.guardStates.consensusOk,
        erOk: guard.guardStates.erOk,
        holdDurationOk: guard.guardStates.holdDurationOk,
      }, "[kalshi-bot] exit-guard result");

      if (guard.recommendation === "EXIT") {
        const isLateRecovery = guard.phase === 2;
        const exitReason = guard.phase === 2 ? "mid_exit_phase2" : "mid_exit_phase1";
        logger.info({ sym, exitReason, guardReason: guard.reason }, "[kalshi-bot] mid-exit triggered");
        await closePosition(pos, effectiveYesPrice, kalshiTarget, exitReason, isLateRecovery);
        openPositions.delete(sym);
        // Record that we exited mid-window so the entry loop can re-enter in
        // the opposite direction ("sell and rebuy") with a higher confidence bar.
        midExitedWindows.set(sym, { windowKey, direction: pos.direction });
      }

      // Guaranteed time-stop: if < 2 minutes remain in the 15-min window AND the
      // position is losing (crypto price on the wrong side of the Kalshi strike),
      // exit immediately rather than riding to expiry at maximum loss.
      // This caps maximum hold to ~13 minutes regardless of exit-guard state.
      if (openPositions.has(sym)) {
        const minutesRemaining = 15 - minutesElapsed;
        if (minutesRemaining < 2) {
          const cryptoPrice = getCachedPrediction(sym)?.price ?? null;
          const isPositionLosing = cryptoPrice !== null && (
            (pos.direction === "yes" && cryptoPrice < pos.kalshiTarget) ||
            (pos.direction === "no"  && cryptoPrice >= pos.kalshiTarget)
          );
          if (isPositionLosing) {
            logger.info(
              {
                sym,
                minutesRemaining,
                cryptoPrice,
                strike: pos.kalshiTarget,
                direction: pos.direction,
                yesPrice: effectiveYesPrice,
              },
              "[kalshi-bot] time-stop triggered — exiting losing position before expiry",
            );
            await closePosition(pos, effectiveYesPrice, kalshiTarget, "mid_exit_time");
            openPositions.delete(sym);
          }
        }
      }
    }
    return; // managed position this tick — check re-entry on next tick
  }

  // ── ENTRY DECISION ────────────────────────────────────────────────────────

  // Multi-bet guard: purge stale window entries then check the per-window cap.
  // Purge any entry for this symbol that belongs to an older window key.
  for (const [k] of windowBetCounts) {
    if (k.startsWith(`${sym}:`) && k !== `${sym}:${windowKey}`) {
      windowBetCounts.delete(k);
    }
  }
  const windowBetKey = `${sym}:${windowKey}`;
  const betsThisWindow = windowBetCounts.get(windowBetKey) ?? 0;
  if (betsThisWindow >= config.maxBetsPerWindow) {
    logger.debug({ sym, betsThisWindow, max: config.maxBetsPerWindow }, "[kalshi-bot] maxBetsPerWindow reached — skipping entry");
    return;
  }

  // Ceiling: skip if bot has been in the window longer than maxEntryMinutes.
  // 0 = disabled (no ceiling — enter at any point).
  if (config.maxEntryMinutes > 0 && secondsElapsed > config.maxEntryMinutes * 60) return;
  // Floor: skip if fewer than minRemainingMinutes remain in the window.
  // 0 = disabled (no floor — ROI gate handles unprofitable late entries).
  const minRemaining = config.minRemainingMinutes ?? 0;
  if (minRemaining > 0 && 15 * 60 - secondsElapsed < minRemaining * 60) {
    logger.debug({ sym, secondsElapsed, minRemaining }, "[kalshi-bot] min-remaining floor — skipping");
    return;
  }
  if (!kalshiTicker || kalshiTarget === null) return;

  // Eager Claude prefetch: fire when a *new Kalshi ticker* is first seen per symbol.
  // Keyed on the actual ticker string (not the local window key) so we don't prefetch
  // against a stale market if the new ticker hasn't published yet at window rollover.
  if (prefetchedTicker.get(sym) !== kalshiTicker) {
    prefetchedTicker.set(sym, kalshiTicker);
    fetchLiveDirection(sym, true).catch(() => {}); // fire-and-forget
  }

  // Hard 45-second window buffer: no entry until the window is at least
  // WINDOW_ENTRY_BUFFER_S seconds old. This guarantees:
  //   1. The new Kalshi strike has had time to publish (Kalshi can be slow).
  //   2. Claude's eager prefetch (fired on new-ticker detection above) has
  //      completed so the live-direction cache holds the CURRENT window's
  //      verdict — not the previous window's stale result.
  //   3. The stat snap has had time to run and update predCache with the
  //      new window's predictions (ML included).
  if (secondsElapsed < WINDOW_ENTRY_BUFFER_S) {
    if (lastDecisionWindowKey.get(sym) !== `warmup:${windowKey}`) {
      lastDecisionWindowKey.set(sym, `warmup:${windowKey}`);
      await persistBetRecord({
        symbol: sym,
        windowKey,
        ticker: kalshiTicker,
        direction: null,
        action: "skip",
        signals: { warmupActive: true, secondsElapsed, minutesElapsed, reason: "warmup-buffer", msSinceConfirm: Math.round(secondsElapsed * 1000) },
        entryPrice: null,
        kalshiTarget,
      });
    }
    return;
  }

  // Use ensemble signal accuracy (from prediction_records historyStore) for the
  // EV gate — not the bot's own win rate, which is contaminated by exit decisions.
  const signalAcc = getPredictionAnalytics(sym).bySource.ensemble.accuracyPct;
  const decision = makeBotDecision(
    sym,
    config,
    kalshiTicker,
    yesPrice,
    minutesElapsed,
    signalAcc,
    kalshiTarget,  // pass through so ML doesn't re-fetch a potentially stale cache
  );

  // ── RE-ENTRY GUARD ───────────────────────────────────────────────────────
  // If we exited a position mid-window (fast-flip or phase-2), we may re-enter
  // — but only in the OPPOSITE direction, and only with a higher confidence bar
  // (+5pp) to avoid immediately flipping back on noise.
  const recentFlip = midExitedWindows.get(sym);
  if (recentFlip && recentFlip.windowKey === windowKey && decision.action !== "SKIP") {
    const exitedDir = recentFlip.direction; // "yes" or "no"
    const newDir = decision.action === "BET_YES" ? "yes" : "no";
    if (newDir === exitedDir) {
      // Same direction as what we just exited — skip to avoid whipsawing.
      logger.debug({ sym, exitedDir, newDir }, "[kalshi-bot] re-entry blocked — same direction as mid-exit");
      return;
    }
    // Opposite direction is allowed but requires higher confidence.
    const flipConfidenceBar = (config.minConfidence ?? 65) + 5;
    if (decision.confidence < flipConfidenceBar) {
      logger.debug({ sym, confidence: decision.confidence, flipConfidenceBar }, "[kalshi-bot] re-entry blocked — confidence below flip bar");
      return;
    }
    logger.info({ sym, exitedDir, newDir, confidence: decision.confidence }, "[kalshi-bot] flip re-entry — entering opposite direction after mid-exit");
    // Clear the flip record so we don't double-guard
    midExitedWindows.delete(sym);
  }

  if (decision.action === "SKIP") {
    // Log at most one SKIP per (symbol, window) to avoid flooding audit logs
    // with repeated SKIP records from successive 30-second ticks
    if (lastDecisionWindowKey.get(sym) !== windowKey) {
      lastDecisionWindowKey.set(sym, windowKey);
      await persistBetRecord({
        symbol: sym,
        windowKey,
        ticker: kalshiTicker,
        direction: null,
        action: "skip",
        signals: decision.signals,
        entryPrice: null,
        kalshiTarget,
      });
    }
    return;
  }

  // Place the bet
  const direction: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
  // Cost per contract: YES contracts cost yesPrice per $1 face; NO contracts cost (1-yesPrice)
  const sideCost = direction === "yes" ? (yesPrice ?? 0.5) : (1 - (yesPrice ?? 0.5));
  const contractCount = Math.max(1, Math.round(config.betSize / sideCost));
  const betAmount = contractCount * sideCost; // actual dollars risked (may differ slightly from configured betSize)

  logger.info({ sym, direction, decision: decision.action, confidence: decision.confidence }, "[kalshi-bot] placing bet");

  let fillPrice = yesPrice; // paper fill
  let orderId: string | null = null;

  if (botMode === "live") {
    try {
      const result = await placeOrderWithRetry({
        ticker: kalshiTicker,
        side: direction,
        action: "buy",
        count: contractCount,
        type: "market",
      });
      if (result.filledCount === 0) {
        logger.warn({ sym, ticker: kalshiTicker, direction }, "[kalshi-bot] order not filled after retries — skipping entry");
        return;
      }
      fillPrice = result.avgPrice ?? yesPrice;
      orderId = result.orderId;
    } catch (err) {
      logger.error({ err, sym }, "[kalshi-bot] order placement failed");
      return;
    }
  }

  const id = `${sym}:${windowKey}:${Date.now()}`;
  // Capture the live coin price at the moment the bet is placed.
  const cryptoPriceAtEntry = getCachedPrediction(sym)?.price ?? null;
  const newPosition: OpenPosition = {
    id,
    symbol: sym,
    windowKey,
    ticker: kalshiTicker,
    direction,
    entryYesPrice: fillPrice ?? yesPrice ?? 0.5,
    contractCount,
    betAmount,
    kalshiTarget,
    openedAt: Date.now(),
    cryptoPriceAtEntry,
    exitState: makeInitialExitState(fillPrice ?? yesPrice ?? 0.5),
    entryDecision: decision,
    phase2Activated: false,
  };
  openPositions.set(sym, newPosition);

  // Enrich signals with effectiveConfidence (the composite score that gated this bet)
  // so analytics can build accurate confidence-band win-rate breakdowns without relying
  // on statConfidence/claudeConfidence alone, which are per-model not per-decision.
  // Task C (2026-07-03): also persist regime, trendStability, and windowDoubtPenalty
  // so post-analysis can evaluate the impact of each Phase-3 filter on outcomes.
  const enrichedSignals = {
    ...(decision.signals as unknown as Record<string, unknown>),
    effectiveConfidence: decision.confidence,
    regime: regimeCache.get(sym) ?? null,
    trendStability: windowStabilityCache.get(sym) ?? null,
    windowDoubtPenalty: currentWindowDoubtPenalty,
  };

  await persistBetRecord({
    symbol: sym,
    windowKey,
    ticker: kalshiTicker,
    direction,
    action: "bet",
    signals: enrichedSignals,
    entryPrice: newPosition.entryYesPrice,
    kalshiTarget,
    contractCount,
    betAmount,
    // Use insertId (not existingId) so persistBetRecord INSERTs this row.
    // The exit UPDATE will find it later via existingId: pos.id.
    insertId: id,
    cryptoPriceAtEntry,
    decisionMode: config.decisionMode ?? "classic",
  });
  // Mark this window as having a recorded decision so SKIP dedup works correctly
  lastDecisionWindowKey.set(sym, windowKey);
  // Increment the per-window bet counter so subsequent ticks respect maxBetsPerWindow.
  windowBetCounts.set(windowBetKey, betsThisWindow + 1);

  logger.info({ sym, direction, fillPrice, contractCount, betsThisWindow: betsThisWindow + 1 }, "[kalshi-bot] bet placed");
}

// ---------------------------------------------------------------------------
// Close position helper
// ---------------------------------------------------------------------------

async function closePosition(
  pos: OpenPosition,
  currentYesPrice: number | null,
  currentKalshiTarget: number | null,
  reason: string,
  isLateRecovery = false,
): Promise<void> {
  const isExpiry = reason === "window_expired";

  // When the window expires, currentYesPrice belongs to the NEW window — never
  // use it for P&L. Instead, estimate settlement using the last known price of
  // the COIN vs the Kalshi target to determine win/loss.
  // Convention: YES contract pays $1 if price ends ≥ target, $0 otherwise.
  //             NO  contract pays $1 if price ends <  target, $0 otherwise.
  // We use the position's kalshiTarget (recorded at entry) and the last coin
  // price before window change to compute estimated settlement.
  // This will be corrected by the evaluator job (task #112) once Kalshi settles.
  let fillPrice: number | null = isExpiry ? null : currentYesPrice;

  if (botMode === "live" && !isExpiry) {
    try {
      const result = pos.direction === "yes"
        ? await sellYes(pos.ticker, pos.contractCount)
        : await sellNo(pos.ticker, pos.contractCount);
      fillPrice = result.avgPrice ?? currentYesPrice;
    } catch (err) {
      logger.error({ err, sym: pos.symbol }, "[kalshi-bot] exit order failed — position remains OPEN; will retry next tick");
      // Do NOT proceed: openPosition stays live so the next tick retries the exit.
      // Throwing here prevents the caller from clearing openPosition.
      throw err;
    }
  }

  // P&L calculation (paper or real)
  // For mid-window exits: pnl = (exitYesPrice - entryYesPrice) × contractCount
  //   YES bet profits when exitYesPrice > entryYesPrice
  //   NO  bet profits when exitYesPrice < entryYesPrice (they go inverse)
  // For expiry: TEMP paper simulation uses fixed return rate (see PAPER_WIN_RETURN_RATE).
  //   In live mode this path is replaced by evalClosedBets using real candle data.

  // Paper win return rate: configurable via config.paperWinReturnRate.
  // Default 0.50 = 50¢ profit per $1 bet. Change in Bot Configuration panel.
  const PAPER_WIN_RETURN_RATE = config.paperWinReturnRate ?? 0.50;

  let pnl = 0;
  if (fillPrice !== null) {
    // Mid-window exit: price-based PnL (kept as-is for live accuracy)
    const priceDelta = pos.direction === "yes"
      ? fillPrice - pos.entryYesPrice
      : pos.entryYesPrice - fillPrice;
    pnl = priceDelta * pos.contractCount;
  } else if (isExpiry) {
    // Estimate settlement from last known coin price vs strike
    const cachedCoin = getCachedPrediction(pos.symbol);
    const lastCoinPrice = cachedCoin?.price ?? null;
    const strike = currentKalshiTarget ?? pos.kalshiTarget;
    if (lastCoinPrice !== null) {
      const priceAboveStrike = lastCoinPrice >= strike;
      const won = pos.direction === "yes" ? priceAboveStrike : !priceAboveStrike;
      // TEMP paper simulation: win = +50% of bet, loss = -100% of bet
      pnl = won ? pos.betAmount * PAPER_WIN_RETURN_RATE : -pos.betAmount;
    } else {
      // No price data — book conservatively as full loss
      pnl = -pos.betAmount;
    }
  }

  dailyPnl += pnl;
  if (pnl < 0) dailyLossCount++;

  // Circuit breaker: update consecutive-loss streak and trigger if needed.
  cbState = applyBetOutcome(
    cbState,
    pnl >= 0,
    config.maxConsecutiveLosses,
    config.circuitBreakerPauseWindows,
  );
  if (pnl >= 0 && cbState.consecutiveLosses === 0) {
    logger.info({ cbState }, "[kalshi-bot] win — consecutive loss streak reset");
  } else if (pnl < 0) {
    logger.info(
      { cbState, maxConsecutiveLosses: config.maxConsecutiveLosses },
      "[kalshi-bot] loss — consecutive loss count updated",
    );
    if (cbState.circuitBreakerWindowsRemaining > 0 && cbState.consecutiveLosses === config.maxConsecutiveLosses) {
      logger.warn(
        { cbState },
        "[kalshi-bot] ⚡ circuit breaker TRIGGERED — new entries paused for this many windows",
      );
    }
  }

  // Recover account balance
  if (botMode === "live") {
    getBalance()
      .then((b) => { accountBalance = b.availableBalance; })
      .catch(() => {});
  } else {
    accountBalance = (accountBalance ?? config.paperStartingBalance ?? 100) + pnl; // simulated paper balance
  }

  const phase2RecoveredAmount = isLateRecovery && pnl > -pos.betAmount
    ? pnl - (-pos.betAmount)  // how much we recovered vs riding to zero
    : null;

  // Capture the live coin price at the moment the position is closed.
  const cryptoPriceAtExit = getCachedPrediction(pos.symbol)?.price ?? null;

  // Non-throwing: all in-memory state (P&L, balance, circuit-breaker,
  // recentKalshiTargets) is already updated above. A DB failure here must
  // NOT prevent openPositions.delete() from running — otherwise the position
  // stays stuck in memory across windows and no further bets can be placed.
  try {
    await persistBetRecord({
      symbol: pos.symbol,
      windowKey: pos.windowKey,
      ticker: pos.ticker,
      direction: pos.direction,
      action: isLateRecovery ? "late_recovery_exit" : isExpiry ? "expired" : "exit",
      signals: pos.entryDecision.signals,
      entryPrice: pos.entryYesPrice,
      exitPrice: fillPrice ?? undefined,
      kalshiTarget: pos.kalshiTarget,
      contractCount: pos.contractCount,
      betAmount: pos.betAmount,
      pnl,
      exitReason: reason,
      phase2Activated: pos.phase2Activated,
      phase2RecoveredAmount: phase2RecoveredAmount ?? undefined,
      existingId: pos.id,
      cryptoPriceAtExit,
    });
  } catch (err) {
    logger.warn({ err, sym: pos.symbol }, "[kalshi-bot] closePosition: DB persist error (non-fatal) — position cleared from memory regardless");
  }

  // Update recent Kalshi strike history for momentum/regime tracking.
  // We record the target price from the closed position (oldest-first order).
  const closedSym = pos.symbol.toUpperCase();
  if (pos.kalshiTarget != null) {
    const existing = recentKalshiTargets.get(closedSym) ?? [];
    existing.push(pos.kalshiTarget);
    if (existing.length > REGIME_STRIKES_MAX) existing.splice(0, existing.length - REGIME_STRIKES_MAX);
    recentKalshiTargets.set(closedSym, existing);
  }

  logger.info(
    { sym: pos.symbol, pnl, reason, isLateRecovery, dailyPnl },
    "[kalshi-bot] position closed",
  );
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

interface BetRecordArgs {
  symbol: string;
  windowKey: string;
  ticker: string | null;
  direction: "yes" | "no" | null;
  action: string;
  signals: unknown;
  entryPrice: number | null | undefined;
  exitPrice?: number | null;
  kalshiTarget: number;
  contractCount?: number;
  betAmount?: number;
  pnl?: number;
  exitReason?: string;
  phase2Activated?: boolean;
  phase2RecoveredAmount?: number;
  // insertId: use this specific ID when inserting a new record (e.g. bets, where
  //   the id must match openPosition.id so the exit UPDATE can find the row).
  insertId?: string;
  // existingId: UPDATE the row with this id instead of inserting.
  existingId?: string;
  cryptoPriceAtEntry?: number | null;
  cryptoPriceAtExit?: number | null;
  // Active decision mode at the time of bet placement. Null on exit/expiry updates.
  decisionMode?: DecisionMode | null;
}

async function persistBetRecord(args: BetRecordArgs): Promise<void> {
  try {
    const id = args.existingId ?? args.insertId ?? `${args.symbol}:${args.windowKey}:${Date.now()}`;
    if (args.existingId) {
      // Update existing record (exit/expiry)
      await db
        .update(kalshiBotBetsTable)
        .set({
          exitPrice: args.exitPrice != null ? String(args.exitPrice) : undefined,
          pnl: args.pnl != null ? String(args.pnl) : undefined,
          exitReason: args.exitReason,
          action: args.action,
          phase2Activated: args.phase2Activated,
          phase2RecoveredAmount:
            args.phase2RecoveredAmount != null ? String(args.phase2RecoveredAmount) : undefined,
          cryptoPriceAtExit: args.cryptoPriceAtExit != null ? String(args.cryptoPriceAtExit) : undefined,
          exitedAt: new Date(),
        })
        .where(eq(kalshiBotBetsTable.id, id));
    } else {
      // Insert new record (bet entry, skip, warmup)
      await db.insert(kalshiBotBetsTable).values({
        id,
        symbol: args.symbol,
        windowKey: args.windowKey,
        ticker: args.ticker ?? undefined,
        direction: args.direction ?? undefined,
        action: args.action,
        mode: botMode,
        signals: args.signals as Record<string, unknown>,
        entryPrice: args.entryPrice != null ? String(args.entryPrice) : undefined,
        kalshiTarget: String(args.kalshiTarget),
        contractCount: args.contractCount,
        betAmount: args.betAmount != null ? String(args.betAmount) : undefined,
        cryptoPriceAtEntry: args.cryptoPriceAtEntry != null ? String(args.cryptoPriceAtEntry) : undefined,
        decisionMode: args.decisionMode ?? null,
        createdAt: new Date(),
      }).onConflictDoNothing();
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] DB persist error (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Closed-bet evaluator — wires outcome + evaluatedAt for settled positions
// ---------------------------------------------------------------------------

/**
 * Fetch the 1-minute close price at the END of a 15-minute window from
 * Coinbase historical candles.  The window key is "YYYY-MM-DDTHH:mm" (UTC).
 * The window ends at windowStart + 15 min; the last 1-min candle in that window
 * starts at windowEnd - 60 s (Coinbase reports `t` = candle start time).
 * Returns null on any error so the caller can retry next cycle.
 */
async function fetchWindowClosePrice(product: string, windowKey: string): Promise<number | null> {
  try {
    const COINBASE = "https://api.exchange.coinbase.com";
    const UA = "MarketEdge/1.0 (crypto-predictor)";

    const windowStartMs = new Date(windowKey + ":00Z").getTime();
    if (isNaN(windowStartMs)) return null;

    const windowEndMs   = windowStartMs + 15 * 60_000;
    const candleStartMs = windowEndMs - 60_000; // last 1-min candle in the window

    const url =
      `${COINBASE}/products/${encodeURIComponent(product)}/candles?granularity=60` +
      `&start=${new Date(candleStartMs).toISOString()}` +
      `&end=${new Date(windowEndMs).toISOString()}`;

    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;

    // Coinbase format (newest-first): [time, low, high, open, close, volume]
    const raw = (await res.json()) as number[][];
    if (!Array.isArray(raw) || raw.length === 0) return null;

    // Prefer the candle whose start time matches the expected slot; fall back
    // to the first returned candle (Coinbase may return a candle slightly off).
    const targetT = Math.floor(candleStartMs / 1000);
    const candle = raw.find((c) => c[0] === targetT) ?? raw[0];
    return candle[4]; // close price
  } catch {
    return null;
  }
}

/**
 * For every closed bet row that has not yet been evaluated (evaluatedAt IS NULL
 * and exitedAt IS NOT NULL), determine the true outcome and write outcome +
 * corrected pnl + evaluatedAt to the DB.
 *
 * - "expired" bets: fetch the actual candle close price from Coinbase at the
 *   window settlement boundary, compare against the Kalshi strike, and compute
 *   the correct pnl based on contract settlement ($1 per contract if won, $0 if lost).
 * - "exit" / "late_recovery_exit" bets: pnl was already derived from the real
 *   Kalshi exit price at trade time, so it is authoritative.  We only need to
 *   stamp outcome and evaluatedAt.
 *
 * Rows that cannot be resolved this cycle (missing price data, Coinbase error,
 * etc.) are skipped and retried on the next 30-second tick.
 */
// How long to wait before committing the full-loss fallback for expired rows
// where closePosition() had no cached coin price.  Gives the Coinbase candle
// time to finalise and the local prediction cache time to repopulate.
const EVAL_DEFER_MS = 5 * 60_000; // 5 minutes

export async function evalClosedBets(): Promise<void> {
  const deferCutoff = new Date(Date.now() - EVAL_DEFER_MS);

  try {
    // ── Step 0: transition orphaned open-bet rows from expired windows ────────
    // A row with action='bet' and exitedAt IS NULL whose windowKey is older than
    // the current window is an orphaned position — it was open when the server
    // restarted during an active window but the window has since expired.
    // These rows are invisible to the main evaluation query (which requires
    // exitedAt IS NOT NULL), so we must first mark them as 'expired' to make
    // them eligible for outcome evaluation on the next cycle.
    // windowKey strings are ISO-formatted ("YYYY-MM-DDTHH:mm") so lexicographic
    // ordering gives correct chronological ordering.
    const currentKey = currentWindowKey();
    const orphanedBets = await db
      .select({
        id: kalshiBotBetsTable.id,
        symbol: kalshiBotBetsTable.symbol,
        windowKey: kalshiBotBetsTable.windowKey,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNull(kalshiBotBetsTable.exitedAt),
          eq(kalshiBotBetsTable.action, "bet"),
          sql`${kalshiBotBetsTable.windowKey} < ${currentKey}`,
        ),
      );

    for (const orphan of orphanedBets) {
      logger.info(
        { id: orphan.id, symbol: orphan.symbol, windowKey: orphan.windowKey, currentKey },
        "[kalshi-bot] evalClosedBets: transitioning orphaned expired bet row",
      );
      await db
        .update(kalshiBotBetsTable)
        .set({ action: "expired", exitedAt: new Date() })
        .where(eq(kalshiBotBetsTable.id, orphan.id));
    }

    const rows = await db
      .select({
        id: kalshiBotBetsTable.id,
        symbol: kalshiBotBetsTable.symbol,
        windowKey: kalshiBotBetsTable.windowKey,
        direction: kalshiBotBetsTable.direction,
        action: kalshiBotBetsTable.action,
        pnl: kalshiBotBetsTable.pnl,
        kalshiTarget: kalshiBotBetsTable.kalshiTarget,
        contractCount: kalshiBotBetsTable.contractCount,
        entryPrice: kalshiBotBetsTable.entryPrice,
        betAmount: kalshiBotBetsTable.betAmount,
        exitedAt: kalshiBotBetsTable.exitedAt,
        cryptoPriceAtExit: kalshiBotBetsTable.cryptoPriceAtExit,
        signals: kalshiBotBetsTable.signals,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNull(kalshiBotBetsTable.evaluatedAt),
          sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')`,
        ),
      )
      .limit(20); // process in small batches — each expired row makes a network call

    if (rows.length === 0) return;

    let evaluated = 0;
    for (const row of rows) {
      let outcome: "win" | "loss" | "push";
      let correctedPnl: number | null = null;
      let closePrice: number | null = null;

      if (row.action === "expired") {
        // ── Settlement evaluation: fetch actual candle close at window end ──
        const coin = CRYPTO_COINS.find((c) => c.symbol === row.symbol);
        if (!coin || !row.windowKey || row.direction == null) continue;

        const strike = row.kalshiTarget != null ? parseFloat(String(row.kalshiTarget)) : null;
        const entryPrice = row.entryPrice != null ? parseFloat(String(row.entryPrice)) : null;
        const count = row.contractCount ?? 1;
        if (strike == null || entryPrice == null) continue;

        // Detect rows where closePosition() had no cached coin price and fell
        // back to a full-loss estimate (cryptoPriceAtExit === null for expired).
        // These are ambiguous: the bot might actually have won.
        const noCoinPriceAtExit = row.cryptoPriceAtExit == null;
        const exitedAt = row.exitedAt instanceof Date
          ? row.exitedAt
          : row.exitedAt != null ? new Date(row.exitedAt as string) : null;
        const pastDeferWindow = exitedAt == null || exitedAt <= deferCutoff;

        if (noCoinPriceAtExit && !pastDeferWindow) {
          // Still within the 5-minute deferral — wait for the candle to finalise
          // and the prediction cache to repopulate before committing.
          logger.debug(
            { sym: row.symbol, id: row.id, exitedAt },
            "[kalshi-bot] evalClosedBets: deferring ambiguous expiry row (within 5-min window)",
          );
          continue;
        }

        closePrice = await fetchWindowClosePrice(coin.product, row.windowKey);

        // Coinbase candle unavailable (e.g. BNB is not listed on Coinbase).
        // Fall back to the coin price recorded at window expiry — it's the same
        // value closePosition() already used for the initial P&L estimate, so
        // using it here is consistent and prevents the row staying stuck forever.
        if (closePrice === null && row.cryptoPriceAtExit != null) {
          closePrice = parseFloat(String(row.cryptoPriceAtExit));
          logger.info(
            { sym: row.symbol, id: row.id, windowKey: row.windowKey, closePrice },
            "[kalshi-bot] evalClosedBets: Coinbase candle unavailable — using cryptoPriceAtExit as close price",
          );
        }

        if (closePrice === null) {
          if (noCoinPriceAtExit && pastDeferWindow) {
            // Past the deferral window and no price source is available at all.
            // Commit the full-loss fallback recorded by closePosition() so
            // the row doesn't stay unevaluated forever.  Log a warning so
            // the operator knows this outcome may be inaccurate.
            const fallbackPnl = row.pnl != null ? parseFloat(String(row.pnl)) : null;
            if (fallbackPnl == null) continue;
            const fallbackOutcome: "win" | "loss" | "push" =
              fallbackPnl > 0 ? "win" : fallbackPnl < 0 ? "loss" : "push";
            logger.warn(
              { sym: row.symbol, id: row.id, windowKey: row.windowKey, pnl: fallbackPnl },
              "[kalshi-bot] evalClosedBets: committing full-loss fallback — no price source after 5-min deferral; outcome may be inaccurate",
            );
            await db
              .update(kalshiBotBetsTable)
              .set({ outcome: fallbackOutcome, evaluatedAt: new Date() })
              .where(eq(kalshiBotBetsTable.id, row.id));
            evaluated++;
            continue;
          }
          // No price source available yet — retry next cycle.
          logger.debug({ sym: row.symbol, id: row.id }, "[kalshi-bot] evalClosedBets: no price source available, will retry");
          continue;
        }

        const priceAboveStrike = closePrice >= strike;
        const won = row.direction === "yes" ? priceAboveStrike : !priceAboveStrike;
        outcome = won ? "win" : "loss";

        // TEMPORARY: paper-mode fixed return (50¢ profit per $1 bet, full loss on lose).
        // Remove when connecting to live Kalshi — replace with real contract PnL:
        //   win:  (1 - entryPrice) * count  (YES) / entryPrice * count  (NO)
        //   loss: -entryPrice * count        (YES) / -(1-entryPrice) * count (NO)
        const betAmt = row.betAmount != null ? parseFloat(String(row.betAmount)) : entryPrice * count;
        correctedPnl = won ? betAmt * 0.50 : -betAmt;

        logger.info(
          { sym: row.symbol, windowKey: row.windowKey, closePrice, strike, direction: row.direction, outcome, pnl: correctedPnl },
          "[kalshi-bot] evalClosedBets: expired bet settled",
        );
      } else {
        // ── Mid-window exit: pnl already computed from real exit price ────────
        const pnl = row.pnl != null ? parseFloat(String(row.pnl)) : null;
        if (pnl == null) continue; // pnl not yet written; skip
        outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "push";
      }

      // Merge closePrice into the signals JSONB so the dashboard can display it
      // without needing a separate column or an extra API call.
      const updatedSignals = {
        ...(row.signals as Record<string, unknown> ?? {}),
        ...(closePrice != null ? { closePriceAtEval: closePrice } : {}),
      };

      if (correctedPnl !== null) {
        await db
          .update(kalshiBotBetsTable)
          .set({ outcome, pnl: String(correctedPnl), evaluatedAt: new Date(), signals: updatedSignals })
          .where(eq(kalshiBotBetsTable.id, row.id));
      } else {
        await db
          .update(kalshiBotBetsTable)
          .set({ outcome, evaluatedAt: new Date(), signals: updatedSignals })
          .where(eq(kalshiBotBetsTable.id, row.id));
      }

      // Update in-memory window outcome map for the doubt-penalty signal.
      const wk = row.windowKey;
      if (wk && correctedPnl !== null) {
        const wo = recentWindowOutcomes.get(wk) ?? { wins: 0, losses: 0 };
        if (correctedPnl > 0) wo.wins++;
        else if (correctedPnl < 0) wo.losses++;
        recentWindowOutcomes.set(wk, wo);
      }

      evaluated++;
    }

    if (evaluated > 0) {
      logger.info({ evaluated }, "[kalshi-bot] evalClosedBets — outcomes stamped");
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] evalClosedBets error (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getBotHistory(limit = 20): Promise<unknown[]> {
  try {
    // Only return terminal outcomes for the recent table — bet entries and
    // intermediate marks (e.g. exit_failed) are excluded for fidelity.
    return await db
      .select()
      .from(kalshiBotBetsTable)
      .where(sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')`)
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

export async function getBotTrend(limit = 50): Promise<TrendPoint[]> {
  try {
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        pnl: sql<string>`COALESCE(${kalshiBotBetsTable.pnl}::text, '0')`,
        outcome: kalshiBotBetsTable.outcome,
        createdAt: kalshiBotBetsTable.createdAt,
      })
      .from(kalshiBotBetsTable)
      .where(sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
        AND ${kalshiBotBetsTable.outcome} IS NOT NULL`)
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

// Returns bet-action records for the bot dashboard — excludes skip/warmup audit
// rows which are internal-only and would otherwise crowd out real bet records
// within the pagination limit.
export async function getBotAllHistory(limit = 100, offset = 0): Promise<unknown[]> {
  try {
    return await db
      .select()
      .from(kalshiBotBetsTable)
      .where(sql`${kalshiBotBetsTable.action} NOT IN ('skip', 'warmup') AND ${kalshiBotBetsTable.archivedAt} IS NULL`)
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

export async function getBotStats(filterSymbol?: string): Promise<{
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
    const whereClause = filterSymbol
      ? sql`${baseWhere} AND ${kalshiBotBetsTable.symbol} = ${filterSymbol.toUpperCase()}`
      : baseWhere;

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
// Bot loop — called from index.ts every 30 s
// ---------------------------------------------------------------------------

// Iterates over all Kalshi-enabled coins, ensures fresh Kalshi market data is
// available (fetching from the public API if the cache is stale), then runs
// the bot tick for each coin.  The Kalshi market-data endpoint is public and
// requires no API key, so this works in both paper and live modes.
export async function runBotLoopTick(): Promise<void> {
  // Evaluate any closed bets that haven't been stamped with outcome yet.
  // Fire-and-forget — outcome evaluation is non-blocking and non-fatal.
  evalClosedBets().catch(() => {});

  // Always run window-expiry check, even when paused or disabled.
  // If the 15-minute window rolls over while a position is still open (e.g.
  // the bot was paused, or the tick was slow), we must mark it expired and
  // clear in-memory state so the next window starts fresh.
  if (openPositions.size > 0) {
    const currentKey = currentWindowKey();
    // Snapshot entries before iterating — deletes inside the loop are safe on a Map,
    // but a snapshot makes the control flow easier to reason about.
    for (const [posSymbol, stalePos] of Array.from(openPositions.entries())) {
      if (stalePos.windowKey !== currentKey) {
        logger.info(
          { sym: posSymbol, oldKey: stalePos.windowKey, newKey: currentKey },
          "[kalshi-bot] window expired — auto-closing open position",
        );
        // Clear immediately so a concurrent tick cannot double-close the same position.
        openPositions.delete(posSymbol);
        try {
          const kalshiData = getKalshiCachedData(posSymbol);
          await closePosition(
            stalePos,
            kalshiData?.yesPrice ?? null,
            kalshiData?.value ?? null,
            "window_expired",
          );
        } catch (err) {
          logger.warn({ err, sym: posSymbol }, "[kalshi-bot] window-expiry close error (non-fatal)");
        }
      }
    }
  }

  // Circuit-breaker countdown: decrement once per 15-min window at the TOP of the loop
  // so the counter advances even when the bot is paused or in quiet hours.
  // The pre-decrement value is captured in `cbWindowsAtStart` so the gate below can
  // check it accurately — this ensures N configured pause windows = N windows actually
  // skipped (gate fires on the pre-decrement value, not the already-decremented one).
  const cbWindowNow = currentWindowKey();
  const isCBNewWindow = cbWindowNow !== lastCircuitBreakerWindowKey;
  const cbWindowsAtStart = cbState.circuitBreakerWindowsRemaining;
  if (isCBNewWindow) {
    lastCircuitBreakerWindowKey = cbWindowNow;
    // Reset per-window direction counts so the cap applies fresh each 15-min window.
    windowDirectionCounts.clear();
    if (cbState.circuitBreakerWindowsRemaining > 0) {
      cbState = tickCircuitBreakerWindow(cbState);
      logger.info(
        { circuitBreakerWindowsRemaining: cbState.circuitBreakerWindowsRemaining },
        "[kalshi-bot] circuit breaker countdown — windows remaining",
      );
    }
    // Decrement per-coin auto-tune pause counters; remove coins whose pause expires.
    const nextPausedCoins = decrementPausedCoins(pausedCoins);
    for (const [sym] of pausedCoins.entries()) {
      if (!nextPausedCoins.has(sym)) {
        logger.info({ sym }, "[kalshi-bot] auto-tune per-coin pause expired — resuming");
      } else {
        logger.info({ sym, remaining: nextPausedCoins.get(sym) }, "[kalshi-bot] auto-tune per-coin pause countdown");
      }
    }
    // Sync in-memory map with the decremented state
    for (const sym of Array.from(pausedCoins.keys())) {
      if (!nextPausedCoins.has(sym)) pausedCoins.delete(sym);
      else pausedCoins.set(sym, nextPausedCoins.get(sym)!);
    }

    // Temporary confidence raise revert: if auto-tune raised minConfidence for a
    // fixed number of windows, check whether the revert window has arrived and
    // restore the original value automatically.
    if (config.autoTuneConfidenceRevertAt && cbWindowNow >= config.autoTuneConfidenceRevertAt) {
      const revertTo = config.autoTuneConfidenceRevertTo ?? DEFAULT_BOT_CONFIG.minConfidence;
      logger.info(
        { from: config.minConfidence, to: revertTo, revertAt: config.autoTuneConfidenceRevertAt },
        "[auto-tune] temporary confidence raise expired — reverting to base",
      );
      await updateBotConfig({
        minConfidence: revertTo,
        autoTuneConfidenceRevertAt: null,
        autoTuneConfidenceRevertTo: null,
      }).catch(() => {});
    }
  }

  if (!config.enabled || paused) return;

  // Phase 1: refresh market data for all Kalshi-enabled coins.
  for (const coin of CRYPTO_COINS) {
    if (!KALSHI_SERIES[coin.symbol]) continue;
    await fetchKalshiTarget(coin.symbol).catch(() => null);
  }

  // Window-open stability analysis: fire Claude trend-stability for every Kalshi coin
  // that now has valid strike + yes price data. Tracks per-coin dispatch so that coins
  // whose markets publish later (10-30s delay) get picked up on subsequent ticks within
  // the same window rather than being silently skipped.
  const newWindowKey = currentWindowKey();
  if (newWindowKey !== lastStabilityWindowKey) {
    lastStabilityWindowKey = newWindowKey;
    stabilityFiredForCoins.clear();
    windowStabilityCache.clear();
  }
  // Re-check every tick for coins that weren't ready on earlier ticks of this window.
  const pendingCoins = CRYPTO_COINS.filter(c => {
    if (!KALSHI_SERIES[c.symbol]) return false;
    const sym = c.symbol.toUpperCase();
    if (stabilityFiredForCoins.has(sym)) return false;  // already dispatched
    const kd = getKalshiCachedData(sym);
    return kd?.value != null && kd.yesPrice != null;
  });
  if (pendingCoins.length > 0 && isAiFeatureEnabled("crypto_stability")) {
    // Mark synchronously before any await to prevent double-dispatch on overlapping ticks.
    pendingCoins.forEach(c => stabilityFiredForCoins.add(c.symbol.toUpperCase()));
    void Promise.all(
      pendingCoins.map(c => {
        const sym = c.symbol.toUpperCase();
        return fetchTrendStabilityForBot(sym, newWindowKey)
          .then(r => {
            if (r) windowStabilityCache.set(sym, r.trendStability);
          })
          .catch(() => {
            // Remove from dispatched set so the next tick retries for this coin.
            stabilityFiredForCoins.delete(sym);
          });
      }),
    );
    logger.info({ windowKey: newWindowKey, coins: pendingCoins.map(c => c.symbol) }, "[kalshi-bot] window-open trend stability analysis fired");
  }

  // Phase 2: manage exit for every open position (one tick per symbol).
  // _runBotTick returns early after managing an existing position so the
  // same coin does not immediately re-enter in Phase 4 of this tick.
  if (openPositions.size > 0) {
    for (const [sym] of Array.from(openPositions.entries())) {
      const kalshiData = getKalshiCachedData(sym);
      const prediction = getCachedPrediction(sym);
      try {
        await runBotTickForCoin(
          sym,
          kalshiData?.ticker ?? null,
          kalshiData?.value ?? null,
          kalshiData?.yesPrice ?? null,
          prediction?.candles ?? [],
        );
      } catch (err) {
        logger.warn({ err, sym }, "[kalshi-bot] exit tick error (non-fatal)");
      }
    }
  }

  // Quiet-hours gate: skip new entries during the configured UTC hour range.
  if (isInQuietHours(new Date().getUTCHours(), config.quietHoursStart, config.quietHoursEnd)) {
    logger.debug(
      { utcHour: new Date().getUTCHours(), quietHoursStart: config.quietHoursStart, quietHoursEnd: config.quietHoursEnd },
      "[kalshi-bot] quiet hours — skipping new entry",
    );
    return;
  }

  // Circuit breaker gate: gate on the PRE-decrement snapshot so that N pause windows
  // = N windows where new entries are blocked (countdown already advanced at top of loop).
  if (cbWindowsAtStart > 0) {
    logger.info(
      { circuitBreakerWindowsRemaining: cbState.circuitBreakerWindowsRemaining },
      "[kalshi-bot] circuit breaker active — skipping new entry",
    );
    return;
  }

  // Phase 3: best-market selection.
  // Speculatively evaluate all eligible coins with makeBotDecision to rank
  // candidates. Coins that already have an open position (managed above in
  // Phase 2) will skip entry in _runBotTick so only genuinely idle symbols
  // compete for a new position. Other coins follow for SKIP record deduplication.
  const windowKey = currentWindowKey();
  const evalResults: WindowCoinEvaluation[] = [];

  // --- Window-doubt penalty ---
  // If the last 1-2 completed windows had a poor win rate (<40%) the market
  // is in an uncertain/choppy regime. Raise the effective confidence floor
  // by 4pp (one bad window) or 8pp (two consecutive bad windows) to avoid
  // over-betting into noise. We inspect completed windows only (wk < windowKey).
  const DOUBT_WIN_RATE_THRESHOLD = 0.4;
  const completedWindowKeys = [...recentWindowOutcomes.keys()]
    .filter(wk => wk < windowKey)
    .sort()
    .reverse()
    .slice(0, 2);
  let windowDoubtPenalty = 0;
  let weakWindowCount = 0;
  for (const wk of completedWindowKeys) {
    const wo = recentWindowOutcomes.get(wk)!;
    const total = wo.wins + wo.losses;
    if (total >= 3 && wo.wins / total < DOUBT_WIN_RATE_THRESHOLD) weakWindowCount++;
  }
  if (weakWindowCount >= 2) windowDoubtPenalty = 8;
  else if (weakWindowCount === 1) windowDoubtPenalty = 4;
  if (windowDoubtPenalty > 0) {
    logger.info(
      { windowDoubtPenalty, weakWindowCount, checkedWindows: completedWindowKeys },
      `[kalshi-bot] doubt penalty: ${weakWindowCount} recent window(s) <${DOUBT_WIN_RATE_THRESHOLD * 100}% win rate — confidence floor +${windowDoubtPenalty}pp`,
    );
  }
  // Store for Task-C signal enrichment: _runBotTick includes this in the signals JSON.
  currentWindowDoubtPenalty = windowDoubtPenalty;
  // Symbols blocked by the new regime-aware guards (momentum override, directional cap, border guard).
  // These must be excluded from Phase-4 orderedSymbols so runBotTickForCoin cannot
  // independently place a bet that the Phase-3 filter just blocked.
  const filteredByNewGuards = new Set<string>();

  // Refresh border-proximity and regime caches once per window transition.
  if (windowKey !== borderProximityCacheWindow) {
    const syms = CRYPTO_COINS
      .filter(c => KALSHI_SERIES[c.symbol])
      .map(c => c.symbol.toUpperCase());
    if (config.enableBorderGuard) {
      borderProximityCache = await loadBorderProximityCache(syms, config.borderLookbackBets);
      logger.debug({ borderProximityCache: Object.fromEntries(borderProximityCache) },
        "[kalshi-bot] border-proximity cache refreshed");
    }
    regimeCache = await loadRegimeCache(syms, config.borderLookbackBets);
    regimeCacheWindow = windowKey;
    borderProximityCacheWindow = windowKey;
    logger.debug({ regimeCache: Object.fromEntries(regimeCache) },
      "[kalshi-bot] regime cache refreshed");
  }

  for (const coin of CRYPTO_COINS) {
    if (!KALSHI_SERIES[coin.symbol]) continue;
    const sym = coin.symbol.toUpperCase();
    const kalshiData = getKalshiCachedData(sym);
    const winCtx = getKalshiWindowContext(sym);
    const secondsElapsed = winCtx?.secondsElapsed ?? 0;
    const minutesElapsed = winCtx?.minutesElapsed ?? 0;
    const now = new Date().toISOString();

    // Derive regime from recent Kalshi strikes for this symbol (always computed).
    const recentStrikes = recentKalshiTargets.get(sym) ?? [];
    const regime: PriceRegime | null = recentStrikes.length >= 2
      ? deriveRegime(recentStrikes, config.momentumWindowCount)
      : null;

    // Per-coin auto-tune pause guard: skip entry when this coin has been
    // suspended by the auto-tune engine (5 consecutive losses).
    if (pausedCoins.has(sym)) {
      const remaining = pausedCoins.get(sym) ?? 0;
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `auto-tune paused (${remaining} windows remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }

    if (!kalshiData?.ticker || kalshiData.value === null) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "no market data", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    if (secondsElapsed < WINDOW_ENTRY_BUFFER_S) {
      const remaining = Math.ceil(WINDOW_ENTRY_BUFFER_S - secondsElapsed);
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `window buffer (${remaining}s remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    if (config.maxEntryMinutes > 0 && secondsElapsed > config.maxEntryMinutes * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `past entry ceiling (>${config.maxEntryMinutes}min elapsed)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    const minRem = config.minRemainingMinutes ?? 0;
    if (minRem > 0 && 15 * 60 - secondsElapsed < minRem * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `min-remaining floor (<${minRem}min remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }

    // Cached bot-timing accuracy is used for composite score ranking only.
    // Signal accuracy (from prediction_records) is passed separately to makeBotDecision
    // for the EV gate so it reflects signal quality rather than bot win rate.
    const marks = [1, 3, 6, 9, 12];
    const elapsedMin = Math.floor(minutesElapsed);
    const closest = marks.reduce((p, m) => Math.abs(m - elapsedMin) < Math.abs(p - elapsedMin) ? m : p, marks[0]);
    const timingAcc = timingCache.get(`${sym}:${closest * 60}`) ?? timingCache.get(`ALL:${closest * 60}`) ?? null;

    const signalAcc = getPredictionAnalytics(sym).bySource.ensemble.accuracyPct;
    const decision = makeBotDecision(sym, config, kalshiData.ticker, kalshiData.yesPrice ?? null, minutesElapsed, signalAcc, kalshiData.value);
    const stability = windowStabilityCache.get(sym) ?? null;
    const reason = decision.reasoning;

    // Apply the bet profile's confidence cap before any further filters.
    // In aggressive mode this clamps at 80% — preventing the false-unanimity
    // problem where all signals agree in choppy markets and produce inflated 85-92%
    // confidence bets that win at only ~50%.
    const _betProfile = BET_PROFILES[config.betProfile ?? "normal"];
    let effectiveConfidence = Math.min(decision.confidence, _betProfile.effectiveConfidenceCap);

    // Reversing: apply a -20pp penalty instead of a hard skip. Only very
    // high-conviction entries still clear minConfidence after the penalty.
    // Subtracts from the already-profile-capped value for consistency.
    let reversingCaution = false;
    if (stability === "reversing" && decision.action !== "SKIP") {
      effectiveConfidence = effectiveConfidence - 20;
      reversingCaution = true;
      if (effectiveConfidence < config.minConfidence) {
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `reversing-caution (${decision.confidence}%→${effectiveConfidence}%) — ${reason.slice(0, 40)}`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: "reversing",
          regime,
        });
        continue;
      }
    }

    // Momentum override filter: skip when price trend opposes the proposed direction.
    // filteredByNewGuards ensures Phase-4 cannot bypass this by calling runBotTickForCoin.
    if (decision.action !== "SKIP" && config.enableMomentumFilter) {
      const proposedDir = decision.action === "BET_YES" ? "yes" : "no";
      if (checkMomentumOverride(proposedDir, recentStrikes, 0.5, config.momentumWindowCount)) {
        logger.info({ sym, proposedDir, recentStrikes, windowCount: config.momentumWindowCount },
          `[kalshi-bot] momentum override — ${sym} trending against ${proposedDir.toUpperCase()} entry`);
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `momentum override — trending against ${proposedDir.toUpperCase()} entry`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        continue;
      }
    }

    // Directional-cap filter: skip when too many same-direction bets already placed this window.
    // filteredByNewGuards ensures Phase-4 cannot bypass this by calling runBotTickForCoin.
    if (decision.action !== "SKIP" && config.enableDirectionCap) {
      const proposedDir = decision.action === "BET_YES" ? "yes" : "no";
      const dirCount = windowDirectionCounts.get(proposedDir) ?? 0;
      if (config.maxSameDirectionBets > 0 && dirCount >= config.maxSameDirectionBets) {
        logger.info({ sym, proposedDir, dirCount, cap: config.maxSameDirectionBets },
          `[kalshi-bot] directional cap reached — skipping ${proposedDir.toUpperCase()} entry for ${sym}`);
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `directional cap reached — skipping ${proposedDir.toUpperCase()} entry`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        continue;
      }
    }

    // Regime filter: if recent settlements consistently closed on one side of the strike,
    // penalise bets going against that regime by raising the minimum confidence bar.
    // This prevents the bot from fighting a persistent directional bias.
    if (decision.action !== "SKIP") {
      const regime = regimeCache.get(sym);
      const isAgainstRegime =
        (regime === "above" && decision.action === "BET_NO") ||
        (regime === "below" && decision.action === "BET_YES");
      if (isAgainstRegime) {
        const penalised = effectiveConfidence - (config.regimePenalty ?? REGIME_AGAINST_PENALTY_FALLBACK);
        logger.info(
          { sym, regime, action: decision.action, confidence: effectiveConfidence, penalised },
          `[kalshi-bot] regime filter — ${sym} regime=${regime} vs ${decision.action}: confidence ${effectiveConfidence}→${penalised}`,
        );
        if (penalised < config.minConfidence) {
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `regime filter — ${regime} regime, against-direction penalty → ${penalised}% < ${config.minConfidence}%`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime: regimeCache.get(sym) as "above" | "below" | "neutral" | null ?? null,
          });
          continue;
        }
        effectiveConfidence = penalised;
      }
    }

    // Position-relative NO gate: when the live crypto price is already above the
    // Kalshi strike by > 0.1%, a NO bet is a mean-reversion call into a trending
    // market. Historical data shows 7/7 NO losses in exactly this configuration.
    // Require ML confirmation (mlAbove === false) OR broad 3-signal agreement to
    // allow entry — otherwise skip.
    if (decision.action === "BET_NO" && kalshiData.value !== null) {
      const livePrice = getCachedPrediction(sym)?.price ?? null;
      const ABOVE_STRIKE_NO_GAP = 0.001; // 0.1% above strike
      if (livePrice !== null && livePrice > kalshiData.value * (1 + ABOVE_STRIKE_NO_GAP)) {
        const sigs = decision.signals as { signalsAgreeing?: number; mlAbove?: boolean | null };
        const mlConfirmsNo = sigs.mlAbove === false;
        const broadAgreement = (sigs.signalsAgreeing ?? 0) >= 3;
        if (!mlConfirmsNo && !broadAgreement) {
          const gapPct = ((livePrice - kalshiData.value) / kalshiData.value * 100).toFixed(3);
          logger.info(
            { sym, livePrice, kalshiTarget: kalshiData.value, gapPct, signalsAgreeing: sigs.signalsAgreeing, mlAbove: sigs.mlAbove },
            `[kalshi-bot] NO gate — ${sym} price +${gapPct}% above strike, no ML reversal confirmation`,
          );
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `NO gate — price +${gapPct}% above strike, requires ML or 3-signal agreement`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          continue;
        }
      }
    }

    // --- Per-coin direction filter (Task A) + YES consensus gate (Task B) ---
    // Task A: Block coins/directions with insufficient historical edge.
    //   COIN_FULLY_BLOCKED (SOL): no edge in either direction → skip entirely.
    //   COIN_YES_BLOCKED (BTC/ETH/DOGE): historical YES WR <25% → block YES entirely.
    // Task B: All remaining YES bets require stat+claude+ml to ALL agree (full 3-signal
    //   consensus). Mixed YES bets (any signal misaligned) average 0-33% WR vs 73%+ for
    //   full-consensus NO. NO bets are allowed with stat+claude only (60-70% WR).
    if (decision.action !== "SKIP") {
      if (COIN_FULLY_BLOCKED.has(sym)) {
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `coin filter — ${sym} blocked (no edge in either direction: NO ${sym==="SOL"?"22":"?"}% WR, YES ${sym==="SOL"?"40":"?"}% WR)`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        continue;
      }

      if (decision.action === "BET_YES") {
        if (COIN_YES_BLOCKED.has(sym)) {
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `coin filter — ${sym} YES blocked (historical WR ≤25%)`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          continue;
        }

        // Full 3-signal consensus required for YES bets
        const yesSigs = decision.signals as { statAbove?: boolean | null; claudeAbove?: boolean | null; mlAbove?: boolean | null };
        const has3SignalYes = yesSigs.statAbove === true && yesSigs.claudeAbove === true && yesSigs.mlAbove === true;
        if (!has3SignalYes) {
          const sig = (v: boolean | null | undefined) => v === true ? "Y" : v === false ? "N" : "?";
          const signalSummary = `Stat=${sig(yesSigs.statAbove)} Claude=${sig(yesSigs.claudeAbove)} ML=${sig(yesSigs.mlAbove)}`;
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `YES consensus gate — requires all 3 signals agree (${signalSummary})`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          continue;
        }
      }
    }

    // Window-doubt filter: if recent windows had poor win rates, require higher conviction
    // for both YES and NO bets. This prevents the bot from over-betting during choppy
    // uncertain regimes when all signals are marginal.
    if (windowDoubtPenalty > 0 && effectiveConfidence < config.minConfidence + windowDoubtPenalty) {
      filteredByNewGuards.add(sym);
      evalResults.push({
        symbol: sym,
        action: "SKIP",
        confidence: effectiveConfidence,
        score: 0,
        reason: `doubt filter — ${weakWindowCount} weak recent window(s), ${effectiveConfidence}% < ${config.minConfidence + windowDoubtPenalty}% floor (+${windowDoubtPenalty}pp)`,
        windowKey,
        selected: false,
        evaluatedAt: now,
        trendStability: stability,
        regime: regimeCache.get(sym) as "above" | "below" | "neutral" | null ?? null,
      });
      continue;
    }

    // Border-proximity guard: skip when the coin's close prices have been landing
    // within config.borderProximityPct % of the strike over the last N settled bets.
    // These windows are essentially noise — near-50/50 regardless of signal direction.
    if (decision.action !== "SKIP" && config.enableBorderGuard) {
      const proximity = borderProximityCache.get(sym);
      if (proximity !== undefined && proximity < config.borderProximityPct) {
        logger.info(
          { sym, avgProximityPct: proximity.toFixed(3), threshold: config.borderProximityPct },
          `[kalshi-bot] border guard — ${sym} price hovering near strike avg ${proximity.toFixed(2)}% gap`,
        );
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `border guard — avg ${proximity.toFixed(2)}% from strike (last ${config.borderLookbackBets} bets)`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        continue;
      }
    }

    // clean → ×1.2 bonus for stable directional momentum; choppy/unknown → ×1.0
    const stabilityMultiplier = stability === "clean" ? 1.2 : 1.0;

    // Blend vote-agreement confidence with per-model certainty to differentiate coins
    // that share the same signal ratio.
    const sigs = decision.signals as {
      statConfidence?: number | null;
      claudeConfidence?: number | null;
      mlConfidence?: number | null;
    };
    const modelConfs = [sigs.statConfidence, sigs.claudeConfidence, sigs.mlConfidence]
      .filter((v): v is number => typeof v === "number");
    const avgModelConf = modelConfs.length > 0
      ? modelConfs.reduce((a, b) => a + b, 0) / modelConfs.length
      : effectiveConfidence;
    const blendedConf = effectiveConfidence * 0.6 + avgModelConf * 0.4;
    const score = blendedConf * ((timingAcc ?? 50) / 100) * stabilityMultiplier;

    const finalReason = reversingCaution
      ? `[reversing-caution] ${reason.slice(0, 60)}`
      : reason;

    evalResults.push({
      symbol: sym,
      action: decision.action as "BET_YES" | "BET_NO" | "SKIP",
      confidence: effectiveConfidence,
      score,
      reason: finalReason,
      windowKey,
      selected: false,
      evaluatedAt: now,
      trendStability: stability,
      regime,
    });
  }

  // Sort: BET candidates descending by composite score, then SKIP coins.
  const bets = evalResults.filter(e => e.action !== "SKIP").sort((a, b) => b.score - a.score);
  const skips = evalResults.filter(e => e.action === "SKIP");

  // Cross-coin chop detection: when 4 or more eligible coins are all in the
  // "low conviction" confidence band (≤58%), the market is indecisive across
  // the board. Cap the bet count to 2 — the top two ranked candidates — to
  // avoid scattering capital into marginal signals that all look like noise.
  // Excess bets are downgraded to SKIP so Phase 4 cannot place them.
  const LOW_CONVICTION_BAND = 58;
  const CHOP_MIN_COINS = 4;
  const lowConvCount = bets.filter(e => e.confidence <= LOW_CONVICTION_BAND).length;
  if (lowConvCount >= CHOP_MIN_COINS) {
    const capped = bets.splice(2); // keep top 2, remove the rest
    for (const e of capped) {
      e.action = "SKIP";
      e.reason = `chop filter — ${lowConvCount} coins ≤${LOW_CONVICTION_BAND}% confidence, capped at 2 bets`;
      filteredByNewGuards.add(e.symbol);
      skips.push(e);
    }
    logger.info(
      { lowConvCount, cappedSymbols: capped.map(e => e.symbol) },
      `[kalshi-bot] chop filter: ${lowConvCount} low-confidence coins — capping to 2 bets this window`,
    );
  }

  if (bets.length > 0) {
    bets[0].selected = true;
    const winner = bets[0];
    const multiplierDesc =
      winner.trendStability === "clean" ? "×1.2 (clean)" :
      winner.trendStability === "choppy" ? "×1.0 (choppy)" :
      winner.trendStability === null ? "×1.0 (pending)" : "×1.0";
    logger.info({
      symbol: winner.symbol,
      action: winner.action,
      confidence: winner.confidence,
      score: winner.score.toFixed(2),
      trendStability: winner.trendStability ?? "pending",
      multiplier: multiplierDesc,
      windowKey,
    }, "[kalshi-bot] best-market selected");
  }
  lastWindowEvaluation = [...bets, ...skips];

  // Phase 4: run ticks in priority order — best BET candidate first.
  // Once a position is opened, break so only one bet is placed per tick.
  // Reversing coins that survived the confidence penalty appear in bets[] and
  // execute normally. Reversing coins that were soft-skipped are in skips[] with
  // trendStability="reversing" and are filtered out of execution to avoid double-entry.
  const orderedSymbols = [
    ...bets.map(e => e.symbol),
    // Exclude: reversing-caution soft-skips (handled separately) AND symbols blocked by
    // momentum override / directional-cap so runBotTickForCoin cannot bypass Phase-3 filters.
    ...skips.filter(e =>
      e.trendStability !== "reversing" &&
      !filteredByNewGuards.has(e.symbol)
    ).map(e => e.symbol),
  ];
  for (const sym of orderedSymbols) {
    const kalshiData = getKalshiCachedData(sym);
    const prediction = getCachedPrediction(sym);
    // Capture before-state so we can detect a fresh bet placement for this symbol.
    const hadPositionBefore = openPositions.has(sym);
    try {
      await runBotTickForCoin(
        sym,
        kalshiData?.ticker ?? null,
        kalshiData?.value ?? null,
        kalshiData?.yesPrice ?? null,
        prediction?.candles ?? [],
      );
    } catch (err) {
      logger.warn({ err, sym }, "[kalshi-bot] loop tick error (non-fatal)");
    }
    // Track direction counts for the directional-cap filter across the window.
    if (!hadPositionBefore && openPositions.has(sym)) {
      const dir = openPositions.get(sym)!.direction;
      windowDirectionCounts.set(dir, (windowDirectionCounts.get(dir) ?? 0) + 1);
    }
    // No break — with multi-position support each coin enters independently.
  }
}

// ---------------------------------------------------------------------------
// Window evaluation accessor (for the bot dashboard)
// ---------------------------------------------------------------------------

export function getWindowEvaluation(): WindowCoinEvaluation[] {
  return lastWindowEvaluation;
}

// ---------------------------------------------------------------------------
// Performance report & auto-tune job
// ---------------------------------------------------------------------------

export function getPerformanceReport(): PerformanceReport | null {
  return cachedPerformanceReport;
}

export function getPausedCoinState(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, rem] of pausedCoins.entries()) out[sym] = rem;
  return out;
}

/** Clear all per-coin auto-tune pauses and reset the circuit-breaker countdown.
 *  Does NOT change bot mode, config, or position state.
 *  Call this when pauses are stale and the user wants to resume immediately. */
export function clearAllPauses(): { clearedCoins: string[]; cbWasActive: boolean } {
  const clearedCoins = [...pausedCoins.keys()];
  pausedCoins.clear();
  const cbWasActive = cbState.circuitBreakerWindowsRemaining > 0;
  cbState = { ...cbState, circuitBreakerWindowsRemaining: 0 };
  logger.info({ clearedCoins, cbWasActive }, "[kalshi-bot] all pauses cleared manually");
  return { clearedCoins, cbWasActive };
}

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
export async function getBotLogicPerformance(): Promise<LogicModeStats[]> {
  try {
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
          AND ${kalshiBotBetsTable.archivedAt} IS NULL`,
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

// Re-export pure approval function from isolated zero-dependency module so
// the DB-importing getBacktestModes() can call it while tests import it directly.
export { backtestModeApproval } from "./kalshi-bot-backtest-core.js";
import { backtestModeApproval } from "./kalshi-bot-backtest-core.js";

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

      const p      = parseFloat(r.pnl ?? "0");
      const isWin  = r.outcome ? r.outcome === "win"  : p > 0;
      const isLoss = r.outcome ? r.outcome === "loss" : p < 0;

      // Does a signal agree with the actual bet direction?
      const aboveExpected = dir === "yes";
      const statA   = statAbove   !== null ? statAbove   === aboveExpected : null;
      const claudeA = claudeAbove !== null ? claudeAbove === aboveExpected : null;
      const mlA     = mlAbove     !== null ? mlAbove     === aboveExpected : null;

      for (const mode of ALL_MODES) {
        const approved = backtestModeApproval(mode, aboveExpected, statAbove, claudeAbove, mlAbove);

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

/**
 * Fetch the last 200 settled bets from the DB, compute a PerformanceReport,
 * run auto-tune rules, apply safe config mutations, and log every mutation.
 * Should be called once every 15 min (e.g. from index.ts setInterval).
 */
export async function runAutoTuneJob(): Promise<void> {
  try {
    // Fetch settled bets (oldest first so last-30 slice is correct)
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        direction: kalshiBotBetsTable.direction,
        pnl: kalshiBotBetsTable.pnl,
        exitReason: kalshiBotBetsTable.exitReason,
        createdAt: kalshiBotBetsTable.createdAt,
        exitedAt: kalshiBotBetsTable.exitedAt,
        signals: kalshiBotBetsTable.signals,
        outcome: kalshiBotBetsTable.outcome,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.outcome} IS NOT NULL`,
      )
      .orderBy(desc(kalshiBotBetsTable.createdAt)) // most-recent first → reverse below
      .limit(config.autoTuneWindowSize ?? 100);

    rows.reverse(); // convert to oldest-first so slice(-30) gives the most recent 30

    const bets: SettledBetRecord[] = rows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      pnl: r.pnl,
      exitReason: r.exitReason,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      exitedAt: r.exitedAt instanceof Date ? r.exitedAt.toISOString()
              : r.exitedAt != null ? String(r.exitedAt) : null,
      signals: (r.signals as Record<string, unknown>) ?? null,
      outcome: r.outcome,
    }));

    const report = computePerformanceReport(bets);
    cachedPerformanceReport = report;

    const tuneConfig = {
      minConfidence: config.minConfidence,
      quietHoursStart: config.quietHoursStart,
      quietHoursEnd: config.quietHoursEnd,
      enableAutoTuning: config.enableAutoTuning ?? true,
      defaultMinConfidence: DEFAULT_BOT_CONFIG.minConfidence,
      autoTuneConfidenceRevertAt: config.autoTuneConfidenceRevertAt ?? null,
      autoTuneConfidenceRevertTo: config.autoTuneConfidenceRevertTo ?? null,
    };

    // Build a per-rule "last fired at" map from the log table so the cooldown
    // check in runAutoTuneRules survives server restarts.
    const lastFiredAt = new Map<string, Date>();
    try {
      const logRows = await db
        .select({ ruleName: botAutoTuneLogTable.ruleName, createdAt: botAutoTuneLogTable.createdAt })
        .from(botAutoTuneLogTable)
        .orderBy(desc(botAutoTuneLogTable.createdAt))
        .limit(50); // enough to find the most-recent entry for each distinct rule

      for (const row of logRows) {
        if (row.ruleName && row.createdAt && !lastFiredAt.has(row.ruleName)) {
          lastFiredAt.set(row.ruleName, row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)));
        }
      }
    } catch (err) {
      logger.warn({ err }, "[auto-tune] failed to load last-fired timestamps (non-fatal — cooldown skipped)");
    }

    const mutations: AutoTuneMutation[] = runAutoTuneRules(report, tuneConfig, pausedCoins, lastFiredAt);

    if (mutations.length === 0) {
      logger.info({ totalBets: report.totalBets, overallWinRate: report.overallWinRate },
        "[auto-tune] report computed — no parameter changes warranted");
      return;
    }

    for (const mutation of mutations) {
      logger.info({ ruleName: mutation.ruleName, oldValue: mutation.oldValue, newValue: mutation.newValue, reason: mutation.triggerReason },
        "[auto-tune] applying mutation");

      // Persist the log entry to DB
      try {
        await db.insert(botAutoTuneLogTable).values({
          ruleName: mutation.ruleName,
          oldValue: mutation.oldValue,
          newValue: mutation.newValue,
          triggerReason: mutation.triggerReason,
          createdAt: new Date(),
        });
      } catch (err) {
        logger.warn({ err }, "[auto-tune] failed to write log entry (non-fatal)");
      }

      // Apply config mutations
      if (mutation.configMutation) {
        config = { ...config, ...mutation.configMutation };
        // Persist new config to DB (fire-and-forget)
        updateBotConfig(mutation.configMutation).catch(() => {});
      }

      // Apply per-coin pause
      if (mutation.pauseCoin) {
        const { symbol: pauseSym, windows } = mutation.pauseCoin;
        pausedCoins.set(pauseSym.toUpperCase(), windows);
        logger.info({ sym: pauseSym, windows }, "[auto-tune] per-coin pause applied");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[auto-tune] job failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentWindowKey(): string {
  const nowMs = Date.now();
  const windowMs = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000);
  return new Date(windowMs).toISOString().slice(0, 16);
}
