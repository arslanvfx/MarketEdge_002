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
import { todayEastern } from "./eastern-time.ts";
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
  entrySignals?: { statAbove: boolean | null; claudeAbove: boolean | null; mlAbove: boolean | null };
  /** ID of a mirrored paper-mode DB record created when shadowPaperBets is enabled in live mode. */
  shadowPaperId?: string;
}

export interface OpenPositionDisplay extends OpenPosition {
  currentYesPrice: number | null;
  unrealizedPnl: number | null;
  guardStates: GuardStates | null;
  guardReason: string | null;
}

/** Effective Smart Hours mode for a single symbol, resolved via the server canonical resolver. */
export type SymbolSmartHoursMode = "active" | "silenced" | "reduced" | "no-schedule";

export interface BotStateSnapshot {
  mode: BotMode;
  status: BotStatus;
  paused: boolean;
  config: BotConfig;
  openPositions: OpenPositionDisplay[];
  dailyPnl: number;
  dailySpendAmount: number;
  dailyLossCount: number;
  dailyDate: string;
  accountBalance: number | null;
  lastUpdatedAt: string;
  configured: boolean;
  warmupSecondsRemaining: number | null;
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  isInQuietHours: boolean;
  quietHoursV2State: { mode: "active" | "silenced" | "reduced"; reducedBetAmount?: number; utcHour: number };
  autoTuneQHLastRunAt: string | null;
  autoTuneQHLastChanges: { silenced: number[]; unsilenced: number[] } | null;
  dbDegraded: boolean;
  dbDegradedSince: string | null;
  isProductionEnv: boolean;
  coinStreakState: Record<string, { consecutiveLosses: number; pauseUntilWindowKey: string | null }>;
  convictionPollerRunning: boolean;
  convictionPriceAgeMs: Record<string, number>;
  /** Whether Smart Hours is operating in global or per-market mode. */
  smartHoursScope: "global" | "per_market";
  /**
   * Per-symbol effective Smart Hours mode resolved via the canonical server resolver at the
   * time this snapshot was taken. Keys are upper-case symbols (BTC, ETH, …).
   * All tracked symbols are included; symbols without a schedule show "no-schedule".
   * Only populated when the global Smart Hours master is enabled; when master is OFF every
   * symbol shows "active".
   */
  symbolSmartHoursModes: Record<string, SymbolSmartHoursMode>;
  /** ISO timestamp at which symbolSmartHoursModes was resolved (shared across all symbols). */
  symbolSmartHoursResolvedAt: string;
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
  unanimousFailurePenaltyReduction: number;
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
  nearStrike: Set<string>;
  dirCapIncrease: number;
}

// ---------------------------------------------------------------------------
// Simple helpers used by state accessors and DB functions
// ---------------------------------------------------------------------------

export { todayEastern } from "./eastern-time.ts";

/** @deprecated Use todayEastern. Retained for split-module import compatibility. */
export const todayUTC = todayEastern;

/** Returns the currently active bot decision mode (e.g. "conviction", "classic"). */
export function getBotDecisionMode(): string {
  return S.config.decisionMode ?? "classic";
}

/**
 * Returns the daily loss limit that should be enforced for the current session.
 * In conviction mode, uses convictionDailyLossLimit (default $50) so the
 * certainty-based strategy gets its own budget separate from the global limit.
 * In all other modes falls back to the standard dailyLossLimit.
 */
