// Kalshi auto-betting bot — orchestration layer.
//
// State machine:
//   IDLE → (window opens + BET decision) → OPEN_POSITION
//   OPEN_POSITION → (exit guard clears OR window closes) → IDLE
//
// Paper mode: all trade calls are simulated; DB records are written with mode="paper".
// Live mode: requires KALSHI_API_KEY secret and explicit user toggle.

import { db, kalshiBotBetsTable, botConfigTable } from "@workspace/db";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  DEFAULT_BOT_CONFIG,
  makeBotDecision,
  type BotConfig,
  type BotDecision,
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
  CRYPTO_COINS,
  KALSHI_SERIES,
  type TrendStability,
} from "./crypto";

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

export interface BotStateSnapshot {
  mode: BotMode;
  status: BotStatus;
  paused: boolean;
  config: BotConfig;
  openPosition: OpenPosition | null;
  openPositionCurrentYesPrice: number | null; // live market price for the open position
  openPositionUnrealizedPnl: number | null;   // estimated P&L at current mark
  dailyPnl: number;
  dailyLossCount: number;
  dailyDate: string;        // YYYY-MM-DD in UTC
  accountBalance: number | null;
  lastUpdatedAt: string;
  lastGuardStates: GuardStates | null;
  lastGuardReason: string | null;
  configured: boolean;      // KALSHI_API_KEY present
  // Seconds remaining in the 45-second warmup period at the start of each window.
  // null when not in warmup (elapsed ≥ 45s), or when a position is already open.
  warmupSecondsRemaining: number | null;
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
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let botMode: BotMode = "paper";
let paused = false;
let config: BotConfig = { ...DEFAULT_BOT_CONFIG };
let openPosition: OpenPosition | null = null;
let dailyPnl = 0;
let dailyLossCount = 0;
let dailyDate = todayUTC();
// Paper mode starts with a simulated $100 balance so the dashboard can display
// it immediately.  Live mode reads the real account balance from Kalshi.
let accountBalance: number | null = 100;
let lastGuardStates: GuardStates | null = null;
let lastGuardReason: string | null = null;
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

// Warmup duration (ms) at the start of each window before the bot can enter.
// 45s allows the Kalshi market to stabilise and the Claude opening call to complete.
const WARMUP_MS = 45_000;

// Hard late-entry floor: never open a new position if fewer than this many minutes
// remain in the 15-min window. This is a non-configurable safety rail — late entries
// leave almost no time for the position to resolve and are consistently losing plays.
const MIN_REMAINING_MINUTES_FOR_ENTRY = 4;

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
    : openPosition !== null
    ? "position_open"
    : "idle";

  // Compute unrealized P&L for open position using live Kalshi yes-price
  let openPositionCurrentYesPrice: number | null = null;
  let openPositionUnrealizedPnl: number | null = null;
  if (openPosition !== null) {
    const liveKalshi = getKalshiCachedData(openPosition.symbol);
    if (liveKalshi?.yesPrice != null) {
      openPositionCurrentYesPrice = liveKalshi.yesPrice;
      // YES bet: profits when yesPrice rises; NO bet: profits when yesPrice falls
      const priceDelta = openPosition.direction === "yes"
        ? liveKalshi.yesPrice - openPosition.entryYesPrice
        : openPosition.entryYesPrice - liveKalshi.yesPrice;
      openPositionUnrealizedPnl = priceDelta * openPosition.contractCount;
    }
  }

  // Compute warmup state: how many seconds remain before the bot can enter the
  // current window. null when a position is already open or warmup is over.
  let warmupSecondsRemaining: number | null = null;
  if (openPosition === null && !paused) {
    for (const coin of CRYPTO_COINS) {
      if (!KALSHI_SERIES[coin.symbol]) continue;
      const winCtx = getKalshiWindowContext(coin.symbol);
      if (!winCtx) continue;
      const remaining = Math.max(0, WARMUP_MS / 1_000 - winCtx.secondsElapsed);
      if (remaining > 0) {
        // Use the longest remaining warmup so the UI clears only when all coins are ready
        warmupSecondsRemaining = Math.max(warmupSecondsRemaining ?? 0, remaining);
      }
      break; // All coins share the same window timing — one is enough
    }
  }

