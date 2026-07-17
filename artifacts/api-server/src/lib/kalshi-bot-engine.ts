// Kalshi bot decision engine.
//
// Reads all available prediction signals for the current window and returns a
// BET_YES / BET_NO / SKIP decision with full reasoning logged.
//
// Signal sources — ALL model signals come from getLatestCoinSignals
// (crypto-signals.ts), the predictor's shared signal module.  The Crypto
// Predictor tool is the ONLY place stat/Claude/ML are computed; this engine
// never assembles its own signals:
//     1. Stat model  — predCache forward prediction vs Kalshi strike
//     2. Claude AI   — tracker opening call + live re-check override
//     3. ML model    — online logistic regression (predictor snapshot features)
//     4. Window BetSignal (getWindowBetSignal) — pre-window regime + intra-window momentum
//        (confidence booster only — not a model signal)
//
// Core-pair gate: at least one of Stat/Claude must be non-null, and all
// non-null core signals must agree. ML and WM can never block an entry —
// they only raise or leave unchanged the base confidence of 65%.

import {
  getWindowBetSignal,
  type WindowBetSignal,
} from "./crypto";
import { getLatestCoinSignals } from "./crypto-signals";
import { getKalshiCachedData } from "./crypto-kalshi";

import {
  computeCorePairDecision,
  computeMLGateDecision,
  computeConvictionDecision,
  ML_WEIGHT,
  CLAUDE_WEIGHT,
  ML_BOOST,
  STAT_BOOST,
  STAT_PENALTY,
  checkMinReturnGate,
  checkFastAgreementEntry,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
  STAT_AGREE_BOOST,
  ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY,
  STAT_REQUIRED_MIN_CONF,
  CLAUDE_REQUIRED_MIN_CONF,
  ML_REQUIRED_MIN_CONF,
  ML_OVERRIDE_MIN_CONF,
  BET_PROFILES,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  checkMomentumOverride,
  deriveRegime,
  isLiveModePermitted,
  assertSetBotModeAllowed,
  resolveStartupMode,
  applyStartupModeRestore,
  applyLockPrice090Migration,
  applyLockPrice093Bootstrap,
  applyLockPrice092Bootstrap,
  deriveConvictionZone,
  DEFAULT_BOT_CONFIG,
  computeDynamicBetSize,
  computeKellyMultiplier,
  buildStreakSnapshot,
  restoreStreakState,
  type BetProfile,
  type BetProfileConfig,
  type DecisionMode,
  type BotConfig,
  type BotDecisionAction,
  type CorePairInputs,
  type CorePairResult,
  type ConvictionInputs,
  type CircuitBreakerState,
  type PriceRegime,
  type CoinStreakEntry,
} from "./kalshi-bot-engine-core";

// Re-export constants and types so callers only import from this file.
export {
  computeCorePairDecision,
  computeConvictionDecision,
  computeMLGateDecision,
  ML_WEIGHT,
  CLAUDE_WEIGHT,
  ML_BOOST,
  STAT_BOOST,
  STAT_PENALTY,
  checkMinReturnGate,
  checkFastAgreementEntry,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
  STAT_AGREE_BOOST,
  ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY,
  STAT_REQUIRED_MIN_CONF,
  CLAUDE_REQUIRED_MIN_CONF,
  ML_REQUIRED_MIN_CONF,
  ML_OVERRIDE_MIN_CONF,
  BET_PROFILES,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  checkMomentumOverride,
  deriveRegime,
  // Live-mode env guards — pure functions, also exported here so callers
  // (e.g. routes/kalshi-bot.ts) only import from this file.
  isLiveModePermitted,
  assertSetBotModeAllowed,
  resolveStartupMode,
  applyStartupModeRestore,
  // One-time conviction lock-price migration (pure, DB-free, unit-testable).
  applyLockPrice090Migration,
  applyLockPrice093Bootstrap,
  applyLockPrice092Bootstrap,
  // Conviction zone derivation — single source of truth for [floor, cap].
  deriveConvictionZone,
  // BotConfig types and defaults live in the zero-dependency core module so
  // they can be imported by unit tests without pulling in ./crypto.
  DEFAULT_BOT_CONFIG,
  // Confidence-based dynamic bet sizing helpers — re-exported so kalshi-bot.ts
  // and unit tests import them from this barrel like every other engine export.
  computeDynamicBetSize,
  computeKellyMultiplier,
  // Streak-state pure helpers — extracted so kalshi-bot.ts can delegate and
  // unit tests can verify expiry logic without touching the DB.
  buildStreakSnapshot,
  restoreStreakState,
  type BetProfile,
  type BetProfileConfig,
  type DecisionMode,
  type BotConfig,
  type BotDecisionAction,
  type CorePairInputs,
  type CorePairResult,
  type ConvictionInputs,
  type CircuitBreakerState,
  type PriceRegime,
  type CoinStreakEntry,
};