export function getEffectiveDailyLossLimit(): number {
  if (S.config.decisionMode === "conviction" && S.config.convictionDailyLossLimit != null) {
    return S.config.convictionDailyLossLimit;
  }
  return S.config.dailyLossLimit;
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
  dailySpendAmount: 0,
  dailyDate: todayEastern(),
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
  currentUnanimousFailurePenalty: 0,
  timingCache: new Map<string, number | null>(),
  timingCacheAt: 0,
  lastWindowEvaluation: [] as WindowCoinEvaluation[],
  // Set by the bot loop when V2 quiet hours puts the current UTC hour in
  // "reduced bet" mode.  Cleared at the start of every loop tick outside
  // a reduced-bet hour.  The tick reads this to cap targetBetSize.
  quietHoursV2ReducedBet: null as number | null,
  autoTuneQHLastRunAt: null as string | null,
  autoTuneQHLastChanges: null as { silenced: number[]; unsilenced: number[] } | null,
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
// Per-window randomizer de-duplication: tracks which dollar amounts the
// randomizer has already picked for each coin in the current window.
// Key = sym, value = Set of dollar amounts already used.
// Cleared on window transition so each new window starts with a fresh pool.
export const windowRandomizerUsedValues = new Map<string, Set<number>>();
// Tracks which `sym:windowKey` pairs have already attempted a conviction-mode
// entry this window.  Prevents repeated bets when the Kalshi YES price oscillates
// across the lock threshold (e.g. 89¢ → 91¢ → 89¢ → 91¢).  Cleared on window
// transition alongside the other per-window guards.
export const convictionFiredThisWindow = new Set<string>();
// Tracks `sym:windowKey` pairs where a YES conviction bet was aborted because the
// YES bid was below the zone floor.  When extremeCautionEnabled=true, any subsequent
// YES entry attempt for that coin+window is blocked immediately.  Cleared on window
// transition alongside convictionFiredThisWindow.
export const extremeCautionAbortedThisWindow = new Set<string>();
// Keyed by `sym:windowKey` → timestamp (ms) of last live-gate "price moved
// outside window" abort.  Prevents repeated entry attempts in the same second
// while the conviction poller refreshes the cache after an abort.  Entries are
// cleared on window transition (alongside convictionFiredThisWindow).
// TTL: 10 s — long enough to outlast one poller cycle + bot-loop latency.
export const convictionAbortCooldown = new Map<string, number>();
export const CONVICTION_ABORT_COOLDOWN_MS = 5_000;
// Per-abort cooldown duration stored alongside convictionAbortCooldown.
// Boundary-miss aborts ("price past cap" or "poller out of zone") use
// CONVICTION_BOUNDARY_MISS_COOLDOWN_MS (2 s) so the bot retries quickly when
// the price oscillates back into the zone.  Direction-reversal and cross-check
// aborts keep the full CONVICTION_ABORT_COOLDOWN_MS (5 s).  Absent entries
// default to CONVICTION_ABORT_COOLDOWN_MS at the read site.
// Cleared on window transition alongside convictionAbortCooldown.
export const convictionAbortCooldownMs = new Map<string, number>();
export const CONVICTION_BOUNDARY_MISS_COOLDOWN_MS = 2_000;

// Pre-warmed authenticated orderbook snapshot for coins at the conviction zone.
// Populated by the conviction poller in the same poll cycle that detects zone
// entry — so the live-price gate in runBotTickForCoin can skip its own Kalshi
// API round-trip (0.5–2 s) and use the already-fetched data instead.
// Cleared on window transition.  TTL matches the conviction price map (1.5 s).
export interface ConvictionObSnapshot {
  yesAsk: number | null;
  yesBid: number | null;
  fetchedAt: number;
  /** Kalshi market ticker used for this fetch — must match expectedTicker
   *  in the tick before the cache is consumed. */
  ticker: string;
}
export const convictionObCache = new Map<string, ConvictionObSnapshot>(); // key = sym (upper-case)
export const CONVICTION_OB_CACHE_TTL_MS = 1_500;

// ---------------------------------------------------------------------------
// Conviction zone-entry dispatch callback
// ---------------------------------------------------------------------------
// Injected at module-load time by kalshi-bot-loop.ts so the conviction poller
// can fire a per-coin tick immediately on zone entry — eliminating the up-to-
// 4.9-second gap between "zone detected" (1 s poller) and "order dispatched"
// (5 s scheduler loop).  null until the callback is registered.
// All gates (live-price check, direction guard, candle slope) still run inside
// runBotTickForCoin — this only accelerates the dispatch timing.
// The poller passes the freshly-polled yesAsk/noAsk so the callback can
// independently re-verify the price against the REAL configured zone
// (deriveConvictionZone(floor, cap)) before dispatching — belt-and-suspenders
// so a future poller zone drift cannot dispatch out-of-zone ticks again.
let _convictionZoneEntryFn:
  | ((sym: string, yesAsk: number | null, noAsk: number | null) => void)
  | null = null;
export function setConvictionZoneEntryCallback(
  fn: (sym: string, yesAsk: number | null, noAsk: number | null) => void,
): void {
  _convictionZoneEntryFn = fn;
}
export function callConvictionZoneEntry(
  sym: string,
  yesAsk: number | null,
  noAsk: number | null,
): void {
  _convictionZoneEntryFn?.(sym, yesAsk, noAsk);
}
// Per-coin rolling price ticks from the conviction 1 s poller.
// Used by the direction guard to detect consecutive-seconds adverse movement.
// Entries are pushed on every poller read and trimmed to the last 30.
// Cleared on window transition so each window starts with a clean slate.
export const convictionPriceTicks = new Map<string, Array<{ price: number; ts: number }>>();
// Counts emergency closes (out-of-zone fills) per `sym:windowKey` this window.
// After MAX_EMERGENCY_CLOSES_PER_WINDOW the coin is locked out for the rest of
// the window — prevents the buy → emergency-close → re-buy bleed loop
// (XRP filled 4× out of zone in one window on 2026-07-13).
export const convictionEmergencyCloses = new Map<string, number>();

export interface ConvictionDirectionBlockInfo {
  direction: "yes" | "no";
  /** Which gate fired: 7-second tick slope ("tick"), multi-candle slope
   *  ("candle-decline" | "candle-rise"), or fail-closed data outage ("no-data" —
   *  neither poller ticks nor candles had ≥2 usable points at entry time) */
  gate: "tick" | "candle-decline" | "candle-rise" | "no-data";
  /** Candle-gate: slope % over the lookback window (positive = rising, negative = falling) */
  slopePct?: number;
  /** Effective threshold used by the gate (may be ATR-scaled) */
  effectiveThreshold?: number;
  /** Number of candles / seconds in the lookback */
  lookback?: number;
  /** Tick-gate: price at start of the tick window */
  fromPrice?: number;
  /** Tick-gate: price at end of the tick window */
  toPrice?: number;
}
export const convictionDirectionGuardBlockedMap = new Map<string, ConvictionDirectionBlockInfo>();
export const convictionBoostWindowCoins = new Set<string>();
// Global per-window max-bet token.  Rolled ONCE at window transition; a coin
// claims it by decrementing to 0.  At 100% probability exactly 1 max bet slot
// exists per window; at 25% roughly 1-in-4 windows get a slot.
export const maxBetWindowToken = { remaining: 0 };
// Pre-selected stable coin for the max-bet slot.  Set by the loop BEFORE each
// parallel tick dispatch so the best-scoring stable coin wins deterministically
// rather than whichever async tick fires first.
// Key = windowKey, value = sym of winner (null = no stable candidate found).
export const maxBetCandidateForWindow = new Map<string, string | null>();
export interface CoinStabilityResult {
  stable: boolean;
  er: number;
  osc: number;
  volPct: number;
  mlConf: number | null;
  windowKey: string;
  computedAt: number;
  strikeGapPct: number | null;  // |livePrice − kalshiStrike| / kalshiStrike × 100; null when unavailable
}
export const coinStabilityCache = new Map<string, CoinStabilityResult>();

export interface TrajectoryGateResult {
  symbol: string;
  blocked: boolean;
  reason: "projected_cross" | "gate_inactive" | "insufficient_data" | "adverse_momentum_to_cross" | null;
  velocity: number;                // $/min — positive = rising, negative = falling
  projectedPrice: number;          // estimated underlying price at window close
  currentMarginPct: number;        // (livePrice - target) / target * 100
  projectedMarginPct: number;      // (projectedPrice - target) / target * 100
  minutesRemaining: number;
  direction: "yes" | "no";
  computedAt: number;
  atrPct: number;                  // recent 5-candle ATR as % of target — coin volatility proxy
  effectiveCurrentMarginMinPct: number; // legacy — always 0 in simplified gate
  effectiveDangerBandPct: number;       // legacy — always 0 in simplified gate
  timeWeight: number;              // legacy — always 1 in simplified gate
  adverseVelocity: boolean;        // true when velocity is heading toward (or past) the strike
}
export const coinTrajectoryCache = new Map<string, TrajectoryGateResult>();
export const coinConvictionWinRates = new Map<string, number>();
export const pausedCoins = new Map<string, number>();
export const paperCoinDailyLoss = new Map<string, number>();
export const liveCoinDailyLoss = new Map<string, number>();
export const paperCoinStreakState = new Map<string, CoinStreakEntry>();
export const liveCoinStreakState = new Map<string, CoinStreakEntry>();
export const coinSlippageStrikes = new Map<string, { strikes: number; windowKey: string }>();
export const recentWindowOutcomes = new Map<string, { wins: number; losses: number }>();
export const recentUnanimousOutcomes = new Map<string, { wins: number; losses: number }>();
export const recentDirectionalOutcomes = new Map<string, { yesWins: number; yesLosses: number; noWins: number; noLosses: number }>();
// Tracks when the directional dampener last fired per direction.
// Keyed "yes" or "no" → ISO windowKey string (YYYY-MM-DDTHH:mm).
// Once triggered the penalty persists for directionalRegressionLookback windows
// even through sparse/empty windows, then self-clears.
export const directionalDampenerCooldown = new Map<string, string>();
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
export const WINDOW_ENTRY_BUFFER_S = 60; // fallback used when S.config.windowEntryBufferSeconds is not set
// Max seconds to wait for the window-open Claude trend-stability analysis before
// proceeding without it.  Was 240 — combined with the Claude-pending guard this
// locked the bot out of minutes 0-4 of every window, exactly when trending-window
// prices are still bettable.  Stability normally resolves in 30-90s; after 90s we
// proceed with a neutral (×1.0) multiplier rather than miss the entry window.
export const STABILITY_WAIT_MAX_S = 90;
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
  const today = todayEastern();
  if (today !== S.dailyDate) {
    S.dailyDate = today;
    S.dailyPnl = 0;
    S.dailyLossCount = 0;
    S.dailySpendAmount = 0;
    paperCoinDailyLoss.clear();
    liveCoinDailyLoss.clear();
  }
}