  return {
    mode: botMode,
    status,
    paused,
    config: { ...config },
    openPosition: openPosition
      ? {
          ...openPosition,
          exitState: openPosition.exitState, // reference — callers should not mutate
        }
      : null,
    openPositionCurrentYesPrice,
    openPositionUnrealizedPnl,
    dailyPnl,
    dailyLossCount,
    dailyDate,
    accountBalance,
    lastUpdatedAt: new Date().toISOString(),
    lastGuardStates,
    lastGuardReason,
    configured: isKalshiConfigured(),
    warmupSecondsRemaining,
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
    await db
      .insert(botConfigTable)
      .values({ id: "default", config: snapshot, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: botConfigTable.id,
        set: { config: snapshot, updatedAt: new Date() },
      });
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
    await db
      .insert(botConfigTable)
      .values({ id: "default", config: stored, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: botConfigTable.id,
        set: { config: stored, updatedAt: new Date() },
      });
    persisted = true;
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to persist config to DB (non-fatal)");
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
    logger.info({ dailyPnl, dailyLossCount, date: today }, "[kalshi-bot] daily P&L loaded from DB");
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load daily P&L from DB (non-fatal)");
  }
}

/**
 * Recover an open position from the DB after a server restart.
 * Looks for the most recent 'bet' row with no exitedAt within the last 24 hours
 * (24h covers midnight-UTC boundaries so a position opened late in one day is
 * still found on a post-midnight restart). If found:
 *   - Window still active → restores openPosition so the exit guard resumes on
 *     the next tick. No double-entry can occur because the existing
 *     `openPosition !== null` guard in the loop already prevents it.
 *   - Window expired → leaves openPosition null; the evalClosedBets evaluator
 *     will eventually settle the row once the position is properly closed by
 *     the next bot-loop window-expiry check.
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
      .orderBy(desc(kalshiBotBetsTable.createdAt))
      .limit(1);

    if (rows.length === 0) {
      logger.info("[kalshi-bot] no open position found in DB");
      return;
    }

    const row = rows[0];

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
      return;
    }

    const windowKey = row.windowKey;
    const currentKey = currentWindowKey();

    if (windowKey !== currentKey) {
      // Window has already expired — leave openPosition null per task spec.
      // The bot loop's window-expiry check will close the row on the next tick
      // once the position is restored; evalClosedBets will settle it thereafter.
      logger.info(
        { id: row.id, symbol: row.symbol, windowKey, currentKey },
        "[kalshi-bot] recovered position window has expired — leaving for normal evaluator flow",
      );
      return;
    }

    const entryYesPrice = parseFloat(String(row.entryPrice));
    const direction = row.direction as "yes" | "no";

    openPosition = {
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
    };

    logger.info(
      { id: row.id, symbol: row.symbol, windowKey, direction, entryYesPrice },
      "[kalshi-bot] open position restored from DB — exit guard will resume on next tick",
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to restore open position from DB (non-fatal)");
  }
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
    if (openPosition !== null && openPosition.symbol === sym) {
      logger.warn({ sym }, "[kalshi-bot] daily limit hit — closing position");
      await closePosition(openPosition, yesPrice, kalshiTarget, "daily_loss_limit_hit");
      openPosition = null;
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

  if (openPosition !== null) {
    // Cross-symbol guard: only manage exit logic for the symbol that owns the position.
    // Other coins iterate through this function too — they must skip without touching state.
    if (openPosition.symbol !== sym) return;

    // Check if the window has changed (expired)
    if (openPosition.windowKey !== windowKey) {
      await closePosition(openPosition, yesPrice, kalshiTarget, "window_expired");
      openPosition = null;
    } else {
      // Run exit guard for the current position
      const timingAcc = await getTimingAccuracy(sym, minutesElapsed);
      const guard = runExitGuard(
        sym,
        openPosition.direction,
        minutesElapsed,
        yesPrice,
        openPosition.exitState,
        timingAcc,
        erValue,
        config.midExitSensitivity,
        config.phase2ThresholdPp,
      );

      lastGuardStates = guard.guardStates;
      lastGuardReason = guard.reason;

      if (guard.guardStates.phase2Active && !openPosition.phase2Activated) {
        openPosition.phase2Activated = true;
        logger.info({ sym, reason: guard.reason }, "[kalshi-bot] Phase 2 activated");
      }

      if (guard.recommendation === "EXIT") {
        const isLateRecovery = guard.phase === 2;
        await closePosition(
          openPosition,
          yesPrice,
          kalshiTarget,
          guard.reason,
          isLateRecovery,
        );
        openPosition = null;
      }
    }
    return; // one active position per tick — don't also try to open a new one
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

  // Hard ceiling: precise seconds check so the limit is exact.
  // e.g. maxEntryMinutes=5 → no entry after t+5:00, not t+5:59.
  if (secondsElapsed > config.maxEntryMinutes * 60) return;
  // Hard late-entry floor: never enter if fewer than MIN_REMAINING_MINUTES_FOR_ENTRY
  // minutes remain, regardless of the maxEntryMinutes setting. Enforced here at
  // execution time (Phase 3 evaluation also skips, but this is the authoritative guard).
  if (15 * 60 - secondsElapsed < MIN_REMAINING_MINUTES_FOR_ENTRY * 60) {
    logger.debug({ sym, secondsElapsed }, "[kalshi-bot] hard late-entry floor — skipping");
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

  // 45-second warmup: let the Kalshi market stabilise and the Claude opening
  // call complete before the bot commits to an entry.
  // Log a single SKIP with reason "warmup" per (symbol, window) for audit visibility.
  if (secondsElapsed < WARMUP_MS / 1_000) {
    if (lastDecisionWindowKey.get(sym) !== `warmup:${windowKey}`) {
      lastDecisionWindowKey.set(sym, `warmup:${windowKey}`);
      await persistBetRecord({
        symbol: sym,
        windowKey,
        ticker: kalshiTicker,
        direction: null,
        action: "skip",
        signals: { warmupActive: true, secondsElapsed, minutesElapsed, reason: "warmup" },
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
  );

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
  openPosition = {
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

  await persistBetRecord({
    symbol: sym,
    windowKey,
    ticker: kalshiTicker,
    direction,
    action: "bet",
    signals: decision.signals,
    entryPrice: openPosition.entryYesPrice,
    kalshiTarget,
    contractCount,
    betAmount,
    // Use insertId (not existingId) so persistBetRecord INSERTs this row.
    // The exit UPDATE will find it later via existingId: pos.id.
    insertId: id,
    cryptoPriceAtEntry,
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
  // For expiry: use cached coin price vs kalshiTarget to estimate settlement
  let pnl = 0;
  if (fillPrice !== null) {
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
      if (won) {
        // YES win: receive $1, paid yesPrice → profit = (1 - entryYesPrice) × count
        // NO  win: receive $1, paid (1-yesPrice) → profit = entryYesPrice × count
        pnl = pos.direction === "yes"
          ? (1 - pos.entryYesPrice) * pos.contractCount
          : pos.entryYesPrice * pos.contractCount;
      } else {
        // YES loss: paid yesPrice, receives $0 → loss = -entryYesPrice × count
        // NO  loss: paid (1-yesPrice), receives $0 → loss = -(1-entryYesPrice) × count
        pnl = pos.direction === "yes"
          ? -pos.entryYesPrice * pos.contractCount
          : -(1 - pos.entryYesPrice) * pos.contractCount;
      }
    } else {
      // No price data — book conservatively as full loss
      pnl = pos.direction === "yes"
        ? -pos.entryYesPrice * pos.contractCount
        : -(1 - pos.entryYesPrice) * pos.contractCount;
    }
  }

  dailyPnl += pnl;
  if (pnl < 0) dailyLossCount++;

  // Recover account balance
  if (botMode === "live") {
    getBalance()
      .then((b) => { accountBalance = b.availableBalance; })
      .catch(() => {});
  } else {
    accountBalance = (accountBalance ?? 100) + pnl; // simulated paper balance
  }

  const phase2RecoveredAmount = isLateRecovery && pnl > -pos.betAmount
    ? pnl - (-pos.betAmount)  // how much we recovered vs riding to zero
    : null;

  // Capture the live coin price at the moment the position is closed.
  const cryptoPriceAtExit = getCachedPrediction(pos.symbol)?.price ?? null;

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
        exitedAt: kalshiBotBetsTable.exitedAt,
        cryptoPriceAtExit: kalshiBotBetsTable.cryptoPriceAtExit,
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

        const closePrice = await fetchWindowClosePrice(coin.product, row.windowKey);
        if (closePrice === null) {
          if (noCoinPriceAtExit && pastDeferWindow) {
            // Past the deferral window and Coinbase is still unavailable.
            // Commit the full-loss fallback recorded by closePosition() so
            // the row doesn't stay unevaluated forever.  Log a warning so
            // the operator knows this outcome may be inaccurate.
            const fallbackPnl = row.pnl != null ? parseFloat(String(row.pnl)) : null;
            if (fallbackPnl == null) continue;
            const fallbackOutcome: "win" | "loss" | "push" =
              fallbackPnl > 0 ? "win" : fallbackPnl < 0 ? "loss" : "push";
            logger.warn(
              { sym: row.symbol, id: row.id, windowKey: row.windowKey, pnl: fallbackPnl },
              "[kalshi-bot] evalClosedBets: committing full-loss fallback — Coinbase unavailable after 5-min deferral; outcome may be inaccurate",
            );
            await db
              .update(kalshiBotBetsTable)
              .set({ outcome: fallbackOutcome, evaluatedAt: new Date() })
              .where(eq(kalshiBotBetsTable.id, row.id));
            evaluated++;
            continue;
          }
          // Coinbase unavailable but row is not ambiguous (or still in defer window) — retry next cycle.
          logger.debug({ sym: row.symbol, id: row.id }, "[kalshi-bot] evalClosedBets: Coinbase unavailable, will retry");
          continue;
        }

        const priceAboveStrike = closePrice >= strike;
        const won = row.direction === "yes" ? priceAboveStrike : !priceAboveStrike;
        outcome = won ? "win" : "loss";

        // Recompute pnl from actual settlement: winning contract pays $1, losing $0
        if (won) {
          correctedPnl = row.direction === "yes"
            ? (1 - entryPrice) * count   // YES win: received $1, paid entryYesPrice
            : entryPrice * count;        // NO win: received $1, paid (1-entryYesPrice)
        } else {
          correctedPnl = row.direction === "yes"
            ? -entryPrice * count        // YES loss: paid entryYesPrice, received $0
            : -(1 - entryPrice) * count; // NO loss: paid (1-entryYesPrice), received $0
        }

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
      .where(sql`${kalshiBotBetsTable.action} NOT IN ('skip', 'warmup')`)
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
    const baseWhere = sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')`;
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
  if (openPosition !== null) {
    const currentKey = currentWindowKey();
    if (openPosition.windowKey !== currentKey) {
      logger.info(
        { sym: openPosition.symbol, oldKey: openPosition.windowKey, newKey: currentKey },
        "[kalshi-bot] window expired — auto-closing open position",
      );
      const stalePosition = openPosition;
      // Clear immediately so a concurrent tick (unlikely but possible) does
      // not double-close the same position.
      openPosition = null;
      try {
        const kalshiData = getKalshiCachedData(stalePosition.symbol);
        await closePosition(
          stalePosition,
          kalshiData?.yesPrice ?? null,
          kalshiData?.value ?? null,
          "window_expired",
        );
      } catch (err) {
        logger.warn({ err, sym: stalePosition.symbol }, "[kalshi-bot] window-expiry close error (non-fatal)");
      }
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
  if (pendingCoins.length > 0) {
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

  // Phase 2: manage exit for the open position (if any), then return.
  // One position at a time — never enter a new position in the same tick as an exit.
  if (openPosition !== null) {
    const sym = openPosition.symbol;
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
    return;
  }

  // Phase 3: best-market selection.
  // Speculatively evaluate all eligible coins with makeBotDecision to rank
  // candidates. The highest-scoring coin (confidence × timing accuracy / 100)
  // gets its full runBotTickForCoin called first so it wins the single
  // open-position slot. Other coins follow for SKIP record deduplication.
  const windowKey = currentWindowKey();
  const evalResults: WindowCoinEvaluation[] = [];

  for (const coin of CRYPTO_COINS) {
    if (!KALSHI_SERIES[coin.symbol]) continue;
    const sym = coin.symbol.toUpperCase();
    const kalshiData = getKalshiCachedData(sym);
    const winCtx = getKalshiWindowContext(sym);
    const secondsElapsed = winCtx?.secondsElapsed ?? 0;
    const minutesElapsed = winCtx?.minutesElapsed ?? 0;
    const now = new Date().toISOString();

    if (!kalshiData?.ticker || kalshiData.value === null) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "no market data", windowKey, selected: false, evaluatedAt: now, trendStability: null });
      continue;
    }
    if (secondsElapsed < WARMUP_MS / 1_000) {
      const remaining = Math.ceil(WARMUP_MS / 1_000 - secondsElapsed);
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `warming up (${remaining}s)`, windowKey, selected: false, evaluatedAt: now, trendStability: null });
      continue;
    }
    if (secondsElapsed > config.maxEntryMinutes * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "past entry ceiling", windowKey, selected: false, evaluatedAt: now, trendStability: null });
      continue;
    }
    // Hard late-entry floor: always skip if fewer than MIN_REMAINING_MINUTES_FOR_ENTRY
    // minutes remain, regardless of the maxEntryMinutes setting.
    if (15 * 60 - secondsElapsed < MIN_REMAINING_MINUTES_FOR_ENTRY * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `late-entry floor (<${MIN_REMAINING_MINUTES_FOR_ENTRY}min remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null });
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
    const decision = makeBotDecision(sym, config, kalshiData.ticker, kalshiData.yesPrice ?? null, minutesElapsed, signalAcc);
    const stability = windowStabilityCache.get(sym) ?? null;
    const reason = decision.reasoning;

    // Reversing: apply a -20% confidence penalty instead of a hard skip.
    // Only very high-conviction entries (base 65% + boosters = 73–81%) survive the
    // penalty and still clear minConfidence. Low-conviction reversing windows are
    // still skipped, but high-agreement signals can proceed with a caution tag.
    let effectiveConfidence = decision.confidence;
    let reversingCaution = false;
    if (stability === "reversing" && decision.action !== "SKIP") {
      effectiveConfidence = decision.confidence - 20;
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
    });
  }

  // Sort: BET candidates descending by composite score, then SKIP coins.
  const bets = evalResults.filter(e => e.action !== "SKIP").sort((a, b) => b.score - a.score);
  const skips = evalResults.filter(e => e.action === "SKIP");
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
    ...skips.filter(e => e.trendStability !== "reversing").map(e => e.symbol),
  ];
  for (const sym of orderedSymbols) {
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
      logger.warn({ err, sym }, "[kalshi-bot] loop tick error (non-fatal)");
    }
    if (openPosition !== null) break; // bet placed — stop entering more
  }
}

// ---------------------------------------------------------------------------
// Window evaluation accessor (for the bot dashboard)
// ---------------------------------------------------------------------------

export function getWindowEvaluation(): WindowCoinEvaluation[] {
  return lastWindowEvaluation;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentWindowKey(): string {
  const nowMs = Date.now();
  const windowMs = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000);
  return new Date(windowMs).toISOString().slice(0, 16);
}
