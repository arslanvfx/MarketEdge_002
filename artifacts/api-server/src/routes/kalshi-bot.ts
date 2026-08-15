import { Router } from "express";
import { getAuth } from "@clerk/express";
import { BET_PROFILES, isLiveModePermitted, ML_WEIGHT, CLAUDE_WEIGHT, STAT_BOOST, STAT_PENALTY, clampProximityToCalibratedBand, type BetProfile } from "../lib/kalshi-bot-engine";
import { isKalshiConfigured, getCachedKalshiBalance } from "../lib/kalshi-trader";
import {
  getBotState,
  setBotMode,
  setBotPaused,
  updateBotConfig,
  getBotHistory,
  getBotAllHistory,
  getBotStats,
  getBotTrend,
  getBotGapAnalytics,
  getWindowEvaluation,
  getPerformanceReport,
  getBotAutoTuneLog,
  getPausedCoinState,
  clearBetHistoryOld,
  getBotLogicPerformance,
  getBacktestModes,
  getConvictionThresholdAnalysis,
  getConvictionStabilityAnalysis,
  clearAllPauses,
  getCoinGuardState,
  placeManualOrder,
  closeManualPosition,
  getWindowConditions,
  resetWindowConditions,
  reEvaluateSettledBets,
  runQuietHoursAutoTune,
} from "../lib/kalshi-bot";
import type { BotMode } from "../lib/kalshi-bot";
import type { BotConfig, DecisionMode } from "../lib/kalshi-bot-engine-core";
import { getAllMLStatus } from "../lib/ml-store";
import { getAllPipelineResults, getInFlightDetails } from "../lib/kalshi-bot-pipeline";
import { getLatestCoinSignals } from "../lib/crypto-signals";
import { CRYPTO_COINS, getTrackerWindowCall } from "../lib/crypto";
import { getKalshiCachedData } from "../lib/crypto-kalshi";
import { recentDirectionalOutcomes, directionalDampenerCooldown, activeCoinStreakState, coinStabilityCache, coinTrajectoryCache, extremeCautionAbortedThisWindow, convictionDirectionGuardBlockedMap, type ConvictionDirectionBlockInfo } from "../lib/kalshi-bot-state";
import { db, botConfigTable, kalshiBotBetsTable, botAutoTuneLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ── Decision-mode preset helpers ──────────────────────────────────────────────

const PRESET_ROW_ID = "mode_presets";

// Built-in optimised defaults for each decision mode.
// Applied automatically when switching to a mode with no saved user preset.
// These are the empirically-tuned values that prevent the most common blockers
// (confidence too high, return floor too strict, entry timing conflicts).
export const BUILT_IN_MODE_DEFAULTS: Partial<Record<DecisionMode, Partial<BotConfig>>> = {
  classic: {
    decisionMode: "classic",
    minConfidence: 65,
    minReturnMultiple: 1.3,
    betDelayMinutes: 0,
    maxEntryMinutes: 0,
    minRemainingMinutes: 2,
    windowEntryBufferSeconds: 60,
    requireMonitorReady: true,
    enableDynamicSizing: true,
    betSize: 1,
    maxBetSize: 3,
    maxBetsPerWindow: 6,
    profitLockPct: 95,
    enableMidExit: false,
    regimePenalty: 15,
    enableDirectionCap: true,
    maxSameDirectionBets: 4,
    enableMomentumFilter: true,
    consensusMinCents: 25,
    momentumLookbackCandles: 6,
    phase2ThresholdPp: 30,
    minHoldMinutes: 3,
  },
  // ML Gate: ML leads direction; Claude is a hard co-decider (direction veto).
  // Entry fires immediately once all 3 signals (stat+Claude+ML) confirm direction
  // against the updated Kalshi target — no artificial delay needed.
  // windowEntryBufferSeconds=120 (backend-only, not in UI) is the Kalshi-publish
  // safety buffer that blocks the first-tick blind spot; betDelayMinutes=0 means
  // the pipeline fires the instant the recheck comes back with all signals ready.
  // maxEntryMinutes=8: no new bets after 8 min elapsed (leaves ≥7 min to resolve).
  // minRemainingMinutes=3: hard floor — abort tick when <3 min left in window.
  // minReturnMultiple=1.5: require 1.5× return floor to cover spread + edge.
  ml_gate: {
    decisionMode: "ml_gate",
    minConfidence: 55,
    minReturnMultiple: 1.5,
    betDelayMinutes: 0,
    maxEntryMinutes: 8,
    minRemainingMinutes: 3,
    windowEntryBufferSeconds: 120,
    requireMonitorReady: true,
    enableDynamicSizing: true,
    betSize: 1,
    maxBetSize: 3,
    maxBetsPerWindow: 6,
    profitLockPct: 97,
    enableMidExit: false,
    mlVetoMinConfidence: 65,
    regimePenalty: 12,
    enableDirectionCap: true,
    maxSameDirectionBets: 3,
    enableMomentumFilter: true,
    consensusMinCents: 25,
    momentumLookbackCandles: 6,
    phase2ThresholdPp: 30,
    minHoldMinutes: 3,
  },
  consensus: {
    decisionMode: "consensus",
    minConfidence: 58,
    minReturnMultiple: 1.2,
    betDelayMinutes: 3,
    maxEntryMinutes: 10,
    minRemainingMinutes: 3,
    windowEntryBufferSeconds: 60,
    requireMonitorReady: true,
    enableDynamicSizing: true,
    betSize: 1,
    maxBetSize: 3,
    maxBetsPerWindow: 6,
    profitLockPct: 97,
    enableMidExit: false,
    regimePenalty: 12,
    enableDirectionCap: true,
    maxSameDirectionBets: 3,
    enableMomentumFilter: true,
    consensusMinCents: 25,
    momentumLookbackCandles: 6,
    phase2ThresholdPp: 30,
    minHoldMinutes: 3,
  },
  unanimous: {
    decisionMode: "unanimous",
    minConfidence: 60,
    minReturnMultiple: 1.1,
    betDelayMinutes: 2,
    maxEntryMinutes: 11,
    minRemainingMinutes: 2,
    windowEntryBufferSeconds: 60,
    requireMonitorReady: true,
    enableDynamicSizing: true,
    betSize: 1,
    maxBetSize: 5,
    maxBetsPerWindow: 6,
    profitLockPct: 97,
    enableMidExit: false,
    regimePenalty: 10,
    enableDirectionCap: true,
    maxSameDirectionBets: 3,
    enableMomentumFilter: true,
    consensusMinCents: 25,
    momentumLookbackCandles: 6,
    phase2ThresholdPp: 30,
    minHoldMinutes: 2,
  },
  conviction: {
    decisionMode: "conviction",
    minConfidence: 50,
    minReturnMultiple: 1.00,
    kalshiLockPrice: 0.82,
    kalshiLockPriceCap: 0.91,
    // 0.05 = top of the calibrated band (conviction-zone gaps are naturally
    // 0.01–0.06%). Anything higher recreates the entry-blocking regression the
    // proximity calibration migration fixes — keep in sync with
    // DEFAULT_BOT_CONFIG.strikeProximityMinPct and PROXIMITY_THRESHOLD_SUGGESTIONS.
    strikeProximityMinPct: 0.05,
    strikeProximityAtrScale: true,
    betDelayMinutes: 0,
    maxEntryMinutes: 0,
    minRemainingMinutes: 1,
    allowLateEntries: true,
    windowEntryBufferSeconds: 60,
    requireMonitorReady: false,
    enableDynamicSizing: false,
    betSize: 1,
    maxBetSize: 2,
    maxBetsPerWindow: 2,
    profitLockPct: 97,
    enableMidExit: false,
    disableMidExitForConviction: true,
    regimePenalty: 0,
    enableDirectionCap: false,
    maxSameDirectionBets: 4,
    enableMomentumFilter: false,
    consensusMinCents: 25,
    momentumLookbackCandles: 6,
    phase2ThresholdPp: 30,
    minHoldMinutes: 0,
    convictionDailyLossLimit: 50,
  },
};

async function readModePresets(): Promise<Partial<Record<DecisionMode, Partial<BotConfig>>>> {
  try {
    const rows = await db.select().from(botConfigTable).where(eq(botConfigTable.id, PRESET_ROW_ID)).limit(1);
    if (rows.length > 0) {
      const cfg = rows[0].config as { presets?: Partial<Record<DecisionMode, Partial<BotConfig>>> } | null;
      return cfg?.presets ?? {};
    }
  } catch { /* non-fatal */ }
  return {};
}

async function writeModePreset(mode: DecisionMode, config: Partial<BotConfig>): Promise<void> {
  const existing = await readModePresets();
  const updated = { ...existing, [mode]: config };
  await db
    .insert(botConfigTable)
    .values({ id: PRESET_ROW_ID, config: { presets: updated } as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botConfigTable.id,
      set: { config: { presets: updated } as Record<string, unknown>, updatedAt: new Date() },
    });
}

// ── Opening-call store ────────────────────────────────────────────────────────
// Persists the first complete signal snapshot for each coin in a given window.
// Key: `sym:windowKey`  Value: { direction, decision, claudeConf, composite }
// Cleared automatically when a new window is detected.
//
// Two-phase design:
//   Phase 1 — recorded on first-ready (may use stale s.claudeAbove fallback if
//              getTrackerWindowCall() hasn't returned yet)
//   Phase 2 — direction + claudeConf updated once the tracker's Claude snap
//              arrives, so the opening call matches the predictor page's AT OPEN
//              row (same getTrackerWindowCall source). Decision is kept from
//              Phase 1 to preserve what the bot actually computed at first-ready.
interface OpeningCallRecord {
  direction: "YES" | "NO" | null;
  decision: string;
  claudeConf: number | null;
  composite: number | null;
}
const openingCallStore = new Map<string, OpeningCallRecord>();
// Tracks which opening calls have been updated with the authoritative tracker snap.
const openingCallTrackerFinalized = new Set<string>();
let openingCallWindowKey: string | null = null;

const router = Router();

// Bot admin guard.
// Requires an authenticated Clerk user. If the BOT_ADMIN_CLERK_USER_ID
// environment variable is set (a Clerk user_XXXX ID), only that specific user
// may mutate bot state — preventing any other signed-in user from toggling
// live mode or changing config in a multi-tenant deployment.
// When unset, any authenticated user is allowed (single-user / dev mode).
function requireAuth(req: any, res: any, next: any) {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized — must be signed in to control the bot" });
    return;
  }
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  if (adminId && auth.userId !== adminId) {
    res.status(403).json({ error: "Forbidden — not authorized to control the bot" });
    return;
  }
  next();
}