export interface SignalSnapshot {
  statAbove: boolean | null;
  claudeAbove: boolean | null;
  mlAbove: boolean | null;
  windowMonitor: "bet" | "stay_away" | "caution" | null;
  windowMonitorReady: boolean;
  yesPrice: number | null;
  ev: number | null;
  signalAccuracyPct: number | null;
  minutesElapsed: number;
  signalsAgreeing: number;
  signalsTotal: number;
  agreementTarget: BotDecisionAction | null;
  statConfidence: number | null;
  claudeConfidence: number | null;
  mlConfidence: number | null;
  warmupActive: boolean;
  roiPct: number | null;       // net return % on the chosen side; null when yesPrice unknown
}

export interface BotDecision {
  action: BotDecisionAction;
  confidence: number;
  reasoning: string;
  signals: SignalSnapshot;
}

// ---------------------------------------------------------------------------
// ROI gate — skip when the payout on our chosen side is below the minimum
// ---------------------------------------------------------------------------

// Minimum net return required to place a bet.  Set to 1.4 % as a loose ~1.5 %
// floor — values like 1.45 % and 1.48 % are acceptable; hard-losing plays
// (< 1.4 %) are skipped.  A YES bet needs yesPrice ≤ 0.9862; a NO bet needs
// yesPrice ≥ 0.0138.  Gate is bypassed when yesPrice is unknown.
// NOTE: yesPrice is in 0-1 dollar format (e.g. 0.52 for 52¢), not cents.
const MIN_ROI_PCT = 1.4;

function calcROI(action: BotDecisionAction, yesPrice: number): number {
  // yesPrice is in 0-1 dollar format — e.g. 0.52 means the YES contract costs 52¢.
  // YES payout = (1 - yesPrice) / yesPrice × 100%
  // NO  payout = yesPrice / (1 - yesPrice) × 100%
  return action === "BET_YES"
    ? ((1 - yesPrice) / yesPrice) * 100
    : (yesPrice / (1 - yesPrice)) * 100;
}

// ---------------------------------------------------------------------------
// Public decision engine — gathers live signals then calls the pure core
// ---------------------------------------------------------------------------