// Per-coin concurrent-tick guard (prevents double-processing same coin in one scheduler tick)
export const tickInFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Tick-time abort reason map (for dashboard skip-reason display)
// ---------------------------------------------------------------------------
// Populated by _runBotTick whenever a conviction gate fires AFTER the Phase-3
// loop has already dispatched the coin.  The loop's WindowCoinEvaluation reason
// only reflects the loop-level gate (e.g. "price in zone — monitoring"); this
// map captures the more-specific tick-time abort that the user actually wants to
// see (e.g. "strike-proximity re-check: gap 0.008% < 0.040%").
//
// Key format: `${sym}:${windowKey}` — one entry per (coin, window).
// The value is replaced on every abort call so the dashboard always shows the
// most recent abort reason.  Cleared on window transition alongside other
// per-window Maps.
export const tickAbortReasons = new Map<string, { reason: string; at: number }>();

// shadowQhBypassActive: set to true for the duration of a quiet-hours bypass tick
// (shadowPaperIgnoreQuietHours=true, bot is live, current hour is silenced).
// When true, new entry ticks MUST treat the entry as paper-only — live orders
// must NOT be placed.  Existing position management (closes, exits) is unaffected
// because closePosition uses pos.entryMode directly (not S.botMode or this flag).
// S.botMode is never modified by the bypass — risk counters stay correct.
export let shadowQhBypassActive = false;
export function setShadowQhBypass(active: boolean): void {
  shadowQhBypassActive = active;
}
