// Kalshi auto-betting bot — orchestration layer.
//
// State machine:
//   IDLE → (window opens + BET decision) → OPEN_POSITION
//   OPEN_POSITION → (exit guard clears OR window closes) → IDLE
//
// Paper mode: all trade calls are simulated; DB records are written with mode="paper".
// Live mode: requires KALSHI_API_KEY secret and explicit user toggle.

import { db, kalshiBotBetsTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
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
import { buyYes, buyNo, sellYes, sellNo, getBalance, isKalshiConfigured } from "./kalshi-trader";
import {
  getKalshiWindowContext,
  getTimingAnalysis,
  intraWindowMetrics,
  getCachedPrediction,
  getKalshiCachedData,
  fetchKalshiTarget,
  CRYPTO_COINS,
  KALSHI_SERIES,
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

// Timing analysis cache (refreshed every 5 min)
let timingCache: Map<string, number | null> = new Map();
let timingCacheAt = 0;
const TIMING_CACHE_TTL = 5 * 60_000;

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
  };
}

export function setBotMode(mode: BotMode): void {
  if (mode === "live" && !isKalshiConfigured()) {
    throw new Error("KALSHI_API_KEY not configured — cannot enable live mode");
  }
  botMode = mode;
  logger.info({ mode }, "[kalshi-bot] mode changed");
}

export function setBotPaused(p: boolean): void {
  paused = p;
  logger.info({ paused }, "[kalshi-bot] paused changed");
}

export function updateBotConfig(partial: Partial<BotConfig>): BotConfig {
  config = { ...config, ...partial };
  return { ...config };
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
    }
    return;
  }

  if (paused) return;

  // Get ER from recent candles
  const metrics = candles.length >= 3 ? intraWindowMetrics(candles, 15) : null;
  const erValue = metrics?.efficiencyRatio ?? null;

  const winCtx = getKalshiWindowContext(sym);
  const minutesElapsed = winCtx?.minutesElapsed ?? 0;
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

  // Only consider entering in the first few minutes of a window
  if (minutesElapsed > 5) return;
  if (!kalshiTicker || kalshiTarget === null) return;

  const timingAcc = await getTimingAccuracy(sym, minutesElapsed);
  const decision = makeBotDecision(
    sym,
    config,
    kalshiTicker,
    yesPrice,
    minutesElapsed,
    timingAcc,
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
      const result = direction === "yes"
        ? await buyYes(kalshiTicker, contractCount)
        : await buyNo(kalshiTicker, contractCount);
      fillPrice = result.avgPrice ?? yesPrice;
      orderId = result.orderId;
    } catch (err) {
      logger.error({ err, sym }, "[kalshi-bot] order placement failed");
      return;
    }
  }

  const id = `${sym}:${windowKey}:${Date.now()}`;
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
    // Pass the same id used for openPosition so the exit UPDATE finds this row
    existingId: id,
  });
  // Mark this window as having a recorded decision so SKIP dedup works correctly
  lastDecisionWindowKey.set(sym, windowKey);

  logger.info({ sym, direction, fillPrice, contractCount }, "[kalshi-bot] bet placed");
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
  existingId?: string;
}

async function persistBetRecord(args: BetRecordArgs): Promise<void> {
  try {
    const id = args.existingId ?? `${args.symbol}:${args.windowKey}:${Date.now()}`;
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
          exitedAt: new Date(),
        })
        .where(eq(kalshiBotBetsTable.id, id));
    } else {
      // Insert new record
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
        createdAt: new Date(),
      }).onConflictDoNothing();
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] DB persist error (non-fatal)");
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
      })
      .from(kalshiBotBetsTable)
      .where(whereClause);

    let totalBets = 0, wins = 0, losses = 0, totalPnl = 0, paperBets = 0, liveBets = 0;
    const coinMap = new Map<string, CoinBotStats>();

    for (const r of rows) {
      const p = parseFloat(r.pnl ?? "0");
      totalBets++;
      totalPnl += p;
      if (p > 0) wins++; else if (p < 0) losses++;
      if (r.mode === "paper") paperBets++; else liveBets++;

      const sym = r.symbol ?? "UNKNOWN";
      const coin = coinMap.get(sym) ?? { symbol: sym, bets: 0, wins: 0, losses: 0, pnl: 0 };
      coin.bets++;
      coin.pnl += p;
      if (p > 0) coin.wins++; else if (p < 0) coin.losses++;
      coinMap.set(sym, coin);
    }

    const bySymbol = Array.from(coinMap.values()).sort((a, b) => b.bets - a.bets);

    return { totalBets, wins, losses, totalPnl, paperBets, liveBets, bySymbol };
  } catch {
    return { totalBets: 0, wins: 0, losses: 0, totalPnl: 0, paperBets: 0, liveBets: 0, bySymbol: [] };
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
  if (!config.enabled || paused) return;

  for (const coin of CRYPTO_COINS) {
    if (!KALSHI_SERIES[coin.symbol]) continue;

    try {
      // Always refresh Kalshi market data for each coin on every tick so the
      // bot has a fresh yes price, ticker, and target — even for coins the
      // prediction tracker is not currently fetching.
      await fetchKalshiTarget(coin.symbol).catch(() => null);

      const prediction = getCachedPrediction(coin.symbol);
      const kalshiData = getKalshiCachedData(coin.symbol);

      await runBotTickForCoin(
        coin.symbol,
        kalshiData?.ticker ?? null,
        kalshiData?.value ?? null,
        kalshiData?.yesPrice ?? null,
        prediction?.candles ?? [],
      );
    } catch (err) {
      logger.warn({ err, symbol: coin.symbol }, "[kalshi-bot] loop tick error (non-fatal)");
    }
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