function _makeBotDecisionInner(
  symbol: string,
  config: BotConfig,
  kalshiTicker: string | null,
  yesPrice: number | null,
  minutesElapsed: number,
  signalAccuracyPct: number | null,
  kalshiTarget?: number | null,
  livePrice?: number | null,
): BotDecision {
  const sym = symbol.toUpperCase();

  // ── All three model signals — read from the predictor's shared signal
  // module.  getLatestCoinSignals is the SINGLE source of truth for
  // stat/Claude/ML directions + confidence: the Crypto Predictor tool is the
  // only place those signals are computed, and the pipeline + tick gates read
  // the exact same snapshot.  The engine must never assemble its own signals
  // (no historyStore stat reads, no liveDirectionCache merging, no ML feature
  // extraction here) — that guarantees the direction the gate checked is the
  // direction the decision uses.
  const live = getLatestCoinSignals(sym);
  const statAbove = live.statAbove;
  const liveStatConf = live.statConfidence;
  const claudeAbove = live.claudeAbove;
  const claudeConfidence = live.claudeConfidence;
  const mlAbove = live.mlAbove;
  const mlConfidence = live.mlConfidence;
  const wmRec = live.wmRecommendation;
  const wmReady = live.wmReady;

  // Window-monitor factors (net drift direction) are a confidence-boost input
  // only — not one of the three model signals — so the raw WM signal object
  // is still read here for its factors field.
  const wmSignal: WindowBetSignal | null = getWindowBetSignal(sym);

  // Pipeline gate: ALL three models must have a direction before any bet fires.
  // Claude's extended-thinking call takes 30-120s after the window opens.
  // We always wait — no fast-agreement bypass — the new pipeline requires
  // Stat + Claude + ML to all complete before any entry decision is made.
  //
  // EXCEPTION — conviction mode: computeConvictionDecision uses only yesPrice /
  // yesAsk / yesBid and never consults Stat, Claude, or ML.  Null signals must
  // be treated as "no opinion" (not a blocker) or the engine can never fire —
  // this is exactly what killed 6-coin windows where stat/ML cached data expired
  // mid-window.  Bypass ALL three null-checks for conviction.
  {
    const convictionMode = config.decisionMode === "conviction";
    const claudeMissing  = !convictionMode && claudeAbove === null;
    const statMlMissing  = !convictionMode && (statAbove === null || mlAbove === null);
    if (statMlMissing || claudeMissing) {
      const missing = (
        [statMlMissing && statAbove === null && "Stat", claudeMissing && "Claude", statMlMissing && mlAbove === null && "ML"] as Array<string | false>
      ).filter(Boolean).join("+");
      const pendingSnapshot: SignalSnapshot = {
        statAbove, claudeAbove, mlAbove,
        windowMonitor: wmRec, windowMonitorReady: wmReady,
        yesPrice, ev: null, signalAccuracyPct, minutesElapsed,
        signalsAgreeing: 0, signalsTotal: 0, agreementTarget: null,
        statConfidence: liveStatConf,
        claudeConfidence, mlConfidence,
        warmupActive: true,
        roiPct: null,
      };
      return {
        action: "SKIP",
        confidence: 0,
        reasoning: `Pipeline: waiting for ${missing} (${minutesElapsed.toFixed(1)} min elapsed) — all three models (Stat, Claude, ML) must complete before betting`,
        signals: pendingSnapshot,
      };
    }
  }

  const wmFactors = wmSignal?.factors;
  const wmDriftAbove: boolean | null =
    wmReady && wmRec === "bet" && wmFactors != null ? wmFactors.netDriftPct > 0 : null;

  // Helper to build a signal snapshot (roiPct filled in by the outer wrapper)
  const buildSnapshot = (ev: number | null, signalsAgreeing = 0, signalsTotal = 0, agreementTarget: BotDecisionAction | null = null): SignalSnapshot => ({
    statAbove, claudeAbove, mlAbove,
    windowMonitor: wmRec, windowMonitorReady: wmReady,
    yesPrice, ev, signalAccuracyPct, minutesElapsed,
    signalsAgreeing, signalsTotal, agreementTarget,
    statConfidence: liveStatConf,
    claudeConfidence,
    mlConfidence,
    warmupActive: false,
    roiPct: null,
  });

  const decisionMode: DecisionMode = config.decisionMode ?? "classic";
  const profile = BET_PROFILES[config.betProfile ?? "normal"];

  // ── Decision Mode: consensus ──────────────────────────────────────────────
  // Require at least 2 out of [Stat, Claude, ML] to agree on the same direction.
  // Fall back to classic when fewer than 2 signals are available (ML not yet
  // trained) so the mode is never strictly worse than classic during warm-up.
  if (decisionMode === "consensus") {
    const votes: Array<{ above: boolean; conf: number }> = [];
    if (statAbove !== null)  votes.push({ above: statAbove,  conf: liveStatConf ?? 55 });
    if (claudeAbove !== null) votes.push({ above: claudeAbove, conf: claudeConfidence ?? 55 });
    if (mlAbove !== null && mlConfidence != null) votes.push({ above: mlAbove, conf: mlConfidence });

    if (votes.length < 2) {
      // Not enough signals to form a meaningful consensus — fall through to classic
      // so the bot can still operate while ML is warming up.
    } else {
      const yesVotes = votes.filter(v => v.above);
      const noVotes  = votes.filter(v => !v.above);
      const majorityDir: boolean | null =
        yesVotes.length > noVotes.length ? true :
        noVotes.length  > yesVotes.length ? false : null;
      const majorityCount = majorityDir === null ? 0 : Math.max(yesVotes.length, noVotes.length);

      if (majorityDir === null || majorityCount < 2) {
        return {
          action: "SKIP",
          confidence: 0,
          reasoning: `consensus: no 2/${votes.length} majority (yes=${yesVotes.length} no=${noVotes.length} total=${votes.length}) — skipping`,
          signals: buildSnapshot(null),
        };
      }

      const agreeingVotes = majorityDir ? yesVotes : noVotes;
      const avgConf = agreeingVotes.reduce((s, v) => s + v.conf, 0) / agreeingVotes.length;
      const confidence = Math.round(Math.max(avgConf, BASE_CONFIDENCE_HALF_PAIR));
      const action: BotDecisionAction = majorityDir ? "BET_YES" : "BET_NO";

      if (confidence < config.minConfidence) {
        return {
          action: "SKIP",
          confidence,
          reasoning: `consensus: confidence ${confidence}% below minimum ${config.minConfidence}%`,
          signals: buildSnapshot(null, agreeingVotes.length, votes.length),
        };
      }

      const consensusReturnGate = checkMinReturnGate(action, yesPrice, config.minReturnMultiple);
      if (consensusReturnGate.blocked) {
        return {
          action: "SKIP",
          confidence,
          reasoning: `consensus: ${consensusReturnGate.reason}`,
          signals: buildSnapshot(null, agreeingVotes.length, votes.length),
        };
      }

      return {
        action,
        confidence,
        reasoning: `consensus: ${agreeingVotes.length}/${votes.length} agree ${majorityDir ? "YES" : "NO"} (avg conf ${confidence}%)`,
        signals: buildSnapshot(null, agreeingVotes.length, votes.length, action),
      };
    }
  }

  // ── Decision Mode: unanimous ──────────────────────────────────────────────
  // Require all three signals (Stat, Claude, ML) to be available and agree
  // unanimously on the same direction. Any missing signal or any disagreement
  // → SKIP. No warm-up fallback — this is intentionally the strictest mode.
  if (decisionMode === "unanimous") {
    if (statAbove === null || claudeAbove === null || mlAbove === null) {
      const missing = (
        [statAbove === null && "Stat", claudeAbove === null && "Claude", mlAbove === null && "ML"] as Array<string | false>
      ).filter(Boolean).join("+");
      return {
        action: "SKIP",
        confidence: 0,
        reasoning: `unanimous: ${missing} not available — all 3 signals required`,
        signals: buildSnapshot(null),
      };
    }

    if (statAbove !== claudeAbove || claudeAbove !== mlAbove) {
      return {
        action: "SKIP",
        confidence: 0,
        reasoning: `unanimous: signals disagree (Stat=${statAbove ? "YES" : "NO"} Claude=${claudeAbove ? "YES" : "NO"} ML=${mlAbove ? "YES" : "NO"}) — skipping`,
        signals: buildSnapshot(null),
      };
    }

    const agreeDir = statAbove; // all three are identical
    const action: BotDecisionAction = agreeDir ? "BET_YES" : "BET_NO";
    const statConf   = liveStatConf     ?? BASE_CONFIDENCE_HALF_PAIR;
    const claudeConf = claudeConfidence ?? BASE_CONFIDENCE_HALF_PAIR;
    const mlConf     = mlConfidence     ?? BASE_CONFIDENCE_HALF_PAIR;
    const confidence = Math.round((statConf + claudeConf + mlConf) / 3);

    if (confidence < config.minConfidence) {
      return {
        action: "SKIP",
        confidence,
        reasoning: `unanimous: confidence ${confidence}% below minimum ${config.minConfidence}%`,
        signals: buildSnapshot(null, 3, 3),
      };
    }

    const unanimousReturnGate = checkMinReturnGate(action, yesPrice, config.minReturnMultiple);
    if (unanimousReturnGate.blocked) {
      return {
        action: "SKIP",
        confidence,
        reasoning: `unanimous: ${unanimousReturnGate.reason}`,
        signals: buildSnapshot(null, 3, 3),
      };
    }

    return {
      action,
      confidence,
      reasoning: `unanimous: all 3 agree ${agreeDir ? "YES" : "NO"} (Stat=${Math.round(statConf)}% Claude=${Math.round(claudeConf)}% ML=${Math.round(mlConf)}% → avg ${confidence}%)`,
      signals: buildSnapshot(null, 3, 3, action),
    };
  }

  // ── Decision Mode: ml_gate ────────────────────────────────────────────────
  // Simplified three-tier formula (computeMLGateDecision):
  //   ML     = primary direction setter (62.4% accuracy — leads)
  //   Claude = confidence modifier (+CLAUDE_BOOST agree / −CLAUDE_PENALTY dissent)
  //   Stat   = confidence modifier only (+STAT_BOOST agree / −STAT_PENALTY dissent)
  // All three signals must be populated (Gate 1 inside the formula + the tick
  // loop's Live Signals gate) — then the math runs instantly:
  //   confidence = mlConf + (Claude agrees ? +CLAUDE_BOOST : −CLAUDE_PENALTY)
  //                       + (Stat agrees   ? +STAT_BOOST   : −STAT_PENALTY)
  //   BET when confidence ≥ minConfidence, after EV + min-return gates.
  if (decisionMode === "ml_gate") {
    const coreResult = computeMLGateDecision({
      statAbove, claudeAbove,
      mlAbove,
      mlConfidence,
      wmDriftAbove, wmRec, wmReady,
      yesPrice, signalAccuracyPct, minutesElapsed,
      statConfidence: liveStatConf,
      claudeConfidence,
      kalshiTicker,
      minConfidence: config.minConfidence,
      minReturnMultiple: config.minReturnMultiple,
      unanimousMinModelConfidence: config.unanimousMinModelConfidence,
    });

    const coreSnap = buildSnapshot(
      coreResult.ev,
      coreResult.signalsAgreeing,
      coreResult.signalsTotal,
      coreResult.action !== "SKIP" ? coreResult.action : null,
    );
    return {
      action: coreResult.action,
      confidence: coreResult.confidence,
      reasoning: coreResult.reasoning,
      signals: coreSnap,
    };
  }


  // ── Decision Mode: conviction ─────────────────────────────────────────────
  // Delegates to the pure computeConvictionDecision in kalshi-bot-engine-core.
  // See that function's JSDoc for the full zone map and invariant documentation.
  if (decisionMode === "conviction") {
    // The slider sets a single target (e.g. 0.92).  The asymmetric −2¢/+3¢
    // zone is derived by deriveConvictionZone (single source of truth):
    // target 92¢ → window [90¢–95¢].
    const cvTarget  = config.kalshiLockPrice ?? 0.90;
    const cvZone    = deriveConvictionZone(cvTarget);
    // Pull the live orderbook ask/bid from the Kalshi cache so the conviction
    // trigger uses what you actually PAY (the ask), not the mid-price.
    // Without this, a wide NO spread can push the mid to the lock threshold
    // while the actual YES ask is well below it — causing fills at wrong prices.
    const cvCached  = getKalshiCachedData(sym);
    const cvResult = computeConvictionDecision({
      yesPrice,
      yesAsk:        cvCached?.yesAsk ?? null,
      yesBid:        cvCached?.yesBid ?? null,
      noAsk:         cvCached?.noAsk ?? null,
      lockPrice:     cvZone.lockPrice,
      lockPriceCap:  cvZone.lockPriceCap,
      minConfidence: config.minConfidence,
    });
    const cvAgreementTarget: BotDecisionAction | null =
      cvResult.action === "BET_YES" || cvResult.action === "BET_NO"
        ? cvResult.action
        : null;
    return {
      action:     cvResult.action,
      confidence: cvResult.confidence,
      reasoning:  cvResult.reasoning,
      signals: buildSnapshot(null, cvResult.signalsAgreeing, cvResult.signalsTotal, cvAgreementTarget),
    };
  }

  // ── Classic path (also used by ml_primary) ────────────────────────────────
  // unanimousMinModelConfidence is ml_gate-only; do not pass it here so the
  // classic unanimous bypass behaviour remains unchanged.
  const result = computeCorePairDecision({
    statAbove, claudeAbove, mlAbove, wmDriftAbove,
    wmRec, wmReady, yesPrice, signalAccuracyPct, minutesElapsed,
    statConfidence: liveStatConf,
    claudeConfidence,
    mlConfidence,
    mlMinConfidence: profile.mlMinConfidence,
    kalshiTicker,
    minConfidence: config.minConfidence,
    minReturnMultiple: config.minReturnMultiple,
  });

  const snapshot = buildSnapshot(
    result.ev,
    result.signalsAgreeing,
    result.signalsTotal,
    result.action !== "SKIP" ? result.action : null,
  );

  return {
    action: result.action,
    confidence: result.confidence,
    reasoning: result.reasoning,
    signals: snapshot,
  };
}