// GET /crypto/bot/pipeline-status (and alias /bot/pipeline-status) —
// Current per-coin pipeline results for the current window (public — read only)
function pipelineStatusHandler(_req: any, res: any) {
  try {
    const allResults = getAllPipelineResults();
    const inFlightDetails = getInFlightDetails();

    // Determine current window from BOTH completed results and in-flight entries
    // so we correctly identify the window even when all results were pruned and
    // only in-flight entries remain (transition edge case).
    const allWindowKeys = [
      ...allResults.map(r => r.windowKey),
      ...inFlightDetails.map(e => e.windowKey),
    ];
    const currentWindowKey = allWindowKeys.length > 0
      ? allWindowKeys.reduce((best, wk) => (wk > best ? wk : best), allWindowKeys[0])
      : null;

    // Scope both results and in-flight to the current window only
    const results = currentWindowKey
      ? allResults.filter(r => r.windowKey === currentWindowKey)
      : allResults;
    const inFlight = currentWindowKey
      ? inFlightDetails.filter(e => e.windowKey === currentWindowKey)
      : inFlightDetails;

    // Legacy field for any consumers that haven't updated yet
    const inFlightSyms = inFlight.map(e => e.sym);

    // Live unified signals — sourced from the same predictor-layer functions as
    // the Crypto Predictor page so stat/claude/ml always match what the page shows.
    // Always covers ALL tracked coins so the signal board is populated regardless
    // of pipeline completion status.
    const allTrackedSyms = CRYPTO_COINS.map(c => c.symbol);
    const liveSignals = Object.fromEntries(
      allTrackedSyms.map(sym => [sym, getLatestCoinSignals(sym)])
    );
    // Kalshi strike per coin — from the same cache the predictor page uses.
    const kalshiTargets = Object.fromEntries(
      allTrackedSyms.map(sym => [sym, getKalshiCachedData(sym)?.value ?? null])
    );

    // Authoritative current 15-min window boundary (UTC) — always present even
    // when no pipeline results exist yet, so the UI can label which window the
    // data belongs to.
    const nowMs = Date.now();
    const clockWindowKey = new Date(Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000))
      .toISOString()
      .slice(0, 16);

    // ── Bot Steps — live ML Gate decision math per coin ─────────────────────
    // Mirrors computeMLGateDecision exactly (Gate 1 all-three, Claude leads,
    // strict ML veto, composite formula, minConfidence gate) using the same
    // liveSignals the bot's tick loop reads. EV + min-return gates depend on
    // the live yes price and are applied at entry time — flagged as such.
    const botState = getBotState();
    const minConfidence = botState.config.minConfidence;
    const decisionMode = botState.config.decisionMode;

    // ── Pre-compute directional penalties before botSteps map ─────────────────
    // These are system-wide (not per-coin) and included in each botStep's math
    // so the UI can show which direction is penalised this window.
    const _bsDirLookback = botState.config.directionalRegressionLookback ?? 3;
    const _bsDirThreshold = botState.config.directionalRegressionThreshold ?? 0.35;
    const _bsDirPenaltyPp = botState.config.directionalRegressionPenaltyPp ?? 10;
    let _bsYesWins = 0, _bsYesLosses = 0, _bsNoWins = 0, _bsNoLosses = 0;
    for (let _bsi = 1; _bsi <= _bsDirLookback; _bsi++) {
      const _bsMs = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000) - _bsi * 15 * 60_000;
      const _bsWk = new Date(_bsMs).toISOString().slice(0, 16);
      const _bsD = recentDirectionalOutcomes.get(_bsWk);
      if (!_bsD) continue;
      _bsYesWins += _bsD.yesWins; _bsYesLosses += _bsD.yesLosses;
      _bsNoWins  += _bsD.noWins;  _bsNoLosses  += _bsD.noLosses;
    }
    const _bsYesTotal = _bsYesWins + _bsYesLosses;
    const _bsNoTotal  = _bsNoWins  + _bsNoLosses;
    // Mirrors the loop's cooldown check: penalty fires if win rate is below threshold
    // OR if the dampener cooldown is still active (fired within the last N windows).
    const _bsCooldownActive = (dir: string): boolean => {
      const _lastFired = directionalDampenerCooldown.get(dir);
      if (!_lastFired) return false;
      const _windowsAgo = (Date.parse(clockWindowKey) - Date.parse(_lastFired)) / (15 * 60_000);
      return _windowsAgo <= _bsDirLookback;
    };
    const directionalPenaltyYesPp = !botState.config.freeRunMode && (
      (_bsYesTotal >= 2 && _bsYesWins / _bsYesTotal < _bsDirThreshold) || _bsCooldownActive("yes")
    ) ? _bsDirPenaltyPp : 0;
    const directionalPenaltyNoPp  = !botState.config.freeRunMode && (
      (_bsNoTotal  >= 2 && _bsNoWins  / _bsNoTotal  < _bsDirThreshold) || _bsCooldownActive("no")
    ) ? _bsDirPenaltyPp : 0;

    const botSteps = allTrackedSyms.map(sym => {
      const s = liveSignals[sym];
      const strike = kalshiTargets[sym] ?? null;
      const hasStat = s.statAbove !== null;
      const hasClaude = s.claudeAbove !== null;
      const hasMl = s.mlAbove !== null;
      // Readiness mirrors computeMLGateDecision's Gate 1: the three signals only.
      // A missing Kalshi market is a separate terminal SKIP in the engine
      // (!kalshiTicker), represented here as NO_MARKET rather than WAITING.
      const ready = hasStat && hasClaude && hasMl;

      let decision: "WAITING" | "NO_MARKET" | "VETO" | "BET_YES" | "BET_NO" | "BELOW_MIN" = "WAITING";
      let direction: "YES" | "NO" | null = null;
      let vetoReason: string | null = null;
      let math: {
        mlContrib: number;
        claudeContrib: number;
        mlConf: number;
        claudeConf: number;
        statMod: number;
        composite: number;
        statAgrees: boolean;
        directionalPenalty: { yes: number; no: number };
      } | null = null;

      if (strike == null) {
        decision = "NO_MARKET";
      } else if (ready) {
        // Weighted-blend formula — mirrors computeMLGateDecision exactly:
        //   direction  = ML direction
        //   If Claude disagrees → VETO (direction veto, no bet)
        //   composite  = round(mlConf × ML_WEIGHT + claudeConf × CLAUDE_WEIGHT) + statMod
        const claudeDir = s.claudeAbove as boolean;
        const mlDir = s.mlAbove as boolean;
        const statDir = s.statAbove as boolean;
        const mlConf = s.mlConfidence ?? 0;
        const claudeConf = s.claudeConfidence ?? 0;
        direction = mlDir ? "YES" : "NO";

        const claudeAgrees = claudeDir === mlDir;
        const statAgrees = statDir === mlDir;

        if (!claudeAgrees) {
          decision = "VETO";
          vetoReason = `Claude disagrees on direction — direction veto (ML: ${mlDir ? "YES" : "NO"}, Claude: ${claudeDir ? "YES" : "NO"})`;
        } else {
          const mlContrib = Math.round(mlConf * ML_WEIGHT);
          const claudeContrib = Math.round(claudeConf * CLAUDE_WEIGHT);
          const statMod = statAgrees ? STAT_BOOST : -STAT_PENALTY;
          const composite = mlContrib + claudeContrib + statMod;
          math = { mlConf, mlContrib, claudeConf, claudeContrib, statMod, composite, statAgrees, directionalPenalty: { yes: directionalPenaltyYesPp, no: directionalPenaltyNoPp } };
          decision = composite >= minConfidence
            ? (mlDir ? "BET_YES" : "BET_NO")
            : "BELOW_MIN";
        }
      }

      // ── Opening-call tracking ──────────────────────────────────────────────
      // Clear the store when the window rolls over so stale opening calls
      // from the previous window never bleed into the new one.
      if (openingCallWindowKey !== clockWindowKey) {
        openingCallStore.clear();
        openingCallTrackerFinalized.clear();
        openingCallWindowKey = clockWindowKey;
      }
      const ocKey = `${sym}:${clockWindowKey}`;
      const trackerCall = getTrackerWindowCall(sym);

      // Phase 1: record on first-ready. Direction now follows ML (the direction
      // setter in the ML-leads formula) so the "was" indicator in the Direction
      // column matches what the bot actually used.
      if (ready && !openingCallStore.has(ocKey)) {
        const openingDirection: "YES" | "NO" | null =
          s.mlAbove === null ? null : s.mlAbove ? "YES" : "NO";
        openingCallStore.set(ocKey, {
          direction: openingDirection,
          decision,
          claudeConf: trackerCall?.confidence ?? s.claudeConfidence,
          composite: math?.composite ?? null,
        });
        if (trackerCall) openingCallTrackerFinalized.add(ocKey);
      }

      // Phase 2: direction is already ML-based from Phase 1; no update needed
      // for direction. Update claudeConf once the tracker snap arrives so the
      // opening call's confidence display stays accurate.
      if (openingCallStore.has(ocKey) && trackerCall && !openingCallTrackerFinalized.has(ocKey)) {
        const existing = openingCallStore.get(ocKey)!;
        openingCallStore.set(ocKey, {
          ...existing,
          claudeConf: trackerCall.confidence ?? existing.claudeConf,
        });
        openingCallTrackerFinalized.add(ocKey);
      }

      const openingCall = openingCallStore.get(ocKey) ?? null;

      return {
        sym,
        strike,
        stat: { above: s.statAbove, confidence: s.statConfidence },
        claude: { above: s.claudeAbove, confidence: s.claudeConfidence, enabled: s.claudeEnabled },
        ml: { above: s.mlAbove, confidence: s.mlConfidence },
        ready,
        direction,
        decision,
        vetoReason,
        math,
        openingCall,
      };
    });

    // ── Extreme caution abort tracking ───────────────────────────────────────
    // Per-coin: true when a YES entry was aborted this window due to the zone
    // floor check firing (extremeCautionEnabled=true).  Cleared on window
    // transition automatically.
    const extremeCautionAborted = allTrackedSyms.filter(
      sym => extremeCautionAbortedThisWindow.has(`${sym}:${clockWindowKey}`)
    );

    // ── Conviction direction guard live state ─────────────────────────────────
    // Per-coin: block info when the direction guard is ACTIVELY blocking entry.
    // Includes which gate fired ("tick" | "candle-decline" | "candle-rise") and
    // diagnostic details (slopePct, effectiveThreshold, lookback).
    // Deleted when the guard passes, so the dashboard badge clears automatically.
    const convictionDirectionBlocked: Record<string, ConvictionDirectionBlockInfo> = {};
    for (const [sym, info] of convictionDirectionGuardBlockedMap) {
      convictionDirectionBlocked[sym] = info;
    }

    // ── Active time-bet schedule bracket ─────────────────────────────────────
    // The highest-matching bracket for the current elapsed window minutes, if
    // timeBetScheduleEnabled=true and at least one bracket matches.
    const elapsedSecNow = (nowMs - Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000)) / 1000;
    const elapsedMinNow = elapsedSecNow / 60;
    let activeScheduleBracket: { minutesElapsed: number; betAmount: number } | null = null;
    if ((botState.config.timeBetScheduleEnabled ?? false) && (botState.config.timeBetSchedule?.length ?? 0) > 0) {
      const sortedBrackets = [...(botState.config.timeBetSchedule ?? [])].sort((a, b) => b.minutesElapsed - a.minutesElapsed);
      activeScheduleBracket = sortedBrackets.find(b => elapsedMinNow >= b.minutesElapsed) ?? null;
    }

    // ── Adaptive filter state — exposed for pipeline-status UI ───────────────
    // directionalPenaltyYesPp / directionalPenaltyNoPp already computed above
    // (before botSteps map). Per-coin streak penalty for UI display:
    const coinStreakState = activeCoinStreakState();
    const coinStreakPenalties = Object.fromEntries(
      allTrackedSyms.map(sym => {
        const entry = coinStreakState.get(sym);
        const losses = entry?.consecutiveLosses ?? 0;
        const pen1 = botState.config.coinStreakPenalty1LossPp ?? 6;
        const pen2 = botState.config.coinStreakPenalty2PlusLossPp ?? 12;
        const pp = losses >= 2 ? pen2 : losses === 1 ? pen1 : 0;
        return [sym, pp];
      })
    );

    res.json({
      results,
      inFlight,
      inFlightSyms,
      windowKey: currentWindowKey,
      currentWindowKey: clockWindowKey,
      liveSignals,
      kalshiTargets,
      botSteps,
      minConfidence,
      decisionMode,
      coinStability: Object.fromEntries(coinStabilityCache),
      coinTrajectory: Object.fromEntries(coinTrajectoryCache),
      extremeCautionAborted,
      convictionDirectionBlocked,
      activeScheduleBracket,
      boosts: { mlWeight: ML_WEIGHT, claudeWeight: CLAUDE_WEIGHT, statBoost: STAT_BOOST, statPenalty: STAT_PENALTY },
      adaptiveFilters: {
        directionalPenaltyYesPp,
        directionalPenaltyNoPp,
        yesWinRate: _bsYesTotal >= 2 ? _bsYesWins / _bsYesTotal : null,
        noWinRate: _bsNoTotal >= 2 ? _bsNoWins / _bsNoTotal : null,
        yesBets: _bsYesTotal,
        noBets: _bsNoTotal,
        threshold: _bsDirThreshold,
        lookbackWindows: _bsDirLookback,
        freeRunMode: botState.config.freeRunMode ?? false,
        coinStreakPenalties,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
}

router.get("/crypto/bot/pipeline-status", pipelineStatusHandler);
// Alias matching the task spec path
router.get("/bot/pipeline-status", pipelineStatusHandler);

// GET /crypto/bot/coin-guard-state?mode=paper|live — per-coin streak / daily-loss / slippage state (public — read only)
router.get("/crypto/bot/coin-guard-state", (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: BotMode =
      rawMode === "paper" || rawMode === "live" ? rawMode : getBotState().mode;
    res.json(getCoinGuardState(filterMode));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/status — full bot state (public — read only)
router.get("/crypto/bot/status", (_req, res) => {
  try {
    const allML = getAllMLStatus();
    const readyCount = allML.filter(s => s.ready).length;
    const mlStatus = {
      ready: allML.length > 0 && allML.every(s => s.ready),
      readyCount,
      totalCount: allML.length,
      minWindows: allML.length > 0 ? Math.min(...allML.map(s => s.windows)) : 0,
      minRequired: 30,
    };
    res.json({ ...getBotState(), mlStatus, coinStability: Object.fromEntries(coinStabilityCache), coinTrajectory: Object.fromEntries(coinTrajectoryCache) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/mode  { mode: "paper" | "live" }
router.post("/crypto/bot/mode", requireAuth, (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode !== "paper" && mode !== "live") {
    res.status(400).json({ error: "mode must be 'paper' or 'live'" });
    return;
  }
  // Guard live-mode requests in non-production before calling setBotMode so the
  // caller gets a 403 (forbidden here) rather than a generic 400 (bad input).
  if (mode === "live" && !isLiveModePermitted(process.env.NODE_ENV)) {
    res.status(403).json({ error: "Live betting is only available in the production deployment." });
    return;
  }
  try {
    setBotMode(mode as BotMode);
    res.json({ ok: true, ...getBotState() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(400).json({ error: msg });
  }
});

// POST /crypto/bot/pause  { paused: boolean }
router.post("/crypto/bot/pause", requireAuth, (req, res) => {
  const { paused } = req.body as { paused?: boolean };
  if (typeof paused !== "boolean") {
    res.status(400).json({ error: "paused must be a boolean" });
    return;
  }
  setBotPaused(paused);
  res.json({ ok: true, ...getBotState() });
});

// POST /crypto/bot/config  — update one or more config fields
router.post("/crypto/bot/config", requireAuth, async (req, res) => {
  const {
    betSize,
    dailyLossLimit,
    signalThreshold,
    minConfidence,
    decisionMode,
    midExitSensitivity,
    phase2ThresholdPp,
    maxEntryMinutes,
    minRemainingMinutes,
    windowEntryBufferSeconds,
    maxBetsPerWindow,
    enabled,
    quietHoursStart,
    quietHoursEnd,
    quietHoursV2,
    maxConsecutiveLosses,
    circuitBreakerPauseWindows,
    enableDirectionCap,
    maxSameDirectionBets,
    enableMomentumFilter,
    momentumWindowCount,
    enableAutoTuning,
    autoTuneWindowSize,
    enableBorderGuard,
    borderProximityPct,
    borderLookbackBets,
    regimePenalty,
    mlVetoMinConfidence,
    betProfile,
    paperStartingBalance,
    paperWinReturnRate,
    paperBalanceResetAt,
    shadowPaperBets,
    shadowPaperIgnoreQuietHours,
    paperStatsResetAt,
    maxBetSize,
    minAccountBalance,
    maxTotalExposure,
    maxDailyLossPerCoin,
    coinStreakLossLimit,
    coinStreakPauseWindows,
    maxSlippageCents,
    minReturnMultiple,
    requireMonitorReady,
    enableDynamicSizing,
    dynamicSizingMaxConfidence,
    profitLockPct,
    consensusMinCents,
    momentumLookbackCandles,
    coinStreakPenalty1LossPp,
    coinStreakPenalty2PlusLossPp,
    unanimousMinModelConfidence,
    directionalRegressionLookback,
    directionalRegressionThreshold,
    directionalRegressionPenaltyPp,
    betDelayMinutes,
    minNoEntryMinutes,
    priceBufferPct,
    kalshiLockPrice,
    kalshiLockPriceCap,
    strikeProximityMinPct,
    strikeProximityAtrScale,
    strikeProximityMinPctOverrides,
    minWindowEntryMinutes,
    convictionEarlyBypassEnabled,
    convictionEarlyBypassThreshold,
    convictionEarlyBypassCap,
    convictionStopLossFloor,
    convictionStopLossActivationMinute,
    convictionEmergencyCloseFloor,
    convictionDailyLossLimit,
    convictionMinEntryMinutes,
    convictionMaxDailySpend,
    convictionBoostBetSize,
    convictionBoostProbability,
    convictionBoostMinWinRate,
    statRegimeBoostEnabled,
    statRegimeBoostMinER,
    statRegimeBoostMaxOscillations,
    allowLateEntries,
    coinOverrides,
    convictionStabilityEnabled,
    convictionStabilityMinER,
    convictionStabilityMaxOsc,
    convictionStabilityMaxVolPct,
    convictionStabilityMinMLConf,
    convictionStabilityMaxBetProbability,
    convictionStabilityMaxBetsPerWindow,
    maxBetMinWindowEntryMinutes,
    extremeCautionEnabled,
    extremeCautionBetOverride,
    timeBetScheduleEnabled,
    timeBetSchedule,
    betRandomizerEnabled,
    betRandomizerValues,
    disableMidExitForConviction,
    convictionDirectionGuardEnabled,
    convictionDirectionGuardMinSeconds,
    convictionDirectionLookbackCandles,
    convictionCandleSlopeGateEnabled,
    convictionCandleLookback,
    convictionCandleSlopeThresholdPct,
    convictionCandleAtrScaleEnabled,
  } = req.body as {
    betSize?: number;
    dailyLossLimit?: number;
    signalThreshold?: number;
    minConfidence?: number;
    decisionMode?: string;
    midExitSensitivity?: "conservative" | "balanced" | "aggressive";
    phase2ThresholdPp?: number;
    maxEntryMinutes?: number;
    minRemainingMinutes?: number;
    windowEntryBufferSeconds?: number;
    maxBetsPerWindow?: number;
    betDelayMinutes?: number;
    minNoEntryMinutes?: number;
    kalshiLockPrice?: number;
    kalshiLockPriceCap?: number;
    strikeProximityMinPct?: number;
    strikeProximityAtrScale?: boolean;
    strikeProximityMinPctOverrides?: Record<string, number>;
    minWindowEntryMinutes?: number;
    convictionEarlyBypassEnabled?: boolean;
    convictionEarlyBypassThreshold?: number;
    convictionEarlyBypassCap?: number;
    enabled?: boolean;
    quietHoursStart?: number;
    quietHoursEnd?: number;
    quietHoursV2?: { enabled?: boolean; silencedUtcHours?: unknown; reducedBetUtcHours?: unknown; silencedByDow?: unknown; reducedByDow?: unknown; autoTuneEnabled?: boolean; autoTuneDays?: number; autoTuneThreshold?: number; autoTuneIntervalHours?: number };
    maxConsecutiveLosses?: number;
    circuitBreakerPauseWindows?: number;
    enableDirectionCap?: boolean;
    maxSameDirectionBets?: number;
    enableMomentumFilter?: boolean;
    momentumWindowCount?: number;
    enableAutoTuning?: boolean;
    autoTuneWindowSize?: number;
    enableBorderGuard?: boolean;
    borderProximityPct?: number;
    borderLookbackBets?: number;
    regimePenalty?: number;
    mlVetoMinConfidence?: number;
    betProfile?: "normal" | "aggressive";
    paperStartingBalance?: number;
    paperWinReturnRate?: number;
    paperBalanceResetAt?: string | null;
    shadowPaperBets?: boolean;
    shadowPaperIgnoreQuietHours?: boolean;
    paperStatsResetAt?: string | null;
    maxBetSize?: number;
    minAccountBalance?: number;
    maxTotalExposure?: number;
    maxDailyLossPerCoin?: number;
    coinStreakLossLimit?: number;
    coinStreakPauseWindows?: number;
    maxSlippageCents?: number;
    minReturnMultiple?: number;
    requireMonitorReady?: boolean;
    enableDynamicSizing?: boolean;
    dynamicSizingMaxConfidence?: number;
    profitLockPct?: number;
    consensusMinCents?: number;
    momentumLookbackCandles?: number;
    coinStreakPenalty1LossPp?: number;
    coinStreakPenalty2PlusLossPp?: number;
    unanimousMinModelConfidence?: number;
    directionalRegressionLookback?: number;
    directionalRegressionThreshold?: number;
    directionalRegressionPenaltyPp?: number;
    priceBufferPct?: number;
    convictionStopLossFloor?: number;
    convictionStopLossActivationMinute?: number;
    convictionEmergencyCloseFloor?: number;
    convictionDailyLossLimit?: number;
    convictionMinEntryMinutes?: number;
    convictionMaxDailySpend?: number;
    convictionBoostBetSize?: number;
    convictionBoostProbability?: number;
    convictionBoostMinWinRate?: number;
    statRegimeBoostEnabled?: boolean;
    statRegimeBoostMinER?: number;
    statRegimeBoostMaxOscillations?: number;
    allowLateEntries?: boolean;
    coinOverrides?: Record<string, { paused?: boolean; maxBetSize?: number }>;
    convictionStabilityEnabled?: boolean;
    convictionStabilityMinER?: number;
    convictionStabilityMaxOsc?: number;
    convictionStabilityMaxVolPct?: number;
    convictionStabilityMinMLConf?: number;
    convictionStabilityMaxBetProbability?: number;
    convictionStabilityMaxBetsPerWindow?: number;
    maxBetMinWindowEntryMinutes?: number;
    extremeCautionEnabled?: boolean;
    extremeCautionBetOverride?: number | null;
    timeBetScheduleEnabled?: boolean;
    timeBetSchedule?: Array<{ minutesElapsed: number; betAmount: number }>;
    betRandomizerEnabled?: boolean;
    betRandomizerValues?: number[];
    disableMidExitForConviction?: boolean;
    convictionDirectionGuardEnabled?: boolean;
    convictionDirectionGuardMinSeconds?: number;
    convictionDirectionLookbackCandles?: number;
    convictionCandleSlopeGateEnabled?: boolean;
    convictionCandleLookback?: number;
    convictionCandleSlopeThresholdPct?: number;
    convictionCandleAtrScaleEnabled?: boolean;
  };

  const partial: Parameters<typeof updateBotConfig>[0] = {};
  if (typeof betSize === "number" && betSize >= 0.5 && betSize <= 500) partial.betSize = betSize;
  if (typeof dailyLossLimit === "number" && dailyLossLimit > 0) partial.dailyLossLimit = dailyLossLimit;
  if (typeof signalThreshold === "number" && [2, 3, 4].includes(signalThreshold)) {
    partial.signalThreshold = signalThreshold;
  }
  if (typeof minConfidence === "number" && minConfidence >= 40 && minConfidence <= 100) {
    partial.minConfidence = minConfidence;
  }
  if (decisionMode === "classic" || decisionMode === "ml_gate" || decisionMode === "consensus" || decisionMode === "unanimous" || decisionMode === "conviction") {
    // When switching modes: apply built-in mode defaults as a baseline, then
    // layer the saved user preset on top (if one exists), then apply any
    // explicit overrides from this request on top of that.
    // Priority (highest wins): request body > saved preset > built-in defaults.
    const builtIn = BUILT_IN_MODE_DEFAULTS[decisionMode as DecisionMode];
    if (builtIn) Object.assign(partial, builtIn);

    const presets = await readModePresets();
    const modePreset = presets[decisionMode as DecisionMode];
    if (modePreset) {
      Object.assign(partial, modePreset);
    }
    partial.decisionMode = decisionMode;

    // Saved presets (and historically, built-in defaults) can carry drifted
    // pre-calibration proximity values (e.g. the old 0.30 global). The startup
    // migration is one-shot and already marked complete, so a mode switch is
    // the ONLY path that could silently re-introduce the entry-blocking
    // regression — clamp the merged baseline back into the calibrated band.
    // Deliberate user edits via the proximity fields below are applied AFTER
    // this clamp (request body wins), so they are unaffected.
    if (decisionMode === "conviction") {
      const clamp = clampProximityToCalibratedBand(partial);
      if (clamp.clampedGlobal || clamp.clampedCoins.length > 0) {
        logger.info(
          {
            clampedGlobal: clamp.clampedGlobal,
            clampedCoins: clamp.clampedCoins,
            strikeProximityMinPct: partial.strikeProximityMinPct,
            strikeProximityMinPctOverrides: partial.strikeProximityMinPctOverrides,
          },
          "[kalshi-bot] mode switch: preset/default proximity thresholds above calibrated band — clamped",
        );
      }
    }
  }
  if (
    midExitSensitivity === "conservative" ||
    midExitSensitivity === "balanced" ||
    midExitSensitivity === "aggressive"
  ) {
    partial.midExitSensitivity = midExitSensitivity;
  }
  if (typeof phase2ThresholdPp === "number" && phase2ThresholdPp >= 10 && phase2ThresholdPp <= 50) {
    partial.phase2ThresholdPp = phase2ThresholdPp;
  }
  if (typeof disableMidExitForConviction === "boolean") {
    partial.disableMidExitForConviction = disableMidExitForConviction;
  }
  if (typeof maxEntryMinutes === "number" && maxEntryMinutes >= 0 && maxEntryMinutes <= 13) {
    partial.maxEntryMinutes = maxEntryMinutes;
  }
  if (typeof minRemainingMinutes === "number" && minRemainingMinutes >= 0 && minRemainingMinutes <= 7) {
    partial.minRemainingMinutes = minRemainingMinutes;
  }
  if (typeof windowEntryBufferSeconds === "number" && windowEntryBufferSeconds >= 0 && windowEntryBufferSeconds <= 300) {
    partial.windowEntryBufferSeconds = windowEntryBufferSeconds;
  }
  if (typeof maxBetsPerWindow === "number" && maxBetsPerWindow >= 1 && maxBetsPerWindow <= 10) {
    partial.maxBetsPerWindow = maxBetsPerWindow;
  }
  if (typeof enabled === "boolean") partial.enabled = enabled;
  if (typeof quietHoursStart === "number" && quietHoursStart >= 0 && quietHoursStart <= 23) {
    partial.quietHoursStart = quietHoursStart;
  }
  if (typeof quietHoursEnd === "number" && quietHoursEnd >= 0 && quietHoursEnd <= 23) {
    partial.quietHoursEnd = quietHoursEnd;
  }
  if (quietHoursV2 !== undefined && typeof quietHoursV2 === "object" && quietHoursV2 !== null) {
    const v2 = quietHoursV2 as { enabled?: unknown; silencedUtcHours?: unknown; reducedBetUtcHours?: unknown; silencedByDow?: unknown; reducedByDow?: unknown; autoTuneEnabled?: unknown; autoTuneDays?: unknown; autoTuneThreshold?: unknown; autoTuneIntervalHours?: unknown };

    // Helper: parse a Record<string, number[]> where keys are dow strings "0"–"6"
    function parseSilencedByDow(raw: unknown): Record<string, number[]> | undefined {
      if (typeof raw !== "object" || raw === null) return undefined;
      const out: Record<string, number[]> = {};
      for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
        const dow = parseInt(k, 10);
        if (isNaN(dow) || dow < 0 || dow > 6) continue;
        if (!Array.isArray(val)) continue;
        out[String(dow)] = (val as unknown[]).filter((h): h is number => typeof h === "number" && h >= 0 && h <= 23);
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    // Helper: parse a Record<string, Record<string, number>> where outer keys are dow strings "0"–"6"
    function parseReducedByDow(raw: unknown): Record<string, Record<string, number>> | undefined {
      if (typeof raw !== "object" || raw === null) return undefined;
      const out: Record<string, Record<string, number>> = {};
      for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
        const dow = parseInt(k, 10);
        if (isNaN(dow) || dow < 0 || dow > 6) continue;
        if (typeof val !== "object" || val === null) continue;
        const inner: Record<string, number> = {};
        for (const [hk, hv] of Object.entries(val as Record<string, unknown>)) {
          const h = parseInt(hk, 10);
          if (isNaN(h) || h < 0 || h > 23) continue;
          if (typeof hv !== "number" || hv < 1 || hv > 99) continue;
          inner[String(h)] = hv;
        }
        if (Object.keys(inner).length > 0) out[String(dow)] = inner;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }

    partial.quietHoursV2 = {
      enabled: typeof v2.enabled === "boolean" ? v2.enabled : false,
      silencedUtcHours: Array.isArray(v2.silencedUtcHours)
        ? (v2.silencedUtcHours as unknown[]).filter((h): h is number => typeof h === "number" && h >= 0 && h <= 23)
        : [],
      reducedBetUtcHours: (typeof v2.reducedBetUtcHours === "object" && v2.reducedBetUtcHours !== null)
        ? Object.fromEntries(
            Object.entries(v2.reducedBetUtcHours as Record<string, unknown>)
              .filter(([k, v]) => {
                const h = parseInt(k, 10);
                return !isNaN(h) && h >= 0 && h <= 23 && typeof v === "number" && v >= 10 && v <= 99;
              })
              .map(([k, v]) => [k, v as number])
          )
        : {},
      ...(parseSilencedByDow(v2.silencedByDow) != null ? { silencedByDow: parseSilencedByDow(v2.silencedByDow) } : {}),
      ...(parseReducedByDow(v2.reducedByDow) != null ? { reducedByDow: parseReducedByDow(v2.reducedByDow) } : {}),
      ...(typeof v2.autoTuneEnabled === "boolean" ? { autoTuneEnabled: v2.autoTuneEnabled } : {}),
      ...(typeof v2.autoTuneDays === "number" && v2.autoTuneDays >= 1 && v2.autoTuneDays <= 90 ? { autoTuneDays: v2.autoTuneDays } : {}),
      ...(typeof v2.autoTuneThreshold === "number" && v2.autoTuneThreshold >= 50 && v2.autoTuneThreshold <= 100 ? { autoTuneThreshold: v2.autoTuneThreshold } : {}),
      ...(typeof v2.autoTuneIntervalHours === "number" && [1,2,4,6,12].includes(v2.autoTuneIntervalHours) ? { autoTuneIntervalHours: v2.autoTuneIntervalHours } : {}),
    };
  }
  if (typeof maxConsecutiveLosses === "number" && maxConsecutiveLosses >= 0 && maxConsecutiveLosses <= 10) {
    partial.maxConsecutiveLosses = maxConsecutiveLosses;
  }
  if (typeof circuitBreakerPauseWindows === "number" && circuitBreakerPauseWindows >= 0 && circuitBreakerPauseWindows <= 20) {
    partial.circuitBreakerPauseWindows = circuitBreakerPauseWindows;
  }
  if (typeof enableDirectionCap === "boolean") partial.enableDirectionCap = enableDirectionCap;
  if (typeof maxSameDirectionBets === "number" && maxSameDirectionBets >= 1 && maxSameDirectionBets <= 10) {
    partial.maxSameDirectionBets = maxSameDirectionBets;
  }
  if (typeof enableMomentumFilter === "boolean") partial.enableMomentumFilter = enableMomentumFilter;
  if (typeof momentumWindowCount === "number" && momentumWindowCount >= 2 && momentumWindowCount <= 8) {
    partial.momentumWindowCount = momentumWindowCount;
  }
  if (typeof enableAutoTuning === "boolean") partial.enableAutoTuning = enableAutoTuning;
  if (typeof autoTuneWindowSize === "number" && autoTuneWindowSize >= 20 && autoTuneWindowSize <= 500) {
    partial.autoTuneWindowSize = autoTuneWindowSize;
  }
  if (typeof enableBorderGuard === "boolean") partial.enableBorderGuard = enableBorderGuard;
  if (typeof borderProximityPct === "number" && borderProximityPct >= 0.05 && borderProximityPct <= 2.0) {
    partial.borderProximityPct = borderProximityPct;
  }
  if (typeof borderLookbackBets === "number" && borderLookbackBets >= 1 && borderLookbackBets <= 10) {
    partial.borderLookbackBets = borderLookbackBets;
  }
  if (typeof regimePenalty === "number" && regimePenalty >= 0 && regimePenalty <= 20) {
    partial.regimePenalty = regimePenalty;
  }
  if (typeof mlVetoMinConfidence === "number" && mlVetoMinConfidence >= 50 && mlVetoMinConfidence <= 70) {
    partial.mlVetoMinConfidence = mlVetoMinConfidence;
  }
  if (betProfile === "normal" || betProfile === "aggressive") {
    partial.betProfile = betProfile;
    // Auto-sync regimePenalty to the profile's preset unless the caller also
    // explicitly provided a regimePenalty override in the same request.
    if (typeof regimePenalty !== "number") {
      partial.regimePenalty = BET_PROFILES[betProfile].regimePenalty;
    }
  }
  if (typeof paperStartingBalance === "number" && paperStartingBalance >= 1 && paperStartingBalance <= 10000) {
    partial.paperStartingBalance = paperStartingBalance;
  }
  if (typeof paperWinReturnRate === "number" && paperWinReturnRate >= 0.1 && paperWinReturnRate <= 2.0) {
    partial.paperWinReturnRate = paperWinReturnRate;
  }
  if (typeof shadowPaperBets === "boolean") partial.shadowPaperBets = shadowPaperBets;
  if (typeof shadowPaperIgnoreQuietHours === "boolean") partial.shadowPaperIgnoreQuietHours = shadowPaperIgnoreQuietHours;
  if ("paperBalanceResetAt" in req.body) {
    partial.paperBalanceResetAt = typeof paperBalanceResetAt === "string" ? paperBalanceResetAt : null;
  }
  if ("paperStatsResetAt" in req.body) {
    partial.paperStatsResetAt = typeof paperStatsResetAt === "string" ? paperStatsResetAt : null;
  }
  // Live-mode safety guards
  if (typeof maxBetSize === "number" && maxBetSize >= 0.5 && maxBetSize <= 500) partial.maxBetSize = maxBetSize;
  if (typeof minAccountBalance === "number" && minAccountBalance >= 0 && minAccountBalance <= 1000) partial.minAccountBalance = minAccountBalance;
  if (typeof maxTotalExposure === "number" && maxTotalExposure >= 0 && maxTotalExposure <= 500) partial.maxTotalExposure = maxTotalExposure;
  if (typeof maxDailyLossPerCoin === "number" && maxDailyLossPerCoin >= 0 && maxDailyLossPerCoin <= 100) partial.maxDailyLossPerCoin = maxDailyLossPerCoin;
  if (typeof coinStreakLossLimit === "number" && coinStreakLossLimit >= 0 && coinStreakLossLimit <= 10) partial.coinStreakLossLimit = coinStreakLossLimit;
  if (typeof coinStreakPauseWindows === "number" && coinStreakPauseWindows >= 1 && coinStreakPauseWindows <= 10) partial.coinStreakPauseWindows = coinStreakPauseWindows;
  if (typeof maxSlippageCents === "number" && maxSlippageCents >= 0 && maxSlippageCents <= 50) partial.maxSlippageCents = maxSlippageCents;
  if (typeof minReturnMultiple === "number" && minReturnMultiple >= 1 && minReturnMultiple <= 10) partial.minReturnMultiple = minReturnMultiple;
  if (typeof requireMonitorReady === "boolean") partial.requireMonitorReady = requireMonitorReady;
  // Confidence-based dynamic bet sizing
  if (typeof enableDynamicSizing === "boolean") partial.enableDynamicSizing = enableDynamicSizing;
  if (typeof dynamicSizingMaxConfidence === "number" && dynamicSizingMaxConfidence >= 50 && dynamicSizingMaxConfidence <= 100) {
    partial.dynamicSizingMaxConfidence = dynamicSizingMaxConfidence;
  }
  if (typeof profitLockPct === "number" && profitLockPct >= 0 && profitLockPct <= 99) {
    partial.profitLockPct = profitLockPct;
  }
  // Entry safety gate thresholds
  if (typeof consensusMinCents === "number" && consensusMinCents >= 0 && consensusMinCents <= 50) {
    partial.consensusMinCents = consensusMinCents;
  }
  if (typeof momentumLookbackCandles === "number" && momentumLookbackCandles >= 4 && momentumLookbackCandles <= 12) {
    partial.momentumLookbackCandles = momentumLookbackCandles;
  }
  // Loss-learning adaptive filter config
  if (typeof coinStreakPenalty1LossPp === "number" && coinStreakPenalty1LossPp >= 0 && coinStreakPenalty1LossPp <= 30) {
    partial.coinStreakPenalty1LossPp = coinStreakPenalty1LossPp;
  }
  if (typeof coinStreakPenalty2PlusLossPp === "number" && coinStreakPenalty2PlusLossPp >= 0 && coinStreakPenalty2PlusLossPp <= 30) {
    partial.coinStreakPenalty2PlusLossPp = coinStreakPenalty2PlusLossPp;
  }
  if (typeof unanimousMinModelConfidence === "number" && unanimousMinModelConfidence >= 0 && unanimousMinModelConfidence <= 70) {
    partial.unanimousMinModelConfidence = unanimousMinModelConfidence;
  }
  if (typeof directionalRegressionLookback === "number" && directionalRegressionLookback >= 1 && directionalRegressionLookback <= 10) {
    partial.directionalRegressionLookback = directionalRegressionLookback;
  }
  if (typeof directionalRegressionThreshold === "number" && directionalRegressionThreshold >= 0 && directionalRegressionThreshold <= 1) {
    partial.directionalRegressionThreshold = directionalRegressionThreshold;
  }
  if (typeof directionalRegressionPenaltyPp === "number" && directionalRegressionPenaltyPp >= 0 && directionalRegressionPenaltyPp <= 30) {
    partial.directionalRegressionPenaltyPp = directionalRegressionPenaltyPp;
  }
  if (typeof betDelayMinutes === "number" && betDelayMinutes >= 0 && betDelayMinutes <= 13) {
    partial.betDelayMinutes = betDelayMinutes;
  }
  if (typeof minNoEntryMinutes === "number" && minNoEntryMinutes >= 0 && minNoEntryMinutes <= 13) {
    partial.minNoEntryMinutes = minNoEntryMinutes;
  }
  if (typeof priceBufferPct === "number" && priceBufferPct >= 0 && priceBufferPct <= 5) {
    partial.priceBufferPct = priceBufferPct;
  }
  if (typeof kalshiLockPrice === "number" && kalshiLockPrice >= 0.50 && kalshiLockPrice <= 0.99) {
    partial.kalshiLockPrice = kalshiLockPrice;
  }
  if (typeof kalshiLockPriceCap === "number" && kalshiLockPriceCap >= 0.51 && kalshiLockPriceCap <= 0.97) {
    partial.kalshiLockPriceCap = kalshiLockPriceCap;
  }
  if (typeof strikeProximityMinPct === "number" && strikeProximityMinPct >= 0.01 && strikeProximityMinPct <= 2.00) {
    partial.strikeProximityMinPct = strikeProximityMinPct;
  }
  if (typeof strikeProximityAtrScale === "boolean") {
    partial.strikeProximityAtrScale = strikeProximityAtrScale;
  }
  if (strikeProximityMinPctOverrides != null && typeof strikeProximityMinPctOverrides === "object") {
    const cleaned: Record<string, number> = {};
    for (const [sym, val] of Object.entries(strikeProximityMinPctOverrides)) {
      if (typeof val === "number" && val >= 0.01 && val <= 3.00) {
        cleaned[sym.toUpperCase()] = val;
      }
    }
    partial.strikeProximityMinPctOverrides = cleaned;
  }
  // 0 = disabled; valid range 0–0.85
  if (typeof convictionStopLossFloor === "number" && convictionStopLossFloor >= 0 && convictionStopLossFloor <= 0.85) {
    partial.convictionStopLossFloor = convictionStopLossFloor;
  }
  // 0 = arm immediately; 1–13 = arm after N minutes (last 15-N minutes of window)
  if (typeof convictionStopLossActivationMinute === "number" && convictionStopLossActivationMinute >= 0 && convictionStopLossActivationMinute <= 13) {
    partial.convictionStopLossActivationMinute = convictionStopLossActivationMinute;
  }
  // 0.50–0.90: fills above this are kept (stop-loss monitors them); fills below → immediate close
  if (typeof convictionEmergencyCloseFloor === "number" && convictionEmergencyCloseFloor >= 0.50 && convictionEmergencyCloseFloor <= 0.90) {
    partial.convictionEmergencyCloseFloor = convictionEmergencyCloseFloor;
  }
  if (typeof convictionDailyLossLimit === "number" && convictionDailyLossLimit > 0) {
    partial.convictionDailyLossLimit = convictionDailyLossLimit;
  }
  // 0 = no minimum (fire as soon as price enters zone); 1–12 = wait N minutes after window open
  if (typeof convictionMinEntryMinutes === "number" && convictionMinEntryMinutes >= 0 && convictionMinEntryMinutes <= 12) {
    partial.convictionMinEntryMinutes = Math.round(convictionMinEntryMinutes);
  }
  if (typeof convictionMaxDailySpend === "number" && convictionMaxDailySpend >= 0) {
    partial.convictionMaxDailySpend = convictionMaxDailySpend > 0 ? convictionMaxDailySpend : undefined;
  }
  // 0 = disabled; > 0 enables boost for that dollar amount
  if (typeof convictionBoostBetSize === "number" && convictionBoostBetSize >= 0) {
    partial.convictionBoostBetSize = convictionBoostBetSize > 0 ? convictionBoostBetSize : undefined;
  }
  if (typeof convictionBoostProbability === "number" && convictionBoostProbability >= 0.05 && convictionBoostProbability <= 1.0) {
    partial.convictionBoostProbability = convictionBoostProbability;
  }
  if (typeof convictionBoostMinWinRate === "number" && convictionBoostMinWinRate >= 0.50 && convictionBoostMinWinRate <= 0.90) {
    partial.convictionBoostMinWinRate = convictionBoostMinWinRate;
  }
  if (typeof statRegimeBoostEnabled === "boolean") {
    partial.statRegimeBoostEnabled = statRegimeBoostEnabled;
  }
  if (typeof statRegimeBoostMinER === "number" && statRegimeBoostMinER >= 0.10 && statRegimeBoostMinER <= 0.80) {
    partial.statRegimeBoostMinER = statRegimeBoostMinER;
  }
  if (typeof statRegimeBoostMaxOscillations === "number" && statRegimeBoostMaxOscillations >= 1 && statRegimeBoostMaxOscillations <= 14) {
    partial.statRegimeBoostMaxOscillations = Math.round(statRegimeBoostMaxOscillations);
  }
  if (typeof convictionStabilityEnabled === "boolean") partial.convictionStabilityEnabled = convictionStabilityEnabled;
  if (typeof convictionStabilityMinER === "number" && convictionStabilityMinER >= 0.02 && convictionStabilityMinER <= 0.80) {
    partial.convictionStabilityMinER = convictionStabilityMinER;
  }
  if (typeof convictionStabilityMaxOsc === "number" && convictionStabilityMaxOsc >= 1 && convictionStabilityMaxOsc <= 14) {
    partial.convictionStabilityMaxOsc = Math.round(convictionStabilityMaxOsc);
  }
  if (typeof convictionStabilityMaxVolPct === "number" && convictionStabilityMaxVolPct >= 0.01 && convictionStabilityMaxVolPct <= 5.0) {
    partial.convictionStabilityMaxVolPct = convictionStabilityMaxVolPct;
  }
  if (typeof convictionStabilityMinMLConf === "number" && convictionStabilityMinMLConf >= 50 && convictionStabilityMinMLConf <= 80) {
    partial.convictionStabilityMinMLConf = Math.round(convictionStabilityMinMLConf);
  }
  if (typeof convictionStabilityMaxBetProbability === "number" && convictionStabilityMaxBetProbability >= 0 && convictionStabilityMaxBetProbability <= 1) {
    partial.convictionStabilityMaxBetProbability = convictionStabilityMaxBetProbability;
  }
  if (typeof convictionStabilityMaxBetsPerWindow === "number") {
    partial.convictionStabilityMaxBetsPerWindow = Math.min(3, Math.max(1, Math.round(convictionStabilityMaxBetsPerWindow)));
  }
  if (typeof maxBetMinWindowEntryMinutes === "number" && maxBetMinWindowEntryMinutes >= 0 && maxBetMinWindowEntryMinutes <= 13) {
    partial.maxBetMinWindowEntryMinutes = Math.round(maxBetMinWindowEntryMinutes);
  }
  if (typeof allowLateEntries === "boolean") {
    partial.allowLateEntries = allowLateEntries;
  }
  if (coinOverrides !== undefined && coinOverrides !== null && typeof coinOverrides === "object" && !Array.isArray(coinOverrides)) {
    const validated: Record<string, { paused?: boolean; maxBetSize?: number }> = {};
    for (const [sym, ov] of Object.entries(coinOverrides)) {
      if (!ov || typeof ov !== "object") continue;
      const entry: { paused?: boolean; maxBetSize?: number } = {};
      if (typeof ov.paused === "boolean") entry.paused = ov.paused;
      if (typeof ov.maxBetSize === "number" && ov.maxBetSize >= 0.5) entry.maxBetSize = ov.maxBetSize;
      validated[sym.toUpperCase()] = entry;
    }
    partial.coinOverrides = validated;
  }
  // preConvictionThreshold must be < kalshiLockPrice (or the current config lock price
  // if not being changed simultaneously) to form a valid pre-entry band.
  const effectiveLockPrice = typeof kalshiLockPrice === "number" ? kalshiLockPrice : (getBotState().config.kalshiLockPrice ?? 0.82);
  if (typeof preConvictionThreshold === "number" && preConvictionThreshold >= 0.50 && preConvictionThreshold < effectiveLockPrice) {
    partial.preConvictionThreshold = preConvictionThreshold;
  }
  if (typeof useRestingLimitOrders === "boolean") {
    partial.useRestingLimitOrders = useRestingLimitOrders;
  }
  // 0 = disabled (arm at any time); 1–14 = arm only when ≤ N minutes remain
  if (typeof convictionRestingWindowMinutes === "number" && convictionRestingWindowMinutes >= 0 && convictionRestingWindowMinutes <= 14) {
    partial.convictionRestingWindowMinutes = convictionRestingWindowMinutes;
  }
  // 0 = disabled; 1–13 = block new bets in the first N minutes
  if (typeof minWindowEntryMinutes === "number" && minWindowEntryMinutes >= 0 && minWindowEntryMinutes <= 13) {
    partial.minWindowEntryMinutes = minWindowEntryMinutes;
  }
  if (typeof convictionEarlyBypassEnabled === "boolean") {
    partial.convictionEarlyBypassEnabled = convictionEarlyBypassEnabled;
  }
  if (typeof convictionEarlyBypassThreshold === "number" && convictionEarlyBypassThreshold >= 0.70 && convictionEarlyBypassThreshold <= 0.95) {
    partial.convictionEarlyBypassThreshold = +convictionEarlyBypassThreshold.toFixed(2);
  }
  if (typeof convictionEarlyBypassCap === "number" && convictionEarlyBypassCap >= 0.80 && convictionEarlyBypassCap <= 0.99) {
    partial.convictionEarlyBypassCap = +convictionEarlyBypassCap.toFixed(2);
  }
  // Extreme Caution mode
  if (typeof extremeCautionEnabled === "boolean") partial.extremeCautionEnabled = extremeCautionEnabled;
  if (extremeCautionBetOverride === null || extremeCautionBetOverride === undefined) {
    if ("extremeCautionBetOverride" in req.body) partial.extremeCautionBetOverride = null;
  } else if (typeof extremeCautionBetOverride === "number" && extremeCautionBetOverride >= 0 && extremeCautionBetOverride <= 500) {
    partial.extremeCautionBetOverride = extremeCautionBetOverride > 0 ? +extremeCautionBetOverride.toFixed(2) : null;
  }
  // Time-Based Bet Schedule
  if (typeof timeBetScheduleEnabled === "boolean") partial.timeBetScheduleEnabled = timeBetScheduleEnabled;
  if (Array.isArray(timeBetSchedule)) {
    const validatedSchedule: Array<{ minutesElapsed: number; betAmount: number }> = [];
    for (const entry of timeBetSchedule) {
      if (
        entry && typeof entry === "object" &&
        typeof entry.minutesElapsed === "number" && entry.minutesElapsed >= 0 && entry.minutesElapsed <= 14 &&
        typeof entry.betAmount === "number" && entry.betAmount >= 0.5 && entry.betAmount <= 500
      ) {
        validatedSchedule.push({
          minutesElapsed: Math.round(entry.minutesElapsed * 10) / 10,
          betAmount: +entry.betAmount.toFixed(2),
        });
      }
    }
    partial.timeBetSchedule = validatedSchedule;
  }
  // Bet Amount Randomizer
  if (typeof betRandomizerEnabled === "boolean") partial.betRandomizerEnabled = betRandomizerEnabled;
  if (Array.isArray(betRandomizerValues)) {
    const validatedValues: number[] = [];
    for (const v of betRandomizerValues) {
      if (typeof v === "number" && v >= 0.5 && v <= 500 && Number.isFinite(v)) {
        validatedValues.push(+v.toFixed(2));
      }
    }
    partial.betRandomizerValues = validatedValues;
  }
  if (typeof convictionDirectionGuardEnabled === "boolean") {
    partial.convictionDirectionGuardEnabled = convictionDirectionGuardEnabled;
  }
  if (typeof convictionDirectionGuardMinSeconds === "number" && convictionDirectionGuardMinSeconds >= 2 && convictionDirectionGuardMinSeconds <= 10) {
    partial.convictionDirectionGuardMinSeconds = Math.round(convictionDirectionGuardMinSeconds);
  }
  if (typeof convictionDirectionLookbackCandles === "number" && convictionDirectionLookbackCandles >= 1 && convictionDirectionLookbackCandles <= 10) {
    partial.convictionDirectionLookbackCandles = Math.round(convictionDirectionLookbackCandles);
  }
  if (typeof convictionCandleSlopeGateEnabled === "boolean") {
    partial.convictionCandleSlopeGateEnabled = convictionCandleSlopeGateEnabled;
  }
  if (typeof convictionCandleLookback === "number" && convictionCandleLookback >= 2 && convictionCandleLookback <= 10) {
    partial.convictionCandleSlopeLookback = Math.round(convictionCandleLookback);
  }
  if (typeof convictionCandleSlopeThresholdPct === "number" && convictionCandleSlopeThresholdPct >= 0.01 && convictionCandleSlopeThresholdPct <= 0.20) {
    partial.convictionCandleSlopeThresholdPct = +convictionCandleSlopeThresholdPct.toFixed(3);
  }
  if (typeof convictionCandleAtrScaleEnabled === "boolean") {
    partial.convictionCandleAtrScaleEnabled = convictionCandleAtrScaleEnabled;
  }

  const { config: updated, persisted } = await updateBotConfig(partial);
  res.json({ ok: true, config: updated, persisted });
});

// GET /crypto/bot/kalshi-preflight — pre-switch balance verification (auth required)
// Called by the pre-live checklist BEFORE the user switches to live mode.
// No mode guard — checks Kalshi API reachability and account balance regardless
// of current bot mode so the checklist can show a real green/red state.
router.get("/crypto/bot/kalshi-preflight", requireAuth, async (_req, res) => {
  try {
    const configured = isKalshiConfigured();
    if (!configured) {
      res.json({ configured: false, balance: null, ok: false });
      return;
    }
    const balance = await getCachedKalshiBalance();
    res.json({ configured: true, balance, ok: true });
  } catch {
    res.json({ configured: true, balance: null, ok: false });
  }
});

// GET /crypto/bot/kalshi-balance — live Kalshi account balance
// Returns ok:false unless the bot is in live mode and Kalshi is configured.
// Used by the live balance header badge (mode-guarded per spec).
router.get("/crypto/bot/kalshi-balance", async (_req, res) => {
  try {
    const { mode } = getBotState();
    if (mode !== "live") {
      res.json({ balance: null, ok: false, reason: "not_live" });
      return;
    }
    if (!isKalshiConfigured()) {
      res.json({ balance: null, ok: false, reason: "not_configured" });
      return;
    }
    const balance = await getCachedKalshiBalance();
    res.json({ balance, ok: true });
  } catch {
    res.json({ balance: null, ok: false, reason: "api_error" });
  }
});

// GET /crypto/bot/history?limit=20&mode=paper|live (public — read only, terminal outcomes only)
router.get("/crypto/bot/history", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const rawMode = req.query.mode;
  const filterMode: BotMode =
    rawMode === "paper" || rawMode === "live" ? rawMode : getBotState().mode;
  const cfg = getBotState().config;
  const resetAt = filterMode === "live" ? (cfg.liveStatsResetAt ?? null) : filterMode === "paper" ? (cfg.paperStatsResetAt ?? null) : null;
  try {
    const history = await getBotHistory(limit, filterMode, resetAt);
    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/all-history?limit=100&offset=0&mode=paper|live (public — all records for dashboard)
router.get("/crypto/bot/all-history", async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const cfg2 = getBotState().config;
  const resetAt = mode === "live" ? (cfg2.liveStatsResetAt ?? null) : mode === "paper" ? (cfg2.paperStatsResetAt ?? null) : null;
  try {
    const history = await getBotAllHistory(limit, offset, mode, resetAt);
    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/stats?symbol=BTC&mode=paper|live (public — read only)
router.get("/crypto/bot/stats", async (req, res) => {
  const symbol = typeof req.query.symbol === "string" && req.query.symbol.trim()
    ? req.query.symbol.trim()
    : undefined;
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const cfg3 = getBotState().config;
  const resetAt = mode === "live" ? (cfg3.liveStatsResetAt ?? null) : mode === "paper" ? (cfg3.paperStatsResetAt ?? null) : null;
  try {
    const stats = await getBotStats(symbol, mode, resetAt);
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/trend?limit=50&mode=paper|live — chronological win/loss sequence with rolling win rate
router.get("/crypto/bot/trend", async (req, res) => {
  const limit = Math.min(100, Math.max(2, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const cfg4 = getBotState().config;
  const resetAt = mode === "live" ? (cfg4.liveStatsResetAt ?? null) : mode === "paper" ? (cfg4.paperStatsResetAt ?? null) : null;
  try {
    const points = await getBotTrend(limit, mode, resetAt);
    res.json(points);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/gap-analytics?mode=paper|live
// Returns win/loss breakdown by strike-proximity gap band (and per coin)
router.get("/crypto/bot/gap-analytics", async (req, res) => {
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const cfg = getBotState().config;
  const resetAt = mode === "live" ? (cfg.liveStatsResetAt ?? null) : mode === "paper" ? (cfg.paperStatsResetAt ?? null) : null;
  try {
    const data = await getBotGapAnalytics(mode, resetAt);
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/window-eval (public — last market evaluation results)
// Response: { evaluation, signals }
//   evaluation — bot decision per coin (action/confidence/reason) from last Phase-3 run
//   signals    — current unified predictor signals per coin (stat/claude/ml/wm),
//                derived from getLatestCoinSignals so they always match the Crypto
//                Predictor page — no pipelineResults divergence.
router.get("/crypto/bot/window-eval", (_req, res) => {
  try {
    const evaluation = getWindowEvaluation();
    // Build unified signal map for each coin that appeared in the last evaluation.
    // getLatestCoinSignals reads from the same sources as the predictor page, so
    // the bot dashboard and predictor page always display identical values.
    const signals: Record<string, ReturnType<typeof getLatestCoinSignals>> = {};
    for (const row of evaluation) {
      try {
        signals[row.symbol] = getLatestCoinSignals(row.symbol);
      } catch {
        // non-fatal — skip signal enrichment for this coin
      }
    }
    res.json({ evaluation, signals });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/performance-report?mode=paper|live — latest cached analytics report (public)
router.get("/crypto/bot/performance-report", (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: BotMode =
      rawMode === "paper" || rawMode === "live" ? rawMode : getBotState().mode;
    const report = getPerformanceReport(filterMode);
    res.json({ report, pausedCoins: getPausedCoinState() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/quiet-hours-auto-tune/run — force-run auto-tune immediately (bypasses interval guard)
router.post("/crypto/bot/quiet-hours-auto-tune/run", requireAuth, async (_req, res) => {
  try {
    await runQuietHoursAutoTune({ force: true });
    const S = getBotState();
    res.json({
      ok: true,
      lastRunAt:     S.autoTuneQHLastRunAt     ?? null,
      lastChanges:   S.autoTuneQHLastChanges   ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/auto-tune-log?limit=20 — recent auto-tune mutations (public)
router.get("/crypto/bot/auto-tune-log", async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  try {
    const entries = await getBotAutoTuneLog(limit);
    res.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/logic-performance — per-decision-mode win/loss/accuracy stats (public)
router.get("/crypto/bot/logic-performance", async (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: "paper" | "live" | undefined =
      rawMode === "paper" || rawMode === "live" ? rawMode : undefined;
    const cfgL = getBotState().config;
    const resetAt = filterMode === "live" ? (cfgL.liveStatsResetAt ?? null) : filterMode === "paper" ? (cfgL.paperStatsResetAt ?? null) : null;
    const modes = await getBotLogicPerformance(filterMode, resetAt);
    res.json({ modes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/backtest-modes — replay settled bets through each mode's logic (public)
router.get("/crypto/bot/backtest-modes", async (_req, res) => {
  try {
    const modes = await getBacktestModes();
    res.json({ modes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/conviction-threshold-analysis?mode=paper|live
// GET /crypto/bot/quiet-hours-analysis?days=14&targetWinRate=85&dow=all|weekday|weekend|0-6
// Groups live bets from the last N days by UTC hour (optionally filtered by day-of-week)
// and returns win-rate, P&L stats, and suggested hours to silence.
// ?dow param:
//   omitted | "all"     → aggregate across all days (existing behaviour, ≥5 bets)
//   "weekday"           → aggregate Mon–Fri (dow 1–5)
//   "weekend"           → aggregate Sat–Sun (dow 0,6)
//   "0"–"6"             → specific JS-style day (0=Sun … 6=Sat), ≥3 bets guard
// Response always includes hourStatsByDow (keyed "0"–"6") so the UI can
// pre-populate every tab without a separate request per day.
router.get("/crypto/bot/quiet-hours-analysis", requireAuth, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "14"), 10) || 14));
    const targetWinRate = Math.min(100, Math.max(0, parseFloat(String(req.query.targetWinRate ?? "85")) || 85));
    const dowRaw = String(req.query.dow ?? "all").trim().toLowerCase();

    // Determine DOW filter clause and minimum bets threshold
    // EXTRACT(DOW …) returns 0=Sun … 6=Sat (same as JS getUTCDay())
    let dowFilter: string | null = null;  // raw SQL fragment; null = no filter
    let minBetsForSuggest = 5;            // aggregate view uses 5; per-day uses 3

    // DOW uses America/New_York so evening bets placed between 8 PM and
    // midnight ET land on the correct calendar day — not the next UTC day.
    // Example: a bet at 9:54 PM EDT Wednesday = 1:54 AM UTC Thursday would
    // otherwise be bucketed under Thursday and invisible on the Wednesday tab.
    if (dowRaw === "weekday") {
      dowFilter = "EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') BETWEEN 1 AND 5";
      minBetsForSuggest = 3;
    } else if (dowRaw === "weekend") {
      dowFilter = "EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') IN (0, 6)";
      minBetsForSuggest = 3;
    } else if (/^[0-6]$/.test(dowRaw)) {
      dowFilter = `EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') = ${parseInt(dowRaw, 10)}`;
      minBetsForSuggest = 3;
    }
    // else: "all" or anything unrecognised → no filter, keep minBets=5

    // ── Primary query: aggregate for the requested DOW filter ────────────────
    const primaryResult = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS utc_hour,
        COUNT(*) AS total_bets,
        COUNT(CASE WHEN outcome = 'win' THEN 1 END) AS wins,
        COUNT(CASE WHEN outcome = 'loss' THEN 1 END) AS losses,
        ROUND(SUM(pnl::numeric), 2) AS total_pnl,
        ROUND(AVG(pnl::numeric), 4) AS avg_pnl
      FROM kalshi_bot_bets
      WHERE created_at >= NOW() - (${days} || ' days')::INTERVAL
        AND outcome IN ('win', 'loss')
        AND archived_at IS NULL
        ${dowFilter ? sql.raw(`AND ${dowFilter}`) : sql.raw("")}
      GROUP BY utc_hour
      ORDER BY utc_hour
    `);

    function buildHourStats(rows: Record<string, unknown>[]) {
      return Array.from({ length: 24 }, (_, h) => {
        const row = rows.find((r) => Number(r.utc_hour) === h);
        if (!row) return { utcHour: h, totalBets: 0, wins: 0, losses: 0, winRatePct: null as number | null, totalPnl: 0, avgPnl: 0 };
        const wins = Number(row.wins);
        const losses = Number(row.losses);
        const total = wins + losses;
        return {
          utcHour: h,
          totalBets: Number(row.total_bets),
          wins,
          losses,
          winRatePct: total > 0 ? Math.round(wins / total * 1000) / 10 : null as number | null,
          totalPnl: Number(row.total_pnl ?? 0),
          avgPnl: Number(row.avg_pnl ?? 0),
        };
      });
    }

    const hourStats = buildHourStats(primaryResult.rows as Record<string, unknown>[]);

    const suggestedSilencedHours = hourStats
      .filter(h => h.winRatePct !== null && h.winRatePct < targetWinRate && h.totalBets >= minBetsForSuggest)
      .map(h => h.utcHour);

    // ── Per-DOW breakdown (always computed, keyed "0"–"6") ───────────────────
    // DOW uses America/New_York so evening bets after 8 PM ET appear on the
    // correct calendar day. Hour stays as UTC — the frontend converts to ET
    // via utcToEst(). Both paper and live bets (including shadow paper bets)
    // are included with no mode filter.
    const dowResult = await db.execute(sql`
      SELECT
        EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York')::int AS et_dow,
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int             AS utc_hour,
        COUNT(*) AS total_bets,
        COUNT(CASE WHEN outcome = 'win' THEN 1 END) AS wins,
        COUNT(CASE WHEN outcome = 'loss' THEN 1 END) AS losses,
        ROUND(SUM(pnl::numeric), 2) AS total_pnl,
        ROUND(AVG(pnl::numeric), 4) AS avg_pnl
      FROM kalshi_bot_bets
      WHERE created_at >= NOW() - (${days} || ' days')::INTERVAL
        AND outcome IN ('win', 'loss')
        AND archived_at IS NULL
      GROUP BY et_dow, utc_hour
      ORDER BY et_dow, utc_hour
    `);

    const hourStatsByDow: Record<string, ReturnType<typeof buildHourStats>> = {};
    for (let d = 0; d <= 6; d++) {
      const dayRows = (dowResult.rows as Record<string, unknown>[]).filter(r => Number(r.et_dow) === d);
      hourStatsByDow[String(d)] = buildHourStats(dayRows);
    }

    res.json({ hourStats, suggestedSilencedHours, days, targetWinRate, dow: dowRaw, hourStatsByDow });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// Returns win-rate breakdown of conviction-mode bets by entry YES price band,
// plus an auto-suggested optimal lock price (best win-rate band with ≥5 bets, all-time).
router.get("/crypto/bot/conviction-threshold-analysis", async (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: "paper" | "live" | undefined =
      rawMode === "paper" || rawMode === "live" ? rawMode : undefined;
    const result = await getConvictionThresholdAnalysis(filterMode);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/conviction-stability-analysis?mode=paper|live
// Correlates each conviction bet's market-regime indicators (ER, oscillations,
// volatility %, ML confidence) at entry against win/loss outcome to identify
// the threshold values that maximise stable-vs-volatile win rate separation.
// Stability metrics are captured in the signals JSONB since Task #393.
// Returns per-dimension threshold scans and suggested optimal defaults.
router.get("/crypto/bot/conviction-stability-analysis", async (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: "paper" | "live" | undefined =
      rawMode === "paper" || rawMode === "live" ? rawMode : undefined;
    const result = await getConvictionStabilityAnalysis(filterMode);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/manual-order — place a single order immediately from the dashboard
// Accepts { symbol, direction: "yes"|"no", betSize?, mode? }
// Uses the same live-ask fill logic as the automated bot (Task #242).
router.post("/crypto/bot/manual-order", requireAuth, async (req, res) => {
  const { symbol, direction, betSize, mode } = req.body as {
    symbol?: string;
    direction?: string;
    betSize?: number;
    mode?: string;
  };

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  if (direction !== "yes" && direction !== "no") {
    res.status(400).json({ error: "direction must be 'yes' or 'no'" });
    return;
  }
  if (betSize !== undefined && (typeof betSize !== "number" || betSize <= 0)) {
    res.status(400).json({ error: "betSize must be a positive number" });
    return;
  }
  const resolvedMode = mode === "paper" || mode === "live" ? mode : undefined;
  // Live manual orders are only permitted in production
  if (resolvedMode === "live" && !isLiveModePermitted(process.env.NODE_ENV)) {
    res.status(403).json({ error: "Live orders are only available in the production deployment." });
    return;
  }

  try {
    const result = await placeManualOrder({
      symbol,
      direction,
      betSize,
      mode: resolvedMode,
    });
    // Invalidate any internal caches that the next status poll depends on
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    // 400 for business-rule rejections (open position, insufficient funds, etc.)
    res.status(400).json({ error: msg });
  }
});

// POST /crypto/bot/close-manual-position — close a manually-placed position early.
// Only works on positions with source="manual"; bot-opened positions must be
// managed by the automated engine.
router.post("/crypto/bot/close-manual-position", requireAuth, async (req, res) => {
  const { symbol } = req.body as { symbol?: string };
  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const result = await closeManualPosition(symbol);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(400).json({ error: msg });
  }
});

// POST /crypto/bot/clear-pauses — immediately clear all per-coin auto-tune pauses
// and reset the circuit-breaker countdown. Safe to call at any time; does not
// affect mode, positions, or config.
router.post("/crypto/bot/clear-pauses", requireAuth, async (_req, res) => {
  try {
    const result = clearAllPauses();
    // Write a synthetic per_coin_pause log entry so the cooldown guard in
    // runAutoTuneRules prevents the auto-tune job from immediately re-pausing
    // the same coin on the next window tick (consecutive losses are still in DB).
    // Without this, clearing the in-memory pausedCoins map has no lasting effect.
    await db.insert(botAutoTuneLogTable).values({
      ruleName: "per_coin_pause",
      oldValue: result.clearedCoins.join(",") || "none",
      newValue: "user_cleared",
      triggerReason: "Manual clear-pauses action — cooldown guard applied for 1 hour",
      createdAt: new Date(),
    }).catch(() => {}); // non-fatal: cooldown skipped if write fails
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/conditions — current snapshot of every active restriction and
// condition in the bot: global gates, direction caps, per-coin window blocks,
// and static coin filters. Refreshed on every request (no caching).
router.get("/crypto/bot/conditions", (_req, res) => {
  try {
    res.json(getWindowConditions());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/free-run  { enabled: boolean }
// Toggle free-run mode: when true, all restriction/penalty layers are bypassed
// (proximity gate, oscillation filter, quiet hours, doubt penalties, direction
// cap, chop filter, per-coin pauses, price-band gates, near-strike filter).
// Safety rails that are NEVER bypassed: circuit breaker, daily loss limit,
// max bets per window, and the ML-Claude alignment gate.
router.post("/crypto/bot/free-run", requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const { S } = await import("../lib/kalshi-bot-state");
    const { updateBotConfig } = await import("../lib/kalshi-bot-db");
    S.config = { ...S.config, freeRunMode: enabled };
    await updateBotConfig({ freeRunMode: enabled });
    return res.json({ ok: true, freeRunMode: enabled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/reset-conditions — nuclear reset: clears all window-level
// restrictions (empty-book cooldowns, direction counts), auto-tune pauses,
// coin streak pauses, the circuit-breaker countdown, directional coin blocks
// (COIN_YES_BLOCKED / COIN_FULLY_BLOCKED), and resets restriction-related
// config fields (regimePenalty → 0) so the bot runs with clean settings
// exactly matching the current defaults. Safe to call at any time; does not
// affect mode, daily P&L, open positions, or trade history.
router.post("/crypto/bot/reset-conditions", requireAuth, async (_req, res) => {
  try {
    const result = resetWindowConditions();

    // Reset restriction-related config fields to their clean defaults and
    // persist to DB so the settings survive a restart. Only touches fields
    // that represent active restrictions — leaves betSize, dailyLossLimit,
    // and all other user-configured values untouched.
    await updateBotConfig({
      regimePenalty: 0,
    });

    // Same cooldown guard as clear-pauses: write a synthetic per_coin_pause
    // log entry so the auto-tune job cannot immediately re-pause any coin
    // that was just unblocked by this full reset.
    await db.insert(botAutoTuneLogTable).values({
      ruleName: "per_coin_pause",
      oldValue: result.cleared.join(",") || "none",
      newValue: "user_reset",
      triggerReason: "Manual reset-conditions action — cooldown guard applied for 1 hour",
      createdAt: new Date(),
    }).catch(() => {}); // non-fatal

    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/config/presets — return all saved per-mode presets (public)
router.get("/crypto/bot/config/presets", async (_req, res) => {
  try {
    const presets = await readModePresets();
    res.json({ presets });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/config/mode-defaults — return built-in optimised defaults
// for every decision mode.  Used by the frontend to pre-fill the config form
// when the user selects a mode so they see the recommended settings immediately
// without having to save first.  Always returns 200 (static data, no DB access).
router.get("/crypto/bot/config/mode-defaults", (_req, res) => {
  res.json({ defaults: BUILT_IN_MODE_DEFAULTS });
});

// POST /crypto/bot/config/save-preset — save current bot config as preset for
// the current decision mode. Call this after dialling in optimal settings for
// a mode so they auto-apply next time the mode is selected.
router.post("/crypto/bot/config/save-preset", requireAuth, async (_req, res) => {
  try {
    const state = getBotState();
    const mode = state.config.decisionMode;
    await writeModePreset(mode, state.config as unknown as Partial<BotConfig>);
    res.json({ ok: true, saved: mode, preset: state.config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// DELETE /crypto/bot/bets/old — admin maintenance endpoint.
// Deletes kalshi_bot_bets records older than `hours` hours (1–24, default 2)
// and reloads in-memory daily P&L so the running bot reflects the clean slate.
// prediction_records (learning data) are NEVER touched.
// Accepts either Clerk admin auth OR X-Clear-Password header so it can be
// invoked from the frontend (Clerk session) or via curl (password).
router.delete("/crypto/bot/bets/old", async (req, res) => {
  const clerkAuth = getAuth(req);
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  const hasClerkAuth = clerkAuth?.userId && (!adminId || clerkAuth.userId === adminId);

  const clearPassword = process.env["CLEAR_LOGS_PASSWORD"];
  const hasClearPassword = clearPassword && req.headers["x-clear-password"] === clearPassword;

  if (!hasClerkAuth && !hasClearPassword) {
    res.status(401).json({ error: "Unauthorized — sign in as admin or supply X-Clear-Password" });
    return;
  }
  const hoursRaw = req.query.hours;
  const hours = Math.min(24, Math.max(1, parseInt(String(hoursRaw ?? "2"), 10) || 2));
  try {
    const result = await clearBetHistoryOld(hours);
    res.json({ ok: true, deleted: result.deleted, hours });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/re-evaluate-bets — re-check all historical expired bets
// against Kalshi's authoritative settlement result (RTI) and correct any that
// were mis-evaluated using Coinbase candle prices.
// Accepts Clerk admin auth OR X-Clear-Password header.
router.post("/crypto/bot/re-evaluate-bets", async (req, res) => {
  const clerkAuth = getAuth(req);
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  const hasClerkAuth = clerkAuth?.userId && (!adminId || clerkAuth.userId === adminId);
  const clearPassword = process.env["CLEAR_LOGS_PASSWORD"];
  const hasClearPassword = clearPassword && req.headers["x-clear-password"] === clearPassword;
  if (!hasClerkAuth && !hasClearPassword) {
    res.status(401).json({ error: "Unauthorized — sign in as admin or supply X-Clear-Password" });
    return;
  }
  try {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
    const limit = !isNaN(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : undefined;
    const result = await reEvaluateSettledBets({ since, limit });
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/time-analytics — permanent per-coin win/loss by day + hour
// Queries ALL historical bets with no rolling window, paper+live combined.
// This data never gets erased (bets table is the permanent store) and survives
// any server restart or republish.
router.get("/crypto/bot/time-analytics", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        symbol,
        EXTRACT(DOW  FROM created_at AT TIME ZONE 'UTC')::int  AS dow,
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int  AS hour,
        COUNT(*) FILTER (WHERE outcome = 'win')::int  AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses,
        COUNT(*)::int                                          AS total
      FROM ${kalshiBotBetsTable}
      WHERE
        action    IN ('exit', 'late_recovery_exit', 'expired')
        AND outcome IN ('win', 'loss')
        AND (source IS NULL OR source != 'manual')
      GROUP BY symbol, dow, hour
      ORDER BY symbol, dow, hour
    `);

    const data = (rows.rows ?? rows).map((r: Record<string, unknown>) => ({
      symbol:  String(r.symbol  ?? ""),
      dow:     Number(r.dow     ?? 0),
      hour:    Number(r.hour    ?? 0),
      wins:    Number(r.wins    ?? 0),
      losses:  Number(r.losses  ?? 0),
      total:   Number(r.total   ?? 0),
    }));

    const totalBets = data.reduce((s: number, r: { total: number }) => s + r.total, 0);
    res.json({ rows: data, totalBets, lastUpdated: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/reset-live-stats — set liveStatsResetAt to NOW() so all
// visual stats (win/loss %, profit, history, performance report, logic-mode
// performance) start fresh from this moment.  Zero rows are deleted; the
// underlying data is fully preserved for ML training, auto-tune learning, and
// time analytics (best days / hours).  Also wipes all in-memory guard state:
// coin streaks, pauses, circuit-breaker, penalty maps, and direction blocks.
router.post("/crypto/bot/reset-live-stats", requireAuth, async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const { config } = await updateBotConfig({ liveStatsResetAt: now, paperStatsResetAt: now });
    const resetResult = resetWindowConditions();
    res.json({ ok: true, liveStatsResetAt: config.liveStatsResetAt, paperStatsResetAt: config.paperStatsResetAt, guardReset: resetResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
