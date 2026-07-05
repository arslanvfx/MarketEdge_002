// Shared mutable state for the Kalshi bot.
// Imported by kalshi-bot.ts and all sub-modules to avoid circular dependencies.

import { db, botConfigTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import {
  DEFAULT_BOT_CONFIG,
  type BotConfig,
  type CircuitBreakerState,
  type CoinStreakEntry,
  type BotDecision,
  type PriceRegime,
} from "./kalshi-bot-engine";
import { type ExitState, type GuardStates } from "./kalshi-bot-exit";
import { type TrendStability } from "./crypto";
import { type PerformanceReport } from "./kalshi-bot-performance";
import { type StreakDbStore } from "./kalshi-bot-streak-db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types (moved here so sub-modules and kalshi-bot.ts share a single definition)
// ---------------------------------------------------------------------------

export type BotMode = "paper" | "live";
export type BotStatus = "idle" | "position_open" | "paused" | "daily_limit_hit";

export interface OpenPosition {
  id: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  direction: "yes" | "no";
  entryYesPrice: number;
  contractCount: number;
  betAmount: number;
  kalshiTarget: number;
  openedAt: number;
  cryptoPriceAtEntry: number | null;
  exitState: ExitState;
  entryDecision: BotDecision;
  phase2Activated: boolean;
  entryMode: BotMode;
  source?: "bot" | "manual";
}

export interface OpenPositionDisplay extends OpenPosition {
  currentYesPrice: number | null;
  unrealizedPnl: number | null;
  guardStates: GuardStates | null;
  guardReason: string | null;
}

export interface BotStateSnapshot {
  mode: BotMode;
  status: BotStatus;
  paused: boolean;
  config: BotConfig;
  openPositions: OpenPositionDisplay[];
  dailyPnl: number;
  dailyLossCount: number;
  dailyDate: string;
  accountBalance: number | null;
  lastUpdatedAt: string;
  configured: boolean;
  warmupSecondsRemaining: number | null;
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  isInQuietHours: boolean;
  dbDegraded: boolean;
  dbDegradedSince: string | null;
  isProductionEnv: boolean;
  coinStreakState: Record<string, { consecutiveLosses: number; pauseUntilWindowKey: string | null }>;
}

export interface WindowCoinEvaluation {
  symbol: string;
  action: "BET_YES" | "BET_NO" | "SKIP";
  confidence: number;
  score: number;
  reason: string;
  windowKey: string;
  selected: boolean;
  betPlacedThisWindow?: boolean;
  placedBetDirection?: "yes" | "no";
  placedBetConfidence?: number;
  evaluatedAt: string;
  trendStability: TrendStability | null;
  regime: PriceRegime | null;
}

export interface ParoleState {
  doubtPenaltyReduction: number;
  reversing: Set<string>;
  momentum: Set<string>;
  priceBandYes: Set<string>;
  priceBandNo: Set<string>;
  yesBelowStrike: Set<string>;
  hardModel: Set<string>;
  noGate: Set<string>;
  regime: Set<string>;
  contrarian: Set<string>;
  border: Set<string>;
  yesBlocked: Set<string>;
  fullyBlocked: Set<string>;
  dirCapIncrease: number;
}

// ---------------------------------------------------------------------------
// Simple helpers used by state accessors and DB functions
// ---------------------------------------------------------------------------

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Mutable primitive state wrapped in object so sub-modules can read/write
// ---------------------------------------------------------------------------

export const S = {
  botMode: "paper" as BotMode,
  paused: false,
  config: { ...DEFAULT_BOT_CONFIG } as BotConfig,
  dailyPnl: 0,
  dailyLossCount: 0,
  dailyDate: new Date().toISOString().slice(0, 10),
  accountBalance: null as number | null,
  cbState: { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 } as CircuitBreakerState,
  lastCircuitBreakerWindowKey: "",
  _shadowParoleCache: null as {
    state: ParoleState;
    evaluatedCount: number;
    windowCutoff: string;
    mode: BotMode;
  } | null,
  borderProximityCache: new Map<string, number>(),
  borderProximityCacheWindow: "",
  regimeCache: new Map<string, "above" | "below" | "neutral">(),
  regimeCacheWindow: "",
  dbConsecutiveFailures: 0,
  dbFirstFailureAt: null as Date | null,
  dbDegradedSince: null as Date | null,
  lastStabilityWindowKey: "",
  stabilityFiredForCoins: new Set<string>(),
  currentWindowDoubtPenalty: 0,
  timingCache: new Map<string, number | null>(),
  timingCacheAt: 0,
  lastWindowEvaluation: [] as WindowCoinEvaluation[],
};

// ---------------------------------------------------------------------------
// Mutable Maps/Sets exported as reference types (const — safe to export)
// ---------------------------------------------------------------------------

export const openPositions = new Map<string, OpenPosition>();
export const midExitedWindows = new Map<string, { windowKey: string; direction: "yes" | "no" }>();
export const lastGuardStatesMap = new Map<string, GuardStates>();
export const lastGuardReasonMap = new Map<string, string>();
export const lastDecisionWindowKey = new Map<string, string>();
export const prefetchedTicker = new Map<string, string>();
export const windowBetCounts = new Map<string, number>();
export const windowTotalBets = new Map<string, number>();
export const windowBetDetails = new Map<string, { direction: "yes" | "no"; confidence: number }>();
export const windowDirectionCounts = new Map<"yes" | "no", number>();
export const windowFailedFills = new Set<string>();
export const windowZeroFillAttempts = new Map<string, number>();
export const pausedCoins = new Map<string, number>();
export const paperCoinDailyLoss = new Map<string, number>();
export const liveCoinDailyLoss = new Map<string, number>();
export const paperCoinStreakState = new Map<string, CoinStreakEntry>();
export const liveCoinStreakState = new Map<string, CoinStreakEntry>();
export const coinSlippageStrikes = new Map<string, { strikes: number; windowKey: string }>();
export const recentWindowOutcomes = new Map<string, { wins: number; losses: number }>();
export const windowCBBuffer = new Map<string, { wins: number; losses: number }>();
export const cachedPerformanceReportByMode = new Map<BotMode, PerformanceReport>();
export const recentKalshiTargets = new Map<string, number[]>();
export const windowStabilityCache = new Map<string, TrendStability>();

// ---------------------------------------------------------------------------
// Constants shared across the bot and sub-modules
// ---------------------------------------------------------------------------

export const REGIME_AGAINST_PENALTY_FALLBACK = 8;
export const CONTRARIAN_LIVE_REGIME_PENALTY = 10;
export const NOISE_CONFIDENCE_FLOOR = 45;
export const MIN_HARD_MODEL_SIGNALS = 2;
export const DB_DEGRADED_THRESHOLD = 10;
export const DB_DEGRADED_MIN_WINDOW_MS = 60_000;
export const REGIME_STRIKES_MAX = 6;
export const WINDOW_ENTRY_BUFFER_S = 60;
export const STABILITY_WAIT_MAX_S = 240;
// Mutable — parole system can remove coins when YES shadow accuracy reaches ≥60%.
// Re-initialised from the hardcoded list on every server restart.
export const COIN_YES_BLOCKED: Set<string> = new Set();
// Mutable — parole system can remove coins when shadow accuracy reaches ≥60%.
// Re-initialised from the hardcoded list on every server restart (so shadow
// data re-accumulates to re-parole the coin).  Never use `as const` or
// ReadonlySet here — checkAllParoles must be able to call .delete().
export const COIN_FULLY_BLOCKED: Set<string> = new Set();
export const TIMING_CACHE_TTL = 5 * 60_000;

// ---------------------------------------------------------------------------
// Mode-aware state accessors
// ---------------------------------------------------------------------------

export function activeCoinDailyLoss(): Map<string, number> {
  return S.botMode === "live" ? liveCoinDailyLoss : paperCoinDailyLoss;
}

export function coinDailyLossForMode(mode: BotMode): Map<string, number> {
  return mode === "live" ? liveCoinDailyLoss : paperCoinDailyLoss;
}

export function activeCoinStreakState(): Map<string, CoinStreakEntry> {
  return S.botMode === "live" ? liveCoinStreakState : paperCoinStreakState;
}

export function coinStreakStateForMode(mode: BotMode): Map<string, CoinStreakEntry> {
  return mode === "live" ? liveCoinStreakState : paperCoinStreakState;
}

// ---------------------------------------------------------------------------
// Streak DB store factory (uses db directly to avoid circular imports)
// ---------------------------------------------------------------------------

export function makeStreakStore(rowId: string): StreakDbStore {
  return {
    async upsert(snapshot) {
      await db.execute(sql`
        INSERT INTO bot_config (id, config, updated_at)
        VALUES (${rowId}, ${JSON.stringify(snapshot)}::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
      `);
    },
    async fetch() {
      const rows = await db
        .select()
        .from(botConfigTable)
        .where(eq(botConfigTable.id, rowId))
        .limit(1);
      if (rows.length === 0 || !rows[0].config) return null;
      return rows[0].config as Record<string, CoinStreakEntry>;
    },
  };
}

export const paperStreakStore: StreakDbStore = makeStreakStore("coin_streak_state_paper");
export const liveStreakStore: StreakDbStore = makeStreakStore("coin_streak_state_live");

export function streakStoreForMode(mode: BotMode): StreakDbStore {
  return mode === "live" ? liveStreakStore : paperStreakStore;
}

// ---------------------------------------------------------------------------
// DB watchdog helpers
// ---------------------------------------------------------------------------

export async function probeDb(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

export function resetDailyIfNeeded(): void {
  const today = todayUTC();
  if (today !== S.dailyDate) {
    S.dailyDate = today;
    S.dailyPnl = 0;
    S.dailyLossCount = 0;
    paperCoinDailyLoss.clear();
    liveCoinDailyLoss.clear();
  }
}

// Per-coin concurrent-tick guard (prevents double-processing same coin in one scheduler tick)
export const tickInFlight = new Set<string>();