// ---------------------------------------------------------------------------
// Exported wrapper — applies the ROI gate after all signal logic has run
// ---------------------------------------------------------------------------

export function makeBotDecision(
  symbol: string,
  config: BotConfig,
  kalshiTicker: string | null,
  yesPrice: number | null,
  minutesElapsed: number,
  signalAccuracyPct: number | null,
  kalshiTarget?: number | null,
  livePrice?: number | null,
): BotDecision {
  const inner = _makeBotDecisionInner(symbol, config, kalshiTicker, yesPrice, minutesElapsed, signalAccuracyPct, kalshiTarget, livePrice);

  // NO-direction early-minute gate: defer NO bets until minutesElapsed ≥ minNoEntryMinutes.
  // At minute 0 the orderbook is freshly priced and our signals have less edge on NO bets
  // (53% WR at minute 0 vs 79% at minute 1+). YES bets are unaffected.
  // 0 = disabled.
  const minNoMin = config.minNoEntryMinutes ?? 1;
  if (inner.action === "BET_NO" && minNoMin > 0 && minutesElapsed < minNoMin) {
    return {
      action: "SKIP",
      confidence: inner.confidence,
      reasoning: `NO entry deferred: ${minutesElapsed.toFixed(1)}m elapsed < ${minNoMin}m minimum for NO bets (will retry next tick)`,
      signals: { ...inner.signals, agreementTarget: null },
    };
  }

  // Compute ROI for the chosen side when yesPrice is available.
  // yesPrice is in 0-1 dollar format (e.g. 0.52 for 52¢); net return = payout / stake.
  //
  // CONVICTION MODE: ROI gate is bypassed entirely.  Entry is driven by the
  // Kalshi yesPrice crossing the lock-price zone (88–92 ¢), not by expected
  // value — the zone itself IS the edge signal.  Applying the ROI gate here
  // would incorrectly block conviction bets when the market has strongly priced
  // in a direction (yesPrice ≈ 0.001 gives NO ROI ≈ 0.1 %) even though the bot
  // is correctly targeting the opposite zone.
  if (inner.action !== "SKIP" && yesPrice !== null && yesPrice > 0 && yesPrice < 1) {
    const roi = calcROI(inner.action, yesPrice);
    // Always record roiPct so it shows in bet signals even on SKIPs below.
    inner.signals = { ...inner.signals, roiPct: parseFloat(roi.toFixed(2)) };

    if (roi < MIN_ROI_PCT && config.decisionMode !== "conviction") {
      return {
        action: "SKIP",
        confidence: inner.confidence,
        reasoning: `roi-too-low: ${roi.toFixed(2)}% net return on ${inner.action === "BET_YES" ? "YES" : "NO"} side is below the ${MIN_ROI_PCT}% minimum — market has priced in the direction`,
        signals: inner.signals,
      };
    }
  }

  return inner;
}
