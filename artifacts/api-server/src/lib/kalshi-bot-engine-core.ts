// Pure, zero-dependency decision core for the Kalshi bot.
//
// No imports from ./crypto or any DB/API module — this file is intentionally
// isolated so it can be unit-tested without any I/O setup.
//
// Pipeline (sequential gates — every step must complete before betting):
//
//   GATE 1 — All three models required:
//     Stat, Claude, AND ML must each have a direction before any bet fires.
//     No fast-agreement bypass — Claude must complete its extended-thinking call.
//
//   GATE 2 — Per-signal confidence minimums (non-unanimous only):
//     Applied only when models disagree (Paths B/C/D).  When all three models agree
//     (Path A), Gate 2 is bypassed — no model is "leading" so individual floors are
//     redundant.  Gate 4 composite confidence is the quality gate for unanimous bets.
//     Stat   ≥ STAT_REQUIRED_MIN_CONF   (58%)  — when leading/dissenting
//     Claude ≥ CLAUDE_REQUIRED_MIN_CONF (62%)  — when leading/dissenting
//     ML     ≥ ML_REQUIRED_MIN_CONF     (60%)  — when leading/dissenting
//
//   GATE 3 — Direction agreement (four exclusive paths):
//     (A) All three unanimous → bet.  Gate 2 bypassed; composite confidence alone decides.
//           Confidence = mlConf + ML_SIGNAL_BOOST (Claude boost) + STAT_AGREE_BOOST
//                      [+ CONFIDENCE_BOOST_PER_SIGNAL if WM agrees]
//     (B) ML + Claude agree, Stat dissents → bet with Stat penalty, but ML must reach
//           ML_LEAD_MIN_CONF (70%) to lead against a dissenter.
//           Confidence = mlConf + ML_SIGNAL_BOOST − ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY
//                      [+ CONFIDENCE_BOOST_PER_SIGNAL if WM agrees]
//           Rationale: our two strongest models agree; Stat's dissent is noted
//           as a confidence penalty, not a hard block.
//     (C) Stat + Claude agree, ML opposes at ≥ ML_OVERRIDE_MIN_CONF (75%) → follow ML.
//           Confidence = mlConf [+ CONFIDENCE_BOOST_PER_SIGNAL if WM agrees]
//           Below 75% ML cannot override Stat+Claude consensus → SKIP.
//     (D) ML + Stat agree, Claude disagrees → SKIP.
//           Claude's opposition carries too much weight to override.
//
//   GATE 4 — Composite confidence ≥ minConfidence (default 70%).
//
// Post-pipeline: EV gate, minReturnMultiple gate (applied in computeCorePairDecision).

export type BotDecisionAction = "BET_YES" | "BET_NO" | "SKIP";

// Base confidence when Claude+Stat both agree (Path B full pair).
export const BASE_CONFIDENCE_FULL_PAIR = 65;
// Base confidence when only one of Claude/Stat is available (Path B/C half pair).
export const BASE_CONFIDENCE_HALF_PAIR = 60;
// Each validating signal adds this when it agrees in Path B/C (WM).
export const CONFIDENCE_BOOST_PER_SIGNAL = 8;
// Minimum ML confidence required for ML to lead (Path A).
export const ML_PRIMARY_MIN_CONFIDENCE = 65;
// Minimum ML confidence at which ML's direction is considered meaningful enough
// to trigger the Claude-ML alignment gate.  Below this threshold ML is treated
// as noise — a weak ML dissent (50–55%) should not block a strong stat+claude
// consensus; PATH B handles it with a small confidence penalty instead.
export const ML_ALIGNMENT_GATE_MIN_CONFIDENCE = 56;
// When BOTH Stat and Claude oppose ML with confidence at or above this threshold,
// their combined consensus overrides ML — SKIP regardless of ML confidence.
// Below this threshold their opposition is too weak to block a confident ML (≥70%).
// Example: stat=55%+claude=55% vs ML=72% → ML leads. stat=62%+claude=55% → SKIP.
// Null confidence is treated conservatively as >= this threshold (assumed strong).
export const STAT_CLAUDE_DOMINANCE_THRESHOLD = 60;
// Each agreeing validator (Claude, Stat, WM) adds this when ML leads (Path A).
export const ML_SIGNAL_BOOST = 6;
// Penalty applied when a model is available and actively calls the OPPOSITE direction.
// Symmetric with ML_SIGNAL_BOOST so that one agree+one oppose = net zero boost.
// Applied in: PATH A (Claude/Stat oppose ML), PATH B (ML opposes Claude).
export const DISSENT_PENALTY = 6;
// Minimum margin by which ML must lead an opposing signal's confidence for the
// "ML dominance" exception to fire — used in both the alignment gate (Case A)
// and the PATH A confirmation gate.  Below this margin the opposing signal is
// considered meaningful enough to block or veto ML.
export const ML_DOMINANCE_MARGIN = 10;

// ── Pipeline per-signal confidence minimums ──────────────────────────────────
// All three models must have a direction AND meet their own minimum before
// the group decision is made.  null confidence is treated as 0 (conservative).
export const STAT_REQUIRED_MIN_CONF   = 58; // Stat ≥ 58%
export const CLAUDE_REQUIRED_MIN_CONF = 62; // Claude ≥ 62% (strong co-signer)
export const ML_REQUIRED_MIN_CONF     = 60; // ML ≥ 60% — minimum to provide a meaningful direction
// When ML is leading against a Stat dissenter (Path B), it must clear this
// higher bar.  In the unanimous case (Path A) the Gate 2 floor (60%) suffices
// because ML is not the lone leader — it is part of a consensus.
export const ML_LEAD_MIN_CONF         = 70; // ML ≥ 70% to lead vs Stat dissent (Path B)
// ML must reach this threshold to override a Stat+Claude consensus in the
// opposite direction (Gate 3C).  Below this level the two-model consensus
// prevails and the window is skipped.
export const ML_OVERRIDE_MIN_CONF = 75;
// Gate 3 confidence adjustments — applied after direction is resolved.
// Claude is our primary co-signer; Stat is the technical confirmer.
export const STAT_AGREE_BOOST = 4;  // +4pp when Stat agrees with ML+Claude direction
export const ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY = 4; // −4pp when Stat dissents from ML+Claude

// ── ML Gate weighted-blend formula constants ──────────────────────────────────
// Priority hierarchy: ML = primary direction setter AND co-decider (60% weight),
// Claude = required co-decider (40% weight, direction veto if disagrees),
// Stat = ±4pp modifier.  See computeMLGateDecision.
export const ML_WEIGHT     = 0.60; // ML's share of the weighted blend
export const CLAUDE_WEIGHT = 0.40; // Claude's share — required to agree on direction
export const STAT_BOOST    = 4;    // Stat agrees with ML's direction    → +4pp
export const STAT_PENALTY  = 4;    // Stat disagrees with ML's direction → −4pp
// Legacy aliases kept for backwards-compat imports (backtest-core, tests, classic path).
export const CLAUDE_BOOST   = 6;
export const CLAUDE_PENALTY = 6;
export const ML_BOOST = CLAUDE_BOOST;

// ── Bet Profiles ─────────────────────────────────────────────────────────────
// Two preset aggression levels the user can switch between in the dashboard.
// "Normal"     — current proven defaults; higher bar for ML-led entries.
// "Aggressive" — more bets per window; ML leads at a lower confidence threshold;
//                effective confidence is capped at 80% to neutralise the false-
//                unanimity problem where all signals agree in choppy markets.

export type BetProfile = "normal" | "aggressive";

export interface BetProfileConfig {
  label: string;
  description: string;
  mlMinConfidence: number;        // minimum ML confidence for ML to lead (Path A)
  effectiveConfidenceCap: number; // clamps effective confidence before the minConfidence check
  regimePenalty: number;          // pp deducted for against-regime bets (auto-synced to BotConfig.regimePenalty on switch)
}

export const BET_PROFILES: Record<BetProfile, BetProfileConfig> = {
  normal: {
    label: "Normal",
    // Confidence ranges:
    //   PATH A (ML leads, ≥70%): 70–88% base + 6pp per supporting signal (Stat/Claude/WM)
    //   PATH B (Stat+Claude): 68% base (full pair), 60% base (half pair); no cap
    //   ML < 56%: treated as noise — weak dissent handled by −6pp penalty in PATH B
    //   ML 56–69%: meaningful dissent, triggers alignment gate → SKIP if disagreeing with Claude
    //   No regime penalty — each 15-min window is independent; YES and NO are equally valid
    description: "Balanced — ML leads at 70%+; stat+claude win when ML is weak (≤55%); no regime bias. Direction decided purely by signal agreement.",
    mlMinConfidence: 70,
    effectiveConfidenceCap: 100,
    regimePenalty: 0,
  },
  aggressive: {
    label: "Aggressive",
    // Same ML threshold as normal (70%) — the same directional rules apply.
    // Aggressive mode differs via effectiveConfidenceCap (caps inflated entries at 80%).
    description: "More bets — ML leads at 70%+; confidence capped at 80% to prevent over-conviction in choppy markets. Same directional rules as Normal.",
    mlMinConfidence: 70,
    effectiveConfidenceCap: 80,
    regimePenalty: 0,
  },
};

export interface CorePairInputs {
  statAbove: boolean | null;
  claudeAbove: boolean | null;
  mlAbove: boolean | null;
  wmDriftAbove: boolean | null;   // null when WM is not ready or not recommending "bet"
  wmRec: "bet" | "stay_away" | "caution" | null;
  wmReady: boolean;
  yesPrice: number | null;
  signalAccuracyPct: number | null;
  minutesElapsed: number;
  statConfidence: number | null;
  claudeConfidence: number | null;
  mlConfidence: number | null;
  mlMinConfidence?: number | null;  // profile override for ML_PRIMARY_MIN_CONFIDENCE
  kalshiTicker: string | null;
  minConfidence: number;
  minReturnMultiple?: number | null; // skip bets whose payout multiple (1/cost) is below this; ≤1 = off
  unanimousMinModelConfidence?: number; // per-model floor for Path A bypass; 0/undefined = off
}

export interface CorePairResult {
  action: BotDecisionAction;
  confidence: number;
  reasoning: string;
  signalsAgreeing: number;
  signalsTotal: number;
  ev: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeEV(yesPrice: number | null, signalAccuracyPct: number | null): number | null {
  if (yesPrice == null || yesPrice <= 0 || signalAccuracyPct == null) return null;
  const accFrac = signalAccuracyPct / 100;
  const winPayoff = (1 - yesPrice) / yesPrice;
  return accFrac * winPayoff - (1 - accFrac);
}

// ---------------------------------------------------------------------------
// Conviction mode — pure decision core
// ---------------------------------------------------------------------------
//
// The conviction decision mode fires a reactive FOK based solely on the
// Kalshi contract price.  The market crowd's pricing is the signal:
//   yesPrice ≥ lockPrice         → BET_YES (reactive FOK)
//   yesPrice ≤ (1 − lockPrice)   → BET_NO  (reactive FOK)
//   otherwise                    → SKIP (waiting for market to settle)
//
// No models, no veto, no resting GTC orders — purely reactive.

export interface ConvictionInputs {
  yesPrice:       number | null;
  // Orderbook ask/bid prices — more accurate than the mid for trigger checks.
  // yesAsk = what you actually PAY per YES contract (= 1 − no_bid).
  // yesBid = what you actually PAY per NO contract, expressed as (1 − yesBid)
  //          i.e. yesBid is what you receive selling YES = what NO costs you.
  // noAsk  = what you actually PAY per NO contract (= no_ask_dollars from API).
  //          Preferred over 1−yesBid for NO zone detection: the Kalshi API
  //          updates no_ask_dollars and yes_bid_dollars independently; during
  //          rapid moves noAsk updates faster and reflects the real NO cost.
  // When both are present they are used for the lock-trigger check instead of
  // the mid (yesPrice), preventing fills at prices outside the intended window.
  yesAsk?:        number | null;
  yesBid?:        number | null;
  noAsk?:         number | null;
  lockPrice?:     number;   // default 0.82 — minimum % to trigger entry (floor)
  lockPriceCap?:  number;   // default 0.91 — maximum % allowed; above this is too late
  minConfidence:  number;
}

export function computeConvictionDecision(inp: ConvictionInputs): CorePairResult {
  const { yesPrice, minConfidence } = inp;
  const lockPrice    = inp.lockPrice    ?? 0.82;
  const lockPriceCap = inp.lockPriceCap ?? 0.91;

  if (yesPrice == null) {
    return {
      action: "SKIP",
      confidence: 0,
      reasoning: "conviction: Kalshi yes price unavailable",
      signalsAgreeing: 0,
      signalsTotal: 0,
      ev: null,
    };
  }

  // Use the actual orderbook ask/bid prices for the trigger check, not the mid.
  //
  // Price asymmetry — YES and NO entry prices come from DIFFERENT sides of the book:
  //   YES entry: pay yesAsk (the ask side of YES).  Falls back to mid yesPrice when
  //              yesAsk is unavailable — mid is a reasonable proxy for the ask.
  //   NO  entry: pay noAsk = 1 − yesBid (the bid side of YES tells us what NO costs).
  //              NEVER falls back to 1 − yesPrice: when yesBid is null there is no
  //              YES buyer, meaning there is no counterparty for a NO buy order.
  //              Using the mid as a fallback here produced false lock signals
  //              (noTrigger ≈ 0.999 when yesPrice ≈ 0.001) that bypassed lockPriceCap
  //              via isExtremePrice and created a constant dispatch-then-fail-closed
  //              spam loop (60–100 wasted Kalshi API calls per minute).
  //
  // Example of the mid-price bug this prevents for YES:
  //   yesAsk=0.80, yesBid=0.96 → mid=(0.80+0.96)/2=0.88 → triggers at lockPrice=0.88
  //   but you actually fill at 0.80 (8¢ outside the intended window).
  const yesTrigger = inp.yesAsk ?? yesPrice;            // cost of YES entry (ask fallback → mid)
  // NO entry cost: prefer noAsk (direct from no_ask_dollars) over 1−yesBid.
  // The Kalshi API updates no_ask_dollars and yes_bid_dollars independently;
  // during rapid price moves, noAsk reflects the real NO ask faster than the
  // complement of yes_bid_dollars.  Fall back to 1−yesBid when noAsk absent.
  const noTrigger  = inp.noAsk != null
    ? inp.noAsk
    : (inp.yesBid != null ? (1 - inp.yesBid) : null);  // null = NO unpriced/untradeable

  const isYesLocked = yesTrigger >= lockPrice;
  const isNoLocked  = noTrigger != null && noTrigger >= lockPrice;

  if (!isYesLocked && !isNoLocked) {
    const noTriggerDesc = noTrigger != null ? noTrigger.toFixed(2) : "null(no-bid)";
    return {
      action: "SKIP",
      confidence: 0,
      reasoning: `conviction: ask prices not at lock threshold ${lockPrice.toFixed(2)} (yesAsk=${yesTrigger.toFixed(2)} noAsk=${noTriggerDesc})`,
      signalsAgreeing: 0,
      signalsTotal: 0,
      ev: null,
    };
  }

  // Hard cap: if the price has blown past the entry window, skip.
  // YES: actual YES ask must be ≤ lockPriceCap
  // NO:  actual NO  ask must be ≤ lockPriceCap
  //
  // Extreme-price bypass: when yesPrice is already at or past the extreme
  // threshold (≥ 0.92 YES or ≤ 0.08 / NO ≥ 0.92), the market has decisively
  // committed — this IS the entry signal, not a missed window.  The cap does
  // not apply; we bet immediately regardless of how far past 0.92 it is.
  const isExtremePrice = yesPrice >= 0.92 || yesPrice <= 0.08;
  const isTooDeepYes = !isExtremePrice && isYesLocked && yesTrigger > lockPriceCap;
  // noTrigger is non-null whenever isNoLocked is true (isNoLocked guards noTrigger != null)
  const isTooDeepNo  = !isExtremePrice && isNoLocked  && noTrigger! > lockPriceCap;

  if (isTooDeepYes || isTooDeepNo) {
    const side      = isYesLocked ? "YES" : "NO";
    const askPrice  = isYesLocked ? yesTrigger : noTrigger!;
    return {
      action: "SKIP",
      confidence: 0,
      reasoning: `conviction: ${side} ask at ${(askPrice * 100).toFixed(0)}% is past the ${(lockPriceCap * 100).toFixed(0)}% cap — entry window missed`,
      signalsAgreeing: 0,
      signalsTotal: 0,
      ev: null,
    };
  }

  const action: BotDecisionAction = isYesLocked ? "BET_YES" : "BET_NO";
  // Use actual ask price for confidence — this is what you're paying, not the mid.
  // noTrigger is non-null here because isNoLocked (which guards noTrigger != null) must be
  // true for BET_NO to reach this point (the !isYesLocked && !isNoLocked early return above
  // ensures at least one is locked, and BET_NO means !isYesLocked, so isNoLocked must hold).
  const lockedPrice = isYesLocked ? yesTrigger : noTrigger!;
  const confidence  = Math.min(Math.round(50 + lockedPrice * 50), 95);

  if (confidence < minConfidence) {
    return {
      action: "SKIP",
      confidence,
      reasoning: `conviction: confidence ${confidence}% below minimum ${minConfidence}%`,
      signalsAgreeing: 0,
      signalsTotal: 0,
      ev: null,
    };
  }

  return {
    action,
    confidence,
    reasoning: `conviction: Kalshi ${isYesLocked ? "YES" : "NO"} at ${(lockedPrice * 100).toFixed(0)}% — window [${(lockPrice * 100).toFixed(0)}–${(lockPriceCap * 100).toFixed(0)}%] — return=${(1 / lockedPrice).toFixed(2)}×`,
    signalsAgreeing: 0,
    signalsTotal: 0,
    ev: null,
  };
}

/**
 * Direction-correct EV — uses the actual cost structure for the chosen side.
 *   BET_YES: pays yesPrice, wins (1 − yesPrice)  → payoff = (1−p)/p
 *   BET_NO:  pays (1−yesPrice), wins yesPrice     → payoff = p/(1−p)
 * This must be called AFTER direction is known so YES and NO bets are treated
 * symmetrically.  The old pre-direction gate always used the YES formula, which
 * incorrectly penalised cheap NO contracts (high yes_price) and rewarded
 * expensive NO contracts (low yes_price).
 */
function computeEVForDirection(
  action: "BET_YES" | "BET_NO",
  yesPrice: number | null,
  signalAccuracyPct: number | null,
): number | null {
  if (yesPrice == null || yesPrice <= 0 || yesPrice >= 1 || signalAccuracyPct == null) return null;
  const accFrac = signalAccuracyPct / 100;
  if (action === "BET_YES") {
    return accFrac * (1 - yesPrice) / yesPrice - (1 - accFrac);
  } else {
    return accFrac * yesPrice / (1 - yesPrice) - (1 - accFrac);
  }
}

function countSignals(
  direction: boolean,
  statAbove: boolean | null,
  claudeAbove: boolean | null,
  mlAbove: boolean | null,
  wmDriftAbove: boolean | null,
): { signalsTotal: number; signalsAgreeing: number } {
  const all = [statAbove, claudeAbove, mlAbove, wmDriftAbove];
  return {
    signalsTotal:    all.filter((x) => x !== null).length,
    signalsAgreeing: all.filter((x) => x === direction).length,
  };
}

/**
 * Public decision function — runs the pure core decision, then applies the
 * minimum-return gate (payout multiple = 1 / cost). A Kalshi contract costing
 * `cost` dollars pays $1, so its return multiple is 1/cost. When the configured
 * floor is > 1, any actionable bet whose payout multiple falls below it is
 * skipped (these are the deep in-the-money "near-certainty" bets with poor
 * risk/reward, e.g. paying 92¢ to make 8¢ → 1.09x).
 *   BET_YES cost = yesPrice ; BET_NO cost = 1 - yesPrice
 */
export function computeCorePairDecision(inp: CorePairInputs): CorePairResult {
  const result = computeCorePairDecisionUngated(inp);

  // Min-return gate first — structural price check independent of model confidence.
  // Rejects contracts where the payout multiple is below the configured floor
  // (e.g. paying 92¢ to win 8¢ → 1.09× is never acceptable regardless of signals).
  const gate = checkMinReturnGate(result.action, inp.yesPrice, inp.minReturnMultiple);
  if (gate.blocked) {
    return {
      action: "SKIP",
      confidence: result.confidence,
      reasoning: `${gate.reason} — was ${result.action} (${result.reasoning})`,
      signalsAgreeing: result.signalsAgreeing,
      signalsTotal: result.signalsTotal,
      ev: result.ev,
    };
  }

  // Direction-aware EV gate — uses the composite confidence (result.confidence)
  // as the accuracy estimate, not the global historical ensemble accuracy.
  // The composite already integrates Claude + ML + Stat signals for the current
  // window, so it IS the model's best current accuracy estimate.  Feeding stale
  // global history here would double-penalise coins that happen to have a poor
  // overall record but a strong current-window signal.
  if (result.action === "BET_YES" || result.action === "BET_NO") {
    const evAcc = result.confidence; // composite, 0–100
    const dirEV = computeEVForDirection(result.action, inp.yesPrice, evAcc);
    const evFloor = result.action === "BET_NO" ? -0.15 : -0.05;
    if (dirEV !== null && dirEV < evFloor) {
      return {
        action: "SKIP",
        confidence: result.confidence,
        reasoning: `Negative EV (${dirEV.toFixed(3)}) at yes=${inp.yesPrice?.toFixed(2)} composite=${evAcc.toFixed(0)}% (floor ${evFloor})`,
        signalsAgreeing: result.signalsAgreeing,
        signalsTotal: result.signalsTotal,
        ev: dirEV,
      };
    }
  }

  return result;
}

/**
 * ML Gate — weighted-blend co-decision formula.
 *
 * Both ML and Claude are decision makers; neither can win alone:
 *   ML     = primary direction setter (60% weight, 62.4% accuracy)
 *   Claude = required co-decider      (40% weight, direction veto if disagrees)
 *   Stat   = ±4pp modifier only
 *
 * Formula (all three signals required before running):
 *   1. direction  = ML direction
 *   2. If Claude disagrees → SKIP immediately (direction veto — no bet)
 *   3. composite  = round(mlConf × ML_WEIGHT + claudeConf × CLAUDE_WEIGHT)
 *                         + (Stat agrees ? +STAT_BOOST : −STAT_PENALTY)
 *   4. gate       : composite ≥ minConfidence → BET, else SKIP
 *
 * Post-decision gates (shared with all modes): direction-aware EV floor and
 * the minimum-return (payout multiple) gate.
 */
export function computeMLGateDecision(inp: CorePairInputs): CorePairResult {
  const result = computeMLGateDecisionUngated(inp);

  // Min-return gate first — structural price check independent of model confidence.
  const gate = checkMinReturnGate(result.action, inp.yesPrice, inp.minReturnMultiple);
  if (gate.blocked) {
    return {
      action: "SKIP",
      confidence: result.confidence,
      reasoning: `${gate.reason} — was ${result.action} (${result.reasoning})`,
      signalsAgreeing: result.signalsAgreeing,
      signalsTotal: result.signalsTotal,
      ev: result.ev,
    };
  }

  // EV gate — uses composite confidence, not stale global historical accuracy.
  if (result.action === "BET_YES" || result.action === "BET_NO") {
    const evAcc = result.confidence; // composite, 0–100
    const dirEV = computeEVForDirection(result.action, inp.yesPrice, evAcc);
    const evFloor = result.action === "BET_NO" ? -0.15 : -0.05;
    if (dirEV !== null && dirEV < evFloor) {
      return {
        action: "SKIP",
        confidence: result.confidence,
        reasoning: `Negative EV (${dirEV.toFixed(3)}) at yes=${inp.yesPrice?.toFixed(2)} composite=${evAcc.toFixed(0)}% (floor ${evFloor})`,
        signalsAgreeing: result.signalsAgreeing,
        signalsTotal: result.signalsTotal,
        ev: dirEV,
      };
    }
  }

  return result;
}

function computeMLGateDecisionUngated(inp: CorePairInputs): CorePairResult {
  const skip = (reason: string, ev: number | null = null): CorePairResult => ({
    action: "SKIP", confidence: 0, reasoning: reason,
    signalsAgreeing: 0, signalsTotal: 0, ev,
  });

  if (!inp.kalshiTicker) {
    return skip("No active Kalshi market for this symbol");
  }

  const ev = computeEV(inp.yesPrice, inp.signalAccuracyPct);

  // ── Gate 1: ALL THREE signals required ───────────────────────────────────
  // Full population of the live signals per coin is the unlock: the tick loop
  // waits until stat, Claude, and ML have all reported before the math runs.
  if (inp.statAbove === null) {
    return skip("Live Signals: waiting for Stat — all three (Stat, Claude, ML) must be populated before betting", ev);
  }
  if (inp.claudeAbove === null) {
    return skip("Live Signals: waiting for Claude — all three (Stat, Claude, ML) must be populated before betting", ev);
  }
  if (inp.mlAbove === null) {
    return skip("Live Signals: waiting for ML — all three (Stat, Claude, ML) must be populated before betting", ev);
  }

  const statDir   = inp.statAbove;
  const claudeDir = inp.claudeAbove;
  const mlDir     = inp.mlAbove;
  const statConf   = inp.statConfidence   ?? 0;
  const claudeConf = inp.claudeConfidence ?? 0;
  const mlConf     = inp.mlConfidence     ?? 0;

  // ── Step 1: Direction — ML leads ─────────────────────────────────────────
  const direction = mlDir;

  // ── Step 2: Direction veto — Claude must agree ───────────────────────────
  // Claude is a required co-decider: if it disagrees on direction the bet is
  // blocked immediately, regardless of ML confidence level.
  const claudeAgrees = claudeDir === mlDir;
  const statAgrees   = statDir   === mlDir;

  if (!claudeAgrees) {
    const { signalsTotal, signalsAgreeing } = countSignals(
      direction, statDir, claudeDir, mlDir, inp.wmDriftAbove,
    );
    return {
      action: "SKIP", confidence: 0, ev,
      reasoning: `Claude disagrees on direction — direction veto (ML: ${mlDir ? "YES" : "NO"} ${Math.round(mlConf)}%, Claude: ${claudeDir ? "YES" : "NO"} ${Math.round(claudeConf)}%)`,
      signalsAgreeing, signalsTotal,
    };
  }

  // ── Step 3: Weighted confidence blend ────────────────────────────────────
  // composite = round(mlConf × ML_WEIGHT + claudeConf × CLAUDE_WEIGHT) + statMod
  // Neither signal reaches the threshold alone — both must be decent.
  let statMod = statAgrees ? STAT_BOOST : -STAT_PENALTY;

  // ── Unanimous model floor (ml_gate) ──────────────────────────────────────
  // When all three models agree on direction but any individual model's
  // confidence is below unanimousMinModelConfidence, the unanimous arrangement
  // is downgraded: the Stat boost is withdrawn and replaced with the Stat
  // penalty — reducing the composite as if Stat had disagreed.
  // This prevents three weakly-confident-but-agreeing models from clearing
  // minConfidence via accumulated agreement alone.
  const unanimousModelFloor = inp.unanimousMinModelConfidence ?? 0;
  const allThreeAgreeMLGate = claudeAgrees && statAgrees;
  let unanimousDowngradedNote = "";
  if (allThreeAgreeMLGate && unanimousModelFloor > 0) {
    const weakestModel = Math.min(statConf, claudeConf, mlConf);
    if (weakestModel < unanimousModelFloor) {
      statMod = -STAT_PENALTY;
      unanimousDowngradedNote =
        ` [unanimous downgraded — weakest model ${Math.round(weakestModel)}% < ${unanimousModelFloor}% floor]`;
    }
  }

  const mlContrib = Math.round(mlConf     * ML_WEIGHT);
  const clContrib = Math.round(claudeConf * CLAUDE_WEIGHT);
  const confidence = mlContrib + clContrib + statMod;

  const statLabel = unanimousDowngradedNote
    ? ` − Stat (downgraded; −${STAT_PENALTY})`
    : statAgrees ? ` + Stat (+${STAT_BOOST})` : ` − Stat (−${STAT_PENALTY})`;
  const pathReason =
    `ML Gate: ML ${mlDir ? "YES" : "NO"} ${Math.round(mlConf)}%×${ML_WEIGHT}=${mlContrib}` +
    ` + Claude ${Math.round(claudeConf)}%×${CLAUDE_WEIGHT}=${clContrib}` +
    statLabel +
    unanimousDowngradedNote;

  const { signalsTotal, signalsAgreeing } = countSignals(
    direction, statDir, claudeDir, mlDir, inp.wmDriftAbove,
  );

  // ── Step 4: Composite gate ───────────────────────────────────────────────
  if (confidence < inp.minConfidence) {
    return {
      action: "SKIP", confidence,
      reasoning: `Composite confidence ${confidence}% below minimum ${inp.minConfidence}% — ${pathReason}`,
      signalsAgreeing, signalsTotal, ev,
    };
  }

  const action: BotDecisionAction = direction ? "BET_YES" : "BET_NO";
  const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";
  return {
    action, confidence, ev,
    signalsAgreeing, signalsTotal,
    reasoning: `${pathReason}${evDesc} → ${action} (${confidence}%)`,
  };
}

/**
 * Minimum-return (payout multiple) gate — pure and shared across every decision
 * mode (classic, ml_gate, consensus, unanimous). A Kalshi contract costing
 * `cost` dollars pays $1, so its payout multiple is 1/cost.
 *   BET_YES cost = yesPrice ; BET_NO cost = 1 - yesPrice
 * Returns `blocked: true` (with a reason) when an actionable bet's payout
 * multiple is below the configured floor.
 *
 * IMPORTANT — null yesPrice is NOT blocked: the decision-time yes-price comes
 * from the short-lived kalshiTargetCache, which is frequently null at the moment
 * the bot decides (thin/late-publishing orderbook early in a window). This is
 * normal — the bot places a *market* order, so the real fill price is resolved
 * at order-placement time regardless of the cached value. Blocking on null here
 * would skip essentially every live bet (the cache is null far more often than
 * not), so we let the bet proceed and enforce the floor only when a price is
 * actually known. A floor of ≤ 1 disables the gate entirely.
 */
export function checkMinReturnGate(
  action: BotDecisionAction,
  yesPrice: number | null,
  minReturnMultiple: number | null | undefined,
): { blocked: boolean; reason: string } {
  const minReturn = minReturnMultiple ?? 0;
  if (minReturn <= 1 || action === "SKIP") return { blocked: false, reason: "" };

  // No decision-time price to verify against — do not block. The market order
  // fills at the real price at placement time (see module note above).
  if (yesPrice == null) return { blocked: false, reason: "" };

  const cost = action === "BET_YES" ? yesPrice : 1 - yesPrice;
  if (cost <= 0) return { blocked: false, reason: "" };

  const payoffMultiple = 1 / cost;
  if (payoffMultiple < minReturn) {
    return {
      blocked: true,
      reason: `Return ${payoffMultiple.toFixed(2)}x below minimum ${minReturn.toFixed(2)}x (cost ${(cost * 100).toFixed(0)}¢)`,
    };
  }

  return { blocked: false, reason: "" };
}

/**
 * Fast-agreement early entry — pure predicate.
 *
 * Stat and ML are both local + instant signals available within the first
 * minute of a window, while Claude's extended-thinking call takes 30-120s
 * after prefetch. Waiting for Claude means entering at minute 2-4, by which
 * point trending-window prices have collapsed to extremes (1-10¢ / 90-99¢)
 * and every entry fails the min-return gate — the root cause of near-zero
 * bet volume and zero NO bets historically.
 *
 * Returns true when Stat and ML are BOTH available, AGREE on direction, and
 * at least one is confident (>= minConf, default 60). When true, the
 * Claude-pending guard must not block the entry; the engine's PATH A handles
 * the Claude-null decision (ML leads, Stat validates).
 */
export function checkFastAgreementEntry(
  statAbove: boolean | null,
  mlAbove: boolean | null,
  statConfidence: number | null,
  mlConfidence: number | null,
  minConf = 60,
): boolean {
  const agree = statAbove !== null && mlAbove !== null && statAbove === mlAbove;
  const confident = (mlConfidence ?? 0) >= minConf || (statConfidence ?? 0) >= minConf;
  return agree && confident;
}

/**
 * Pure decision function — all inputs are values, no I/O.
 *
 * See module header for the three priority paths (A / B / C).
 */
function computeCorePairDecisionUngated(inp: CorePairInputs): CorePairResult {
  const skip = (reason: string, ev: number | null = null): CorePairResult => ({
    action: "SKIP", confidence: 0, reasoning: reason,
    signalsAgreeing: 0, signalsTotal: 0, ev,
  });

  if (!inp.kalshiTicker) {
    return skip("No active Kalshi market for this symbol");
  }

  const ev = computeEV(inp.yesPrice, inp.signalAccuracyPct);

  // ── Gate 1: ALL THREE models required ────────────────────────────────────
  // No bet fires until Stat, Claude, AND ML have each provided a direction.
  // This is a strict pipeline: every step must complete before the group
  // decision can be made.  Waiting for Claude is intentional — it is the most
  // expensive signal and its extended-thinking call takes 30-120s after the
  // window opens.  No fast-agreement bypass.
  if (inp.statAbove === null) {
    return skip("Pipeline: waiting for Stat signal — all three models (Stat, Claude, ML) required before betting", ev);
  }
  if (inp.claudeAbove === null) {
    return skip("Pipeline: waiting for Claude — all three models (Stat, Claude, ML) required before betting", ev);
  }
  if (inp.mlAbove === null) {
    return skip("Pipeline: waiting for ML — all three models (Stat, Claude, ML) required before betting", ev);
  }

  // ── Gate 2: Per-signal confidence minimums ───────────────────────────────
  // ML and Claude are the PRIMARY direction signals; Stat is a secondary
  // confidence modifier.
  //
  // Unanimous (Path A): Gate 2 is BYPASSED.  Three-model unanimous agreement
  //   is itself strong evidence, and the stat model's calibrated confidence
  //   output (50–57%) is routinely below any meaningful floor even on reliable
  //   entries.  The composite minConfidence check (Gate 4, line ~505) acts as
  //   the final backstop: composite = mlConf + ML_SIGNAL_BOOST + STAT_AGREE_BOOST.
  //
  // Non-unanimous (B/C/D): all three must independently clear their floors so
  //   that a lone high-confidence model cannot drag through a weak pair.
  // null confidence is treated conservatively as 0.
  const statConf   = inp.statConfidence   ?? 0;
  const claudeConf = inp.claudeConfidence ?? 0;
  const mlConf     = inp.mlConfidence     ?? 0;

  // Gate 1 already guarantees none of these is null, so direction comparison is safe.
  const allThreeAgree = inp.statAbove === inp.claudeAbove && inp.claudeAbove === inp.mlAbove;

  // unanimousMinModelConfidence: when set, each model must individually meet this
  // confidence floor for the Path A unanimous bypass (Gate 2 skip) to apply.
  // If any model is below the floor the bet is routed through non-unanimous Gate 2
  // — preventing three weakly-agreeing models from bypassing individual floors.
  const unanimousModelFloor = inp.unanimousMinModelConfidence ?? 0;
  const unanimousSignal = allThreeAgree &&
    (unanimousModelFloor <= 0 ||
     (statConf >= unanimousModelFloor && claudeConf >= unanimousModelFloor && mlConf >= unanimousModelFloor));

  if (!unanimousSignal) {
    if (statConf < STAT_REQUIRED_MIN_CONF) {
      return skip(
        `Stat confidence ${Math.round(statConf)}% below minimum ${STAT_REQUIRED_MIN_CONF}% — signal not strong enough for non-unanimous decision`,
        ev,
      );
    }
    if (claudeConf < CLAUDE_REQUIRED_MIN_CONF) {
      return skip(
        `Claude confidence ${Math.round(claudeConf)}% below minimum ${CLAUDE_REQUIRED_MIN_CONF}% — signal not strong enough for non-unanimous decision`,
        ev,
      );
    }
    if (mlConf < ML_REQUIRED_MIN_CONF) {
      return skip(
        `ML confidence ${Math.round(mlConf)}% below minimum ${ML_REQUIRED_MIN_CONF}% — signal not strong enough for non-unanimous decision`,
        ev,
      );
    }
  }

  // ── Gate 3: Direction agreement ──────────────────────────────────────────
  // Four exclusive paths (with 3 boolean signals only one model can be the
  // odd one out — the 4th "all disagree" case is impossible):
  //   (A) All three unanimous → best-quality bet
  //   (B) ML + Claude agree, Stat dissents → bet with Stat penalty
  //   (C) Stat + Claude agree, ML opposes → ML override at ≥ ML_OVERRIDE_MIN_CONF; else SKIP
  //   (D) ML + Stat agree, Claude disagrees → SKIP (Claude's opposition overrides)
  const statDir   = inp.statAbove as boolean;
  const claudeDir = inp.claudeAbove as boolean;
  const mlDir     = inp.mlAbove as boolean;

  let direction: boolean;
  let confidence: number;
  let pathReason: string;
  let coreAgreeing: number;

  if (statDir === claudeDir && claudeDir === mlDir) {
    // ── (A) Unanimous — all three agree ──────────────────────────────────────
    // Direction is ML's — ML and Claude are the primary directional signals;
    // stat is a secondary confidence modifier.  All three happen to agree here.
    direction = mlDir;
    confidence = mlConf + ML_SIGNAL_BOOST + STAT_AGREE_BOOST; // Claude co-signs (+6), Stat confirms (+4)
    pathReason = `Unanimous: Stat:✓(${Math.round(statConf)}%) Claude:✓(${Math.round(claudeConf)}%) ML:✓(${Math.round(mlConf)}%)`;
    coreAgreeing = 3;

  } else if (mlDir === claudeDir) {
    // ── (B) ML + Claude agree, Stat dissents ─────────────────────────────────
    // Our two strongest models agree; Stat's dissent is noted as a confidence
    // penalty but does not block the bet.  This is the key improvement over the
    // prior pipeline where stat≠claude was always a hard SKIP.
    // ML must clear ML_LEAD_MIN_CONF (70%) here — it is leading against a
    // dissenter, so the 60% Gate 2 floor is not enough.
    if (mlConf < ML_LEAD_MIN_CONF) {
      return skip(
        `ML+Claude agree (${Math.round(mlConf)}%/${Math.round(claudeConf)}%) but ML needs ≥${ML_LEAD_MIN_CONF}% to lead against Stat dissent — skipping`,
        ev,
      );
    }
    direction = mlDir;
    confidence = mlConf + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY; // Claude co-signs (+6), Stat penalty (−4)
    pathReason = `ML+Claude agree (${Math.round(mlConf)}%/${Math.round(claudeConf)}%), Stat dissents (${Math.round(statConf)}% ${statDir ? "YES" : "NO"}) — Stat penalty applied`;
    coreAgreeing = 2;

  } else if (statDir === claudeDir) {
    // ── (C) Stat + Claude agree, ML opposes ──────────────────────────────────
    // ML can override at ≥ ML_OVERRIDE_MIN_CONF (75%).  Below that threshold
    // the Stat+Claude consensus prevails and the window is skipped.
    if (mlConf < ML_OVERRIDE_MIN_CONF) {
      return skip(
        `ML (${Math.round(mlConf)}%) opposes Stat+Claude consensus but needs ≥${ML_OVERRIDE_MIN_CONF}% to override — skipping`,
        ev,
      );
    }
    direction = mlDir;
    confidence = mlConf; // ML overrides: confidence is ML's alone; no boosts from opposing validators
    pathReason = `ML override (${Math.round(mlConf)}%≥${ML_OVERRIDE_MIN_CONF}%): ML overrides Stat+Claude consensus pointing ${statDir ? "YES" : "NO"}`;
    coreAgreeing = 1;

  } else {
    // ── (D) ML + Stat agree, Claude disagrees ────────────────────────────────
    // Claude is our strongest reasoning model — its opposition overrides even a
    // ML+Stat agreement.  No override path; hard SKIP.
    return skip(
      `Claude (${Math.round(claudeConf)}% ${claudeDir ? "YES" : "NO"}) disagrees with ML+Stat (${mlDir ? "YES" : "NO"}) — Claude opposition overrides, no bet`,
      ev,
    );
  }

  // WM agreement adds a secondary boost (additive only — WM never vetoes).
  if (inp.wmDriftAbove === direction) {
    confidence += CONFIDENCE_BOOST_PER_SIGNAL;
  }

  const action: BotDecisionAction = direction ? "BET_YES" : "BET_NO";
  const wmPresent   = inp.wmDriftAbove !== null;
  const wmAgrees    = inp.wmDriftAbove === direction;
  const signalsAgreeing = coreAgreeing + (wmAgrees ? 1 : 0);
  const signalsTotal    = 3 + (wmPresent ? 1 : 0);

  if (confidence < inp.minConfidence) {
    return {
      action: "SKIP", confidence,
      reasoning: `Composite confidence ${confidence}% below minimum ${inp.minConfidence}% — ${pathReason}`,
      signalsAgreeing, signalsTotal, ev,
    };
  }

  const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";
  return {
    action, confidence, ev,
    signalsAgreeing, signalsTotal,
    reasoning: `${pathReason}${evDesc} → ${action} (${confidence}%)`,
  };
}

// ---------------------------------------------------------------------------
// Quiet-hours gate (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Returns true if the given UTC hour falls within the quiet-hours window.
 * When start === end, quiet hours are disabled (always returns false).
 * Handles midnight wrap (e.g. start=22, end=6 blocks 22:00–05:59).
 */
export function isInQuietHours(utcHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return utcHour >= start && utcHour < end;
  return utcHour >= start || utcHour < end;
}

// ---------------------------------------------------------------------------
// Circuit-breaker state helpers (pure, testable)
// ---------------------------------------------------------------------------

export interface CircuitBreakerState {
  consecutiveLosses: number;
  circuitBreakerWindowsRemaining: number;
}

/**
 * Returns updated circuit-breaker state after a single bet outcome.
 * A win resets the consecutive-loss streak; a loss increments it and triggers
 * the breaker when maxConsecutiveLosses is first reached.
 *
 * Disable modes:
 *   maxConsecutiveLosses <= 0  → breaker never triggers (streak still tracked)
 *   pauseWindows === 0         → breaker never triggers
 */
export function applyBetOutcome(
  state: CircuitBreakerState,
  won: boolean,
  maxConsecutiveLosses: number,
  pauseWindows: number,
): CircuitBreakerState {
  if (won) {
    return { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };
  }
  const newConsecutive = state.consecutiveLosses + 1;
  const canTrigger = maxConsecutiveLosses > 0 && pauseWindows > 0;
  const shouldTrigger = canTrigger && newConsecutive >= maxConsecutiveLosses;
  return {
    consecutiveLosses: newConsecutive,
    circuitBreakerWindowsRemaining: shouldTrigger
      ? pauseWindows
      : state.circuitBreakerWindowsRemaining,
  };
}

/**
 * Decrements the circuit-breaker window countdown by 1 (clamped at 0).
 * Called once per new 15-minute window when the breaker is active.
 */
export function tickCircuitBreakerWindow(state: CircuitBreakerState): CircuitBreakerState {
  return {
    ...state,
    circuitBreakerWindowsRemaining: Math.max(0, state.circuitBreakerWindowsRemaining - 1),
  };
}

// ---------------------------------------------------------------------------
// Regime detection — momentum / price-trend helpers
// ---------------------------------------------------------------------------

export type PriceRegime = "trending_up" | "trending_down" | "ranging";

/**
 * Derives a simple price regime from a chronological list of recent strike prices.
 * Requires at least 2 data points; returns "ranging" when insufficient data.
 */
export function deriveRegime(recentStrikes: number[], windowCount: number = 3): PriceRegime {
  if (recentStrikes.length < 2) return "ranging";
  const relevant = recentStrikes.slice(-Math.max(2, windowCount));
  let allUp = true;
  let allDown = true;
  for (let i = 1; i < relevant.length; i++) {
    if (relevant[i] <= relevant[i - 1]) allUp = false;
    if (relevant[i] >= relevant[i - 1]) allDown = false;
  }
  if (allUp) return "trending_up";
  if (allDown) return "trending_down";
  return "ranging";
}

/**
 * Returns true when the proposed bet direction is clearly opposed by multi-window
 * momentum — i.e., the price has moved consistently against the bet direction for
 * `windowCount` consecutive windows AND the cumulative move exceeds the threshold.
 */
export function checkMomentumOverride(
  proposedDirection: "yes" | "no",
  recentStrikes: number[],
  cumulativeThresholdPct: number = 0.5,
  windowCount: number = 3,
): boolean {
  if (recentStrikes.length < windowCount + 1) return false;
  const relevant = recentStrikes.slice(-(windowCount + 1));

  let allUp = true;
  let allDown = true;
  for (let i = 1; i < relevant.length; i++) {
    if (relevant[i] <= relevant[i - 1]) allUp = false;
    if (relevant[i] >= relevant[i - 1]) allDown = false;
  }
  if (!allUp && !allDown) return false;

  const oldest = relevant[0];
  const newest = relevant[relevant.length - 1];
  const pctMove = Math.abs((newest - oldest) / oldest * 100);
  if (pctMove < cumulativeThresholdPct) return false;

  if (allUp && proposedDirection === "no") return true;
  if (allDown && proposedDirection === "yes") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Bot configuration types and defaults
//
// Defined here (zero-dependency file) so they can be imported by unit tests
// without pulling in the ./crypto or DB modules.
// ---------------------------------------------------------------------------

export type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous" | "conviction";

export interface BotConfig {
  betSize: number;           // $ per bet (default 0.50)
  dailyLossLimit: number;    // $ max daily loss (default 20)
  signalThreshold: number;   // kept for config compat — not used for entry gating (see core-pair gate)
  minConfidence: number;     // 0-100; skip bet when engine confidence is below this (default 60)
  decisionMode: DecisionMode; // which signal-combination logic to use (default "classic")
  // Per-mode decisionMode preferences — saved when the user changes decisionMode while in
  // a given mode, restored automatically when switching back to that mode.
  paperDecisionMode?: DecisionMode;
  liveDecisionMode?: DecisionMode;
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number; // pp below entry to activate phase 2 (default 30)
  maxEntryMinutes: number;   // ceiling: don't enter after this many minutes into the window; 0 = disabled (no ceiling)
  minRemainingMinutes: number; // floor: don't enter when fewer than this many minutes remain; 0 = disabled (no floor)
  windowEntryBufferSeconds?: number; // seconds to wait at window open before ANY bet fires; 0/undefined = use server default (120)
  minWindowEntryMinutes?: number;     // hard lockout: no bets in the first N minutes of a window; 0/undefined = disabled
  convictionEarlyBypassEnabled?: boolean;   // when true (default), minWindowEntryMinutes is bypassed when yesPrice crosses the extreme threshold; false = timer always respected
  convictionEarlyBypassThreshold?: number;  // YES price threshold for the early bypass (default 0.92); only active when convictionEarlyBypassEnabled=true
  allowLateEntries?: boolean;         // when true, all late-entry time floors are bypassed (only the early-window lockout remains); designed for conviction mode
  kalshiLockPrice?: number;           // conviction only: entry floor (default 0.82; BET fires when Kalshi YES ≥ this value)
  lockPrice091Migrated?: boolean;     // legacy one-time migration marker: 0.90 → 0.91 target bump (superseded)
  lockPrice090Migrated?: boolean;     // one-time startup migration marker: 0.91 → 0.90 target (zone [88¢, 92¢])
  lockPrice093Bootstrap?: boolean;    // one-time startup bootstrap: nudge the old 0.90 default → 0.93 user preference (superseded by 092)
  lockPrice092Bootstrap?: boolean;    // one-time startup bootstrap: 0.93 → 0.92 target (asymmetric zone [90¢, 95¢])
  lockPrice082Migrated?: boolean;     // one-time startup migration: ≥88¢ lockPrice → 0.82 floor + set kalshiLockPriceCap=0.91
  kalshiLockPriceCap?: number;        // conviction only: entry cap (default 0.91; above this the window is missed → SKIP)
  strikeProximityMinPct?: number;     // conviction only: global minimum |cryptoPrice−kalshiStrike|/strike % required before any FOK fires (default 0.30); fail-open when price/strike unavailable
  strikeProximityAtrScale?: boolean;  // when true, effectiveThreshold = strikeProximityMinPct × max(1, atrPct/0.20); scales guard wider for more volatile coins (default true)
  strikeProximityMinPctOverrides?: Record<string, number>; // per-coin override of strikeProximityMinPct; takes priority over global when set; key = symbol (e.g. "BTC")
  convictionStopLossFloor?: number;            // conviction only: absolute contract-value floor (e.g. 0.75 = sell when contract drops to 75¢; skipped if already at/near 0¢; 0 = disabled)
  convictionStopLossActivationMinute?: number; // conviction only: only arm the stop-loss after this many minutes into the window (e.g. 12 = last 3 min); 0 = arm immediately
  convictionEmergencyCloseFloor?: number;      // conviction only: fills ABOVE this value are kept as open positions (stop-loss monitors them); fills BELOW trigger immediate emergency close; default 0.75
  convictionDailyLossLimit?: number;  // conviction only: net daily loss cap in $ before the bot pauses (default 50); overrides dailyLossLimit when in conviction mode
  convictionCatastrophicFillThresholdCents?: number; // conviction only: if fill price deviates MORE than this many cents below lockPrice (YES) or above lockPriceCap (NO), trigger an immediate emergency close instead of holding; default 15¢; set to 0 to always hold
  convictionMinEntryMinutes?: number; // conviction only: min minutes to wait after window open before placing any bet (0 = no minimum, fire as soon as price enters zone; default 0)
  convictionMaxDailySpend?: number;   // conviction only: max gross $ bet per day (sum of all bet amounts regardless of wins); 0/undefined = disabled
  scalePhase?: number;             // scaling phase tracker: 1=test ($3/$6), 2=build ($7/$15), 3=full ($10/$25); default 1
  phaseStartedAt?: string | null;  // ISO timestamp when current phase began; null = track from all-time live bets
  maxBetsPerWindow: number;  // how many separate bets the bot may place per 15-min window (default 3)
  enabled: boolean;          // master kill-switch
  quietHoursStart: number;   // UTC hour (0-23) when quiet period starts — no new entries (default 12)
  quietHoursEnd: number;     // UTC hour (0-23) when quiet period ends (default 18); set equal to start to disable
  maxConsecutiveLosses: number;     // trigger circuit breaker after this many consecutive losses (default 3)
  circuitBreakerPauseWindows: number; // windows to skip after circuit breaker triggers (default 2)
  // Directional balance filter: caps correlated exposure by limiting same-direction
  // bets in one window. Set enableDirectionCap=false or maxSameDirectionBets=0 to disable.
  enableDirectionCap: boolean;   // (default true)
  maxSameDirectionBets: number;  // max YES or NO bets per 15-min window (default 3)
  // Momentum filter: prevents betting against a clear multi-window price trend.
  // Set enableMomentumFilter=false to disable.
  enableMomentumFilter: boolean; // (default true)
  momentumWindowCount: number;   // consecutive windows required to trigger (default 3)
  // Self-learning auto-tune: when enabled the bot periodically analyses its own
  // recent performance and applies safe parameter adjustments automatically.
  enableAutoTuning: boolean;     // (default true)
  autoTuneWindowSize: number;    // number of most-recent settled bets to analyse (default 100)
  // Temporary confidence raise tracking: when auto-tune raises minConfidence it stores
  // the revert windowKey and the original value here. The bot loop checks these each
  // window-open and restores minConfidence when the windowKey is reached.
  autoTuneConfidenceRevertAt: string | null;  // windowKey to revert at (null = no pending revert)
  autoTuneConfidenceRevertTo: number | null;  // value to restore (null = no pending revert)
  // Border-proximity guard: skip bets when price has been hovering too close to the
  // Kalshi strike in recent settled windows (high-noise, near-50/50 outcome territory).
  enableBorderGuard: boolean;    // (default true)
  borderProximityPct: number;    // skip if avg |closePrice−strike|/strike < this % (default 0.3)
  borderLookbackBets: number;    // how many most-recent settled bets to examine per coin (default 3)
  // Regime filter: how many confidence-points to deduct when the bot would bet
  // against the recent settlement direction. Set to 0 to disable the penalty entirely.
  regimePenalty: number;         // pp deducted for against-regime bets (default 8)
  // ML Gate soft veto: in ml_gate mode, only apply the ML veto when ML is at
  // least this confident in the opposing direction. When ML confidence is below
  // this threshold the bet proceeds as if ML were unavailable — avoiding hard
  // blocks from near-coin-flip ML uncertainty. Range 50–70 (default 57).
  mlVetoMinConfidence: number;
  // Bet aggression profile — "normal" uses proven defaults; "aggressive" lowers
  // the ML-lead threshold and caps effective confidence at 80%.
  betProfile: BetProfile;
  // Paper trading simulation parameters (only used in paper mode).
  // paperStartingBalance: the wallet amount before any bets are counted.
  // paperWinReturnRate: profit as a fraction of betSize on a winning bet (0.5 = +50¢ per $1 bet).
  // paperBalanceResetAt: ISO timestamp of the last manual wallet reset; bets before this are ignored.
  paperStartingBalance: number;  // (default 100)
  paperWinReturnRate: number;    // (default 0.5)
  paperBalanceResetAt: string | null; // (default null = count all bets)
  // liveStatsResetAt / paperStatsResetAt: ISO timestamps for a visual-only stats
  // reset.  All display queries (win/loss %, profit, history, performance report,
  // logic-mode performance) filter to bets placed *after* this timestamp.  Zero
  // rows are deleted; the underlying data is fully preserved for ML training and
  // auto-tune learning.
  liveStatsResetAt: string | null;  // (default null = show all live bets)
  paperStatsResetAt: string | null; // (default null = show all paper bets)
  // Hard cap on the dollar amount of any single bet.  If the computed betAmount
  // would exceed this value the entire trade is aborted and an error is logged.
  // Acts as a safety rail so a misconfigured betSize can never send an outsized
  // order to Kalshi.  The default is intentionally conservative ($2) and should
  // be raised only after deliberate review.  Applies in both paper and live mode.
  maxBetSize: number;            // (default 2.00)

  // ── Live-mode safety guards ─────────────────────────────────────────────
  // These guards are checked before every live bet entry.

  // Minimum Kalshi available balance required to place any live bet.  If the
  // real account balance drops below this the trade is aborted and logged as an
  // error.  Prevents the bot from betting on a nearly-empty account.
  minAccountBalance: number;     // $ (default 5.00)

  // Maximum simultaneous open-position dollar exposure.  The bot will not open
  // a new position if (sum of all open betAmounts + newBetAmount) would exceed
  // this cap.  Guards against many concurrent positions draining the account.
  maxTotalExposure: number;      // $ (default 5.00)

  // Per-coin daily loss cap.  If a coin's cumulative settled losses for the
  // current UTC day (in the current mode) reach or exceed this, that coin is
  // skipped for the rest of the day regardless of model signals.
  maxDailyLossPerCoin: number;   // $ (default 3.00)

  // Number of consecutive windows a coin must lose before it is briefly paused.
  // Set to 0 to disable this guard entirely.
  coinStreakLossLimit: number;   // (default 3)

  // How many additional 15-min windows a coin is paused after hitting the streak
  // loss limit.  The coin resumes when the pause window key expires.
  coinStreakPauseWindows: number; // (default 2)

  // Slippage guard: if a live fill price differs from the expected yes-price by
  // more than this many cents, it is logged as a strike.  Three strikes within
  // the same window will skip that coin for one window.  Set to 0 to disable.
  maxSlippageCents: number;      // ¢ (default 5)

  // Minimum return (payout) multiple guard: skip any bet whose payout multiple
  // (1 / contract-cost) is below this floor. A contract costing `cost` pays $1,
  // so return = 1/cost.  1.7 → only enter when cost ≤ ~59¢.  Set to 1 to
  // disable (any cost allowed).
  minReturnMultiple: number;     // × (default 1.45)

  // Minimum minutes elapsed before allowing a NO-direction bet.  At minute 0
  // the orderbook is freshly priced and our signals have less edge on NO bets
  // (53% WR at minute 0 vs 79% at minute 1+, observed in live data).  YES bets
  // are excluded from this gate — they won at every entry time.
  // Set to 0 to disable (allow NO bets at any minute).
  minNoEntryMinutes: number;     // minutes (default 1)

  // Delayed entry with fresh re-analysis: when > 0, the bot holds off placing
  // any bet until this many minutes have elapsed since window-open.  Unlike
  // minNoEntryMinutes (which only defers NO bets, no re-analysis), betDelayMinutes
  // applies to BOTH YES and NO, and automatically triggers a fresh Claude + stat
  // re-check immediately before the entry fires so the bot acts on updated
  // signals — not the opening snapshot.
  // 0 = disabled (enter immediately when all signals are ready).
  betDelayMinutes?: number;      // minutes (default 0 = disabled)

  // Window Monitor readiness gate: when true, the bot skips entry for a coin
  // until the Window Monitor has collected ≥2 minutes of intra-window data
  // (or ≥5 min on the fallback path without pre-window ER).  This is a
  // per-tick defer — the coin is re-evaluated on the next 60-second tick, not
  // blocked for the whole window.  Set to false to allow immediate entry.
  // Recommended: true — data shows 78% win rate when monitor is ready vs 64% when not.
  requireMonitorReady: boolean;  // (default true)

  // ── Confidence-based dynamic bet sizing ─────────────────────────────────
  // When enabled, the bet size scales linearly with the engine's confidence:
  // at minConfidence the bot bets `betSize` (the minimum), and at
  // `dynamicSizingMaxConfidence` (or higher) it bets `maxBetSize` (the
  // maximum). Confidences in between are interpolated. When disabled the bot
  // always bets `betSize` (identical to legacy behavior). The hard maxBetSize
  // safety cap still applies as a guard regardless of this setting.
  enableDynamicSizing: boolean;        // (default false)
  dynamicSizingMaxConfidence: number;  // confidence at which max bet is reached (default 85)
  profitLockPct: number;               // 0 = disabled; 1–99 = cash out when current value reaches this % of max payout
  minHoldMinutes: number;              // min minutes to hold before ANY exit is evaluated (default 4); 0 = disabled
  enableMidExit: boolean;              // master switch for mid-window cashout/exit system (default false = disabled)
  enableTimeStop?: boolean;            // when true, also exit losing positions with <2 min left regardless of mid-exit sensitivity (default false)

  // ── Free-run mode ────────────────────────────────────────────────────────
  // When true, all restriction layers are bypassed so the bot places any bet
  // the models decide — no penalties, no proximity/oscillation gates, no
  // direction cap, no quiet hours, no chop filter, no streak pauses.
  // Safety rails that are NEVER bypassed: circuit breaker, daily loss limit,
  // max bets per window, and the ML-Claude alignment gate.
  freeRunMode?: boolean;               // (default false)

  // Market consensus gate: skip when the Kalshi market prices the bet outcome
  // below this implied probability (in whole cents). A YES ask < consensusMinCents¢
  // means ≥(100−X)% of the market expects NO — don't bet YES against that consensus.
  // Symmetric: YES ask > (100 − consensusMinCents)¢ blocks NO bets.
  // Default 25 = "never bet against 3:1 market odds." Set to 0 to disable.
  consensusMinCents: number;           // ¢ (default 25)

  // Candle momentum lookback window in 1-min candles for the reversal guard.
  // Extended from legacy 4 to catch medium-duration drops (5–8 min) that leave
  // recent candles oscillating at the low without a clear 4-candle slope.
  momentumLookbackCandles: number;     // candles (default 8)

  // Per-coin ML confidence overrides for Path A (ML primary).
  // Key = symbol uppercase (e.g. "ETH"). Value = minimum ML confidence % to
  // qualify ML as the lead signal for that coin, overriding the global
  // ML_PRIMARY_MIN_CONFIDENCE constant.  Missing keys use the global default.
  // Default: lower thresholds for ETH/XRP/SOL whose ML accuracy sits at
  // 59–60 %, just below the global 62 % gate.
  mlPrimaryMinConfidenceOverrides?: Record<string, number>;
  // Per-coin streak confidence penalty: applied when a coin has consecutive losses
  // but is NOT yet on full pause (coinStreakPauseWindows). Raises the effective
  // confidence floor for that coin only without fully blocking it.
  coinStreakPenalty1LossPp?: number;    // pp added when coin has exactly 1 consecutive loss (default 6)
  coinStreakPenalty2PlusLossPp?: number; // pp added when coin has ≥2 consecutive losses (default 12)
  // Unanimous model floor: minimum per-model confidence for Path A (all-three-agree)
  // bypass to apply. If any model is below this floor, Gate 2 per-signal floors run
  // instead. Set to 0 to disable.
  unanimousMinModelConfidence?: number; // (default 57)
  // Directional regime dampener: tracks YES / NO win rates over recent completed
  // windows. If a direction's win rate falls below directionalRegressionThreshold
  // over directionalRegressionLookback windows (with ≥2 bets in that direction),
  // add directionalRegressionPenaltyPp to the confidence floor for that direction.
  directionalRegressionLookback?: number;    // windows to inspect (default 3)
  directionalRegressionThreshold?: number;   // win rate floor; below this fires the penalty (default 0.35)
  directionalRegressionPenaltyPp?: number;   // pp penalty (default 10)

  priceBufferPct?: number;                   // % (default 0 = disabled)

  // ── Entry proximity guard ─────────────────────────────────────────────────
  // Mode-agnostic gate: skip entry when the live crypto price is within
  // `threshold`% of the Kalshi strike price.  In coin-flip territory the bot
  // has no real edge regardless of model signals.
  //
  // Two phases split by minutesRemaining vs. proximityLateWindowMinutes:
  //   Early phase  — first (15 − lateWindow) minutes of the window.
  //   Late phase   — final lateWindow minutes (price tends to converge here).
  //
  // Per-coin overrides (Record<symbol, %>) replace the global default for
  // that coin.  0 = disabled for that phase (no proximity gate).
  proximityGuardEnabled?: boolean;           // master toggle (default false)
  proximityEarlyPct?: number;               // % distance required during early phase (default 0)
  proximityLatePct?: number;                // % distance required during late phase (default 0)
  proximityLateWindowMinutes?: number;      // minutes remaining when late phase starts (default 7)
  proximityEarlyPctOverrides?: Record<string, number>; // per-coin early-phase %
  proximityLatePctOverrides?: Record<string, number>;  // per-coin late-phase %
  coinOverrides?: Record<string, { paused?: boolean; maxBetSize?: number }>;  // per-coin manual pause + bet cap
  convictionBoostBetSize?: number;       // conviction only: boosted bet size for stable coins (undefined/0 = disabled)
  convictionBoostProbability?: number;   // fraction of windows randomly chosen for boost, 0–1 (default 0.25)
  convictionBoostMinWinRate?: number;    // minimum conviction win rate for a coin to qualify for boost, 0–1 (default 0.70)
  statRegimeBoostEnabled?: boolean;      // use max bet size only when stat model confirms stable/trending price action
  statRegimeBoostMinER?: number;         // min efficiency ratio to qualify (0–1, default 0.40); 1=clean trend, 0=pure chop
  statRegimeBoostMaxOscillations?: number; // max direction reversals in last 15 min to qualify (default 6)
  // Conviction stability gate (replaces random roll when enabled)
  convictionStabilityEnabled?: boolean;                // when true: stable→max bet, volatile→regular bet (default true)
  convictionStabilityMinER?: number;                   // min efficiency ratio to classify stable (default 0.12)
  convictionStabilityMaxOsc?: number;                  // max oscillations to classify stable (default 8)
  convictionStabilityMaxVolPct?: number;               // max volatilityPct to classify stable (default 0.15)
  convictionStabilityMinMLConf?: number;               // min ML confidence to classify stable; null ML = passes (default 52)
  convictionStabilityMaxBetProbability?: number;        // 0–1: probability that a stable coin gets max bet size on each entry (default 0.25)
  convictionStabilityMaxBetsPerWindow?: number;         // how many max-bet slots are available per window when the roll hits (default 1)
  maxBetMinWindowEntryMinutes?: number;                 // minutes into window before a max-size bet may fire (0 = disabled, default 0)
  // Trajectory gate: blocks max bets when the underlying price is trending dangerously close to the target
  maxBetTrajectoryEnabled?: boolean;               // master toggle for max bets (default true)
  regularBetTrajectoryEnabled?: boolean;           // master toggle for regular bets (default false)
  maxBetTrajectoryLookbackMinutes?: number;        // how many 1-min candles to look back for velocity (default 3)
  maxBetTrajectoryFinalMinutes?: number;           // gate only activates in final N minutes of window (default 5)
  maxBetTrajectoryBlockOnCross?: boolean;          // block when momentum projects price to cross the target (default true)
  maxBetTrajectoryMinVelocityATR?: number;         // min velocity to trigger gate, in ATR/min units (default 0 = any projected cross)
  // Legacy fields kept for DB compat — no longer used in gate logic
  maxBetTrajectoryCurrentMarginMinPct?: number;
  maxBetTrajectoryCurrentMarginMinATR?: number;
  maxBetTrajectoryDangerBandPct?: number;
  maxBetTrajectoryDangerBandATR?: number;
  maxBetTrajectoryAdverseVelocityOnly?: boolean;
  maxBetTrajectoryTimeWeightEnabled?: boolean;
  regularBetTrajectoryDangerBandPct?: number;
  regularBetTrajectoryDangerBandATR?: number;
  // Conviction adverse momentum gate — active throughout the window (not just final N minutes)
  convictionMomentumGateEnabled?: boolean;    // master toggle (default false)
  convictionMomentumLookbackMinutes?: number; // velocity lookback in 1-min candles (default 3)
  convictionMomentumSafetyFactor?: number;    // block if time-to-cross < remaining × factor (default 0.6)

  // ── Extreme Caution mode (conviction only) ────────────────────────────────
  // When enabled: (1) if a YES conviction bet was aborted this window because
  // the YES bid was below the zone floor, all further YES entries for that
  // coin+window are blocked — no re-tries after a bid-below-floor abort; and
  // (2) the NO cross-check uses zero tolerance (no +1¢ spread allowance).
  // Optional betOverride: when > 0, uses this $ amount instead of the normal
  // bet size for ALL conviction entries while extreme caution is active.
  extremeCautionEnabled?: boolean;         // master toggle (default false)
  extremeCautionBetOverride?: number | null; // $ override; 0/null/undefined = use normal sizing

  // ── Time-Based Bet Schedule ───────────────────────────────────────────────
  // When enabled, the bet size is overridden by the first matching bracket
  // where minutesElapsed ≤ current window-elapsed minutes.  Brackets are
  // evaluated highest-to-lowest so the most specific match wins.  Falls
  // through to normal sizing when no bracket matches.  Overridden by
  // extremeCautionBetOverride when both features are enabled.
  timeBetScheduleEnabled?: boolean;
  timeBetSchedule?: Array<{ minutesElapsed: number; betAmount: number }>;

  // ── Bet Amount Randomizer ─────────────────────────────────────────────────
  // When enabled, each bet independently picks a random dollar amount from
  // betRandomizerValues.  Overrides all other sizing (betSize, maxBetSize,
  // conviction boost, stat regime boost, time-schedule, extreme caution), but
  // is still clamped by the per-coin maxBetSize in coinOverrides (if set).
  // Requires ≥ 2 values in betRandomizerValues to activate.
  betRandomizerEnabled?: boolean;
  betRandomizerValues?: number[];
}

// ---------------------------------------------------------------------------
// Live-mode environment guards (pure — no I/O, fully testable)
// ---------------------------------------------------------------------------

/**
 * Returns true only when the provided NODE_ENV value is "production".
 * Used by setBotMode and the POST /crypto/bot/mode route to block live-betting
 * in development/staging environments before any I/O takes place.
 */
export function isLiveModePermitted(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

/**
 * assertSetBotModeAllowed — the complete guard logic of setBotMode, extracted
 * for unit testing.  The real setBotMode calls this function before touching
 * any I/O, so testing this function IS testing the real setBotMode guard.
 *
 * Throws an Error if the mode transition is not allowed:
 *   - Live mode is only allowed in production (env guard).
 *   - Live mode requires KALSHI_API_KEY to be configured (config guard).
 */
export function assertSetBotModeAllowed(
  mode: string,
  nodeEnv: string | undefined,
  kalshiConfigured: boolean,
): void {
  if (mode === "live" && !isLiveModePermitted(nodeEnv)) {
    throw new Error("Live betting is only available in the production deployment.");
  }
  if (mode === "live" && !kalshiConfigured) {
    throw new Error("KALSHI_API_KEY not configured — cannot enable live mode");
  }
}

/**
 * Given a mode read from the DB on startup and the current NODE_ENV, returns
 * the effective mode the server should use.  A persisted "live" row is silently
 * downgraded to "paper" in any non-production environment so that developers
 * running against a shared DB never accidentally enter live-betting mode.
 */
export function resolveStartupMode(
  savedMode: "paper" | "live",
  nodeEnv: string | undefined,
): "paper" | "live" {
  if (savedMode === "live" && !isLiveModePermitted(nodeEnv)) {
    return "paper";
  }
  return savedMode;
}

/**
 * applyStartupModeRestore — the startup restore logic of loadBotConfigFromDB,
 * extracted for unit testing.  Returns the effective mode and a flag indicating
 * whether a downgrade occurred (which triggers a DB re-persist to paper).
 */
export function applyStartupModeRestore(
  savedMode: "paper" | "live",
  nodeEnv: string | undefined,
): { effective: "paper" | "live"; didDowngrade: boolean } {
  const effective = resolveStartupMode(savedMode, nodeEnv);
  return { effective, didDowngrade: effective !== savedMode };
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  betSize: 1.00,
  dailyLossLimit: 20,
  signalThreshold: 2,    // legacy field — core-pair gate now governs entry
  minConfidence: 70,
  decisionMode: "classic",
  midExitSensitivity: "balanced",
  phase2ThresholdPp: 30,
  // Ceiling: 0 = disabled (no ceiling — enter at any point in the window).
  maxEntryMinutes: 0,
  // Floor: skip entry when fewer than 2 minutes remain in the 15-min window.
  // 0 = disabled.
  minRemainingMinutes: 2,
  // Window-open entry buffer: hold off all bets for this many seconds after a new
  // window starts so the stat model can snap against the new Kalshi target and
  // Claude's opening call can resolve.  Config-driven so it can be changed live.
  // 0/undefined in DB → uses this default of 60 s (1 tracker snap cycle).
  windowEntryBufferSeconds: 60,
  convictionEarlyBypassEnabled: true,
  convictionEarlyBypassThreshold: 0.92,
  // Allow up to 7 bets per window (matches 7-coin training set: BTC/ETH/XRP/HYPE/BNB/SOL/DOGE).
  maxBetsPerWindow: 7,
  enabled: true,
  // start === end → disabled; 7 = 07:00 UTC stored value (set equal to disable)
  quietHoursStart: 7,
  quietHoursEnd: 7,
  // 0 = disabled (no circuit breaker on consecutive losses)
  maxConsecutiveLosses: 0,
  circuitBreakerPauseWindows: 2,
  enableDirectionCap: true,
  maxSameDirectionBets: 2,
  enableMomentumFilter: true,
  momentumWindowCount: 3,
  enableAutoTuning: true,
  autoTuneWindowSize: 100,
  autoTuneConfidenceRevertAt: null,
  autoTuneConfidenceRevertTo: null,
  // Border guard enabled by default — DOGE and similar low-volatility coins hover
  // near the strike and produce near-50/50 outcomes; 3% threshold captures those cases.
  enableBorderGuard: true,
  borderProximityPct: 3.0,
  borderLookbackBets: 3,
  // Regime penalty: 0 — each 15-min window is independent; YES/NO equally valid
  regimePenalty: 0,
  // ML Gate soft veto: only veto when ML is ≥57% confident in opposition.
  // Values 50-70; 50 = always veto on any disagreement (original hard veto).
  mlVetoMinConfidence: 57,
  betProfile: "normal",
  // Paper trading defaults
  paperStartingBalance: 100,
  paperWinReturnRate: 0.50,
  paperBalanceResetAt: null,
  liveStatsResetAt: null,
  paperStatsResetAt: null,
  // Safety cap: hard-abort any bet whose computed dollar cost exceeds this.
  // Conservative default; raise deliberately when going live.
  maxBetSize: 2.00,

  // Live-mode safety guards — conservative defaults for first live sessions.
  minAccountBalance: 5.00,
  maxTotalExposure: 5.00,
  maxDailyLossPerCoin: 3.00,
  coinStreakLossLimit: 3,
  coinStreakPauseWindows: 2,
  maxSlippageCents: 10,
  minReturnMultiple: 1.45,
  minNoEntryMinutes: 1,
  betDelayMinutes: 0,
  requireMonitorReady: true,
  // Confidence-based dynamic bet sizing — disabled by default (legacy behavior).
  enableDynamicSizing: false,
  dynamicSizingMaxConfidence: 90,
  profitLockPct: 0,
  convictionStopLossFloor: 0.75,
  convictionStopLossActivationMinute: 0,
  convictionEmergencyCloseFloor: 0.75,
  convictionDailyLossLimit: 50,
  convictionCatastrophicFillThresholdCents: 15,
  convictionMinEntryMinutes: 0,
  scalePhase: 1,
  phaseStartedAt: null,
  convictionMaxDailySpend: undefined,
  convictionBoostBetSize: undefined,
  convictionBoostProbability: 0.25,
  convictionBoostMinWinRate: 0.70,
  statRegimeBoostEnabled: false,
  statRegimeBoostMinER: 0.40,
  statRegimeBoostMaxOscillations: 6,
  convictionStabilityEnabled: true,
  // Conservative empirical baselines — set from first-principles until enough
  // conviction bet history accumulates (≥50 settled bets recommended).
  // Use GET /crypto/bot/conviction-stability-analysis to compute win-rate-maximising
  // thresholds from real bet outcomes and update these defaults accordingly.
  convictionStabilityMinER: 0.12,
  convictionStabilityMaxOsc: 8,
  convictionStabilityMaxVolPct: 0.15,
  convictionStabilityMinMLConf: 52,
  convictionStabilityMaxBetProbability: 0.25,
  convictionStabilityMaxBetsPerWindow: 1,
  maxBetTrajectoryEnabled: true,
  regularBetTrajectoryEnabled: false,
  maxBetTrajectoryLookbackMinutes: 3,
  maxBetTrajectoryFinalMinutes: 5,
  maxBetTrajectoryBlockOnCross: true,
  maxBetTrajectoryMinVelocityATR: 0,
  strikeProximityMinPct: 0.30,
  strikeProximityAtrScale: true,
  strikeProximityMinPctOverrides: {},
  convictionMomentumGateEnabled: false,
  convictionMomentumLookbackMinutes: 3,
  convictionMomentumSafetyFactor: 0.6,
  minHoldMinutes: 4,
  enableMidExit: false,
  enableTimeStop: false,
  freeRunMode: false,
  consensusMinCents: 25,
  momentumLookbackCandles: 8,
  // SOL/DOGE/XRP ML accuracy sits at ~59-60%, just under the global 65% gate.
  // Lower per-coin floors so they qualify for PATH A at their realistic confidence range.
  mlPrimaryMinConfidenceOverrides: { SOL: 60, DOGE: 62, XRP: 60 },
  // Loss-learning adaptive filters (Task #338)
  coinStreakPenalty1LossPp: 6,
  coinStreakPenalty2PlusLossPp: 12,
  unanimousMinModelConfidence: 57,
  directionalRegressionLookback: 3,
  directionalRegressionThreshold: 0.35,
  directionalRegressionPenaltyPp: 10,
  priceBufferPct: 0,
  // Entry proximity guard — disabled by default; enable and calibrate via the bot config UI.
  proximityGuardEnabled: false,
  proximityEarlyPct: 0,
  proximityLatePct: 0,
  proximityLateWindowMinutes: 7,
  proximityEarlyPctOverrides: {},
  proximityLatePctOverrides: {},
  coinOverrides: {},
  betRandomizerEnabled: false,
  betRandomizerValues: [],
};

/**
 * applyLockPrice090Migration — one-time conviction-target migration to 0.90.
 *
 * Pure config transform (mutates the passed config in place) so it can be
 * unit-tested without a DB. Called once per startup by loadBotConfigFromDB.
 *
 * Semantics:
 *   1. Conviction config with kalshiLockPrice == null → backfill 0.90.
 *   2. Legacy stored 0.91 (from the superseded 0.90→0.91 migration) with the
 *      migration flag unset → move to 0.90, exactly once.
 *   3. ANY config evaluated without the flag set gets the flag set, even when
 *      no value change is needed. This makes the migration truly one-time:
 *      a user who later deliberately sets 0.91 via the UI will never be
 *      auto-reverted on restart, because the flag is already present.
 *
 * Returns { changed, migrated }:
 *   changed  — config was mutated and should be persisted to the DB
 *   migrated — the 0.91 → 0.90 value migration actually ran (worth logging)
 */
export function applyLockPrice090Migration(
  config: BotConfig,
): { changed: boolean; migrated: boolean } {
  if (config.decisionMode === "conviction" && config.kalshiLockPrice == null) {
    config.kalshiLockPrice = 0.90;
    config.lockPrice090Migrated = true;
    return { changed: true, migrated: false };
  }
  if (!config.lockPrice090Migrated) {
    const migrated = config.kalshiLockPrice === 0.91;
    if (migrated) config.kalshiLockPrice = 0.90;
    config.lockPrice090Migrated = true;
    return { changed: true, migrated };
  }
  return { changed: false, migrated: false };
}

/**
 * applyLockPrice093Bootstrap — one-time startup migration that nudges the
 * conviction kalshiLockPrice from the old hard-coded default of 0.90 to the
 * user's preferred 0.93 target (zone [91¢, 95¢]).
 *
 * Only fires once (guarded by lockPrice093Bootstrap flag).  Only changes the
 * value when it is exactly at the old default (0.90) so a user who has
 * deliberately set a different value is never silently overridden.
 */
export function applyLockPrice093Bootstrap(
  config: BotConfig,
): { changed: boolean; bumped: boolean } {
  if (config.lockPrice093Bootstrap) return { changed: false, bumped: false };
  const bumped = config.kalshiLockPrice === 0.90;
  if (bumped) config.kalshiLockPrice = 0.93;
  config.lockPrice093Bootstrap = true;
  return { changed: true, bumped };
}

/**
 * deriveConvictionZone — single source of truth for the conviction entry zone.
 *
 * Two calling conventions:
 *
 *   1. Legacy single-target (no cap): floor = target − 2¢, cap = target + 3¢.
 *      Used by unit tests and any caller that only has a single target value.
 *
 *   2. Independent floor + cap (capOverride provided): the caller passes the
 *      floor directly as `target` and the cap as `capOverride`.  Both are used
 *      verbatim — no formula applied.  This is the new default since the entry
 *      zone widened to 82¢–91¢ (floor and cap are independently configurable).
 *
 * Every zone consumer (engine decision, tick live-price gate, conviction
 * poller, emergency-close check) MUST derive its bounds through this helper
 * so the layers can never drift apart again.
 */
export function deriveConvictionZone(target: number, capOverride?: number): {
  lockPrice: number;
  lockPriceCap: number;
} {
  if (capOverride != null) {
    // Independent-fields mode: target IS the floor; capOverride IS the cap.
    return {
      lockPrice:    +target.toFixed(4),
      lockPriceCap: +capOverride.toFixed(4),
    };
  }
  // Legacy single-target formula: floor = target−2¢, cap = target+3¢.
  return {
    lockPrice:    +(target - 0.02).toFixed(4),
    lockPriceCap: +(target + 0.03).toFixed(4),
  };
}

/**
 * computeAdverseMomentumGate — pure, export for testing.
 *
 * Decides whether the adverse momentum gate should block a conviction entry.
 * Math: time-to-cross = currentMarginDollars / |velocity|
 *       block if time-to-cross < minutesRemaining × safetyFactor
 *
 * Returns { blocked, timeToCrossMin }.
 *  - blocked=false when: gate disabled, velocity is NOT adverse, margin ≤ 0,
 *    velocity=0, or time-to-cross ≥ threshold.
 *  - blocked=true when adverse momentum is steep enough to cross the strike
 *    before window close (adjusted by safetyFactor).
 */
export function computeAdverseMomentumGate(opts: {
  livePrice: number;
  kalshiTarget: number;
  direction: "yes" | "no";
  velocityPerMin: number;   // $/min, positive = rising
  minutesRemaining: number;
  safetyFactor?: number;    // default 0.6
  enabled?: boolean;        // default true
}): { blocked: boolean; timeToCrossMin: number } {
  const { livePrice, kalshiTarget, direction, velocityPerMin, minutesRemaining, safetyFactor = 0.6, enabled = true } = opts;
  if (!enabled) return { blocked: false, timeToCrossMin: Infinity };
  // Adverse = price moving TOWARD the strike
  const adverseVelocity = direction === "yes" ? velocityPerMin <= 0 : velocityPerMin >= 0;
  if (!adverseVelocity || minutesRemaining <= 0) return { blocked: false, timeToCrossMin: Infinity };
  // currentMarginDollars: distance from the live price to the strike in the favorable direction
  const currentMarginDollars = direction === "yes" ? livePrice - kalshiTarget : kalshiTarget - livePrice;
  if (currentMarginDollars <= 0) return { blocked: false, timeToCrossMin: Infinity };
  const absVel = Math.abs(velocityPerMin);
  const timeToCrossMin = absVel > 0 ? currentMarginDollars / absVel : Infinity;
  const threshold = minutesRemaining * safetyFactor;
  return { blocked: timeToCrossMin < threshold, timeToCrossMin };
}

/**
 * applyLockPrice092Bootstrap — one-time startup bootstrap that moves the
 * conviction target from 0.93 to the user's updated preference of 0.92
 * (asymmetric zone [90¢, 95¢] via deriveConvictionZone).
 *
 * Only fires once (guarded by lockPrice092Bootstrap flag).  Only changes the
 * value when it is exactly 0.93 (the previous bootstrap value) so a user who
 * has deliberately set a different value is never silently overridden.
 */
export function applyLockPrice092Bootstrap(
  config: BotConfig,
): { changed: boolean; bumped: boolean } {
  if (config.lockPrice092Bootstrap) return { changed: false, bumped: false };
  const bumped = config.kalshiLockPrice === 0.93;
  if (bumped) config.kalshiLockPrice = 0.92;
  config.lockPrice092Bootstrap = true;
  return { changed: true, bumped };
}

/**
 * applyLockPrice082Migration — one-time startup migration that widens the
 * conviction entry zone to 82¢–91¢ (independent floor + cap fields).
 *
 * Pure config transform (mutates the passed config in place) so it can be
 * unit-tested without a DB. Called once per startup by loadBotConfigFromDB.
 *
 * Semantics:
 *   1. If kalshiLockPrice >= 0.88 (old "target" semantics), reset to 0.82
 *      (new floor semantics) — this converts the old high-target config to the
 *      new wider entry zone.
 *   2. If kalshiLockPriceCap is not set, bootstrap it to 0.91 (the cap).
 *   3. Mark the migration as done so it never fires again.
 */
export function applyLockPrice082Migration(
  config: BotConfig,
): { changed: boolean; migrated: boolean } {
  if (config.lockPrice082Migrated) return { changed: false, migrated: false };
  const migrated = config.kalshiLockPrice != null && config.kalshiLockPrice >= 0.88;
  if (migrated) config.kalshiLockPrice = 0.82;
  if (config.kalshiLockPriceCap == null) config.kalshiLockPriceCap = 0.91;
  config.lockPrice082Migrated = true;
  return { changed: true, migrated };
}

/**
 * Per-coin baseline suggestions for strikeProximityMinPct.
 * Derived from typical 15-min ATR profiles and Kalshi orderbook depth.
 * These are defaults the UI surfaces to the user — they are NOT applied automatically.
 * Lower values = more bets allowed near the strike; calibrate per observed behavior.
 */
export const PROXIMITY_THRESHOLD_SUGGESTIONS: Record<string, number> = {
  BTC:  0.10,   // Deep Kalshi orderbook, tight crypto spreads, lowest intra-window ATR
  ETH:  0.12,   // Very liquid, slightly higher 15-min ATR than BTC
  XRP:  0.15,   // Liquid on Kalshi, moderate short-term vol
  BNB:  0.15,   // Similar profile to XRP
  SOL:  0.18,   // Higher intra-window ATR than BTC/ETH/XRP
  DOGE: 0.20,   // Moderate-high vol, shallow Kalshi orderbook vs BTC
  NEAR: 0.22,   // Lower Kalshi liquidity, wider tick spreads
  HYPE: 0.25,   // Newer market, lower liquidity, spiky short-term moves
  ZEC:  0.28,   // Lowest Kalshi liquidity among traded coins; wide spread at entry
};

/**
 * Returns the effective strike-proximity threshold for a specific symbol.
 * Per-coin override in strikeProximityMinPctOverrides takes priority over the
 * global strikeProximityMinPct.  Falls back to 0.30% when neither is set.
 */
export function getEffectiveProximityThreshold(sym: string, config: BotConfig): number {
  const override = config.strikeProximityMinPctOverrides?.[sym];
  if (override != null && override > 0) return override;
  return config.strikeProximityMinPct ?? 0.30;
}

/**
 * computeStrikeProximityGate — pure, exported for testing.
 *
 * Before a conviction FOK fires, verify the live crypto price is far enough
 * from the Kalshi strike.  At 82¢ (the new entry floor) a coin can be just
 * a fraction of a percent above the strike — a single adverse candle can flip
 * the outcome.  This gate enforces a minimum distance.
 *
 * Gate is FAIL-OPEN: if livePrice or kalshiStrike is unavailable (null/zero)
 * the gate passes so the bot never silently blocks entries due to missing data.
 *
 * ATR scaling (when atrScaleEnabled=true):
 *   effectiveThreshold = thresholdPct × max(1, atrPct / 0.20)
 *   — coins with higher volatility (atrPct > 0.20%) need a wider gap to be safe.
 *   — reference baseline 0.20% is ≈ BTC quiet-session volatility.
 */
export interface StrikeProximityResult {
  blocked: boolean;
  gapPct: number | null;           // null when livePrice or kalshiStrike unavailable (gate passes)
  effectiveThreshold: number;      // threshold used for this evaluation (may be ATR-scaled)
}

export function computeStrikeProximityGate(opts: {
  livePrice: number | null;
  kalshiStrike: number | null;
  direction: "yes" | "no";
  thresholdPct: number;
  atrPct?: number | null;
  atrScaleEnabled?: boolean;
}): StrikeProximityResult {
  const { livePrice, kalshiStrike, thresholdPct, atrPct, atrScaleEnabled = true } = opts;

  // Fail-open: unavailable data must never block a bet silently.
  if (!livePrice || !kalshiStrike || kalshiStrike <= 0) {
    return { blocked: false, gapPct: null, effectiveThreshold: thresholdPct };
  }

  const gapPct = Math.abs(livePrice - kalshiStrike) / kalshiStrike * 100;

  const atrMultiplier = atrScaleEnabled && atrPct != null && atrPct > 0
    ? Math.max(1, atrPct / 0.20)
    : 1;
  const effectiveThreshold = thresholdPct * atrMultiplier;

  return { blocked: gapPct < effectiveThreshold, gapPct, effectiveThreshold };
}

/**
 * computeKellyMultiplier — per-position Kelly fraction for a YES or NO bet.
 *
 * Returns a value in [0, 1] that represents the fractional edge of the bet at
 * the given market price, using the standard Kelly criterion formula:
 *
 *   Kelly = (p − q) / odds
 *
 * where:
 *   p    = confidence / 100   (our estimated probability of winning)
 *   q    = 1 − p
 *   odds = net payout per unit wagered
 *          YES: (1 − yesPrice) / yesPrice
 *          NO:  yesPrice / (1 − yesPrice)
 *
 * A YES at 0.70 has much higher odds than a YES at 0.52 for the same
 * confidence, so the Kelly fraction is correspondingly larger and the final
 * bet is scaled up relative to a thin-edge position.
 *
 * The result is clamped to [0, 1]: negative fractions (confidence < 50%, no
 * edge) become 0; fractions above 1 (massive edge) are treated as "full size"
 * to avoid going over-Kelly.  Degenerate prices (0 or 1) return 1 as a safe
 * neutral fallback.
 */
export function computeKellyMultiplier(
  confidence: number,
  yesPrice: number,
  direction: "yes" | "no",
): number {
  if (!Number.isFinite(yesPrice) || yesPrice <= 0 || yesPrice >= 1) return 1;

  const p = confidence / 100;
  const q = 1 - p;

  const odds =
    direction === "yes"
      ? (1 - yesPrice) / yesPrice
      : yesPrice / (1 - yesPrice);

  if (odds <= 0) return 1;

  const kelly = (p - q) / odds;
  return Math.min(1, Math.max(0, kelly));
}

/**
 * computeDynamicBetSize — Kelly³-motivated confidence-proportional bet sizing
 * with an optional per-position Kelly-fraction multiplier.
 *
 * Scales the target dollar bet between config.betSize (minimum, at
 * config.minConfidence) and config.maxBetSize (maximum, at
 * config.dynamicSizingMaxConfidence) using a cubic (t³) curve.
 *
 * Why cubic: the curve deliberately hugs the minimum through low-to-moderate
 * conviction and only accelerates sharply near the ceiling. On a typical
 * $1–$10 range with floor=65% and ceiling=90%, the dollar midpoint ($5)
 * requires roughly 85% confidence — ensuring significant capital is only
 * deployed when all models are in strong agreement. This protects against
 * large losses on medium-confidence bets that turn out to be wrong.
 *
 * Curve reference (floor=65%, ceiling=90%, min=$1, max=$10):
 *   65% → $1.00  |  75% → $1.58  |  80% → $2.94
 *   85% → $5.61  |  87.5% → $7.56  |  90% → $10.00
 *
 * When `yesPrice` and `direction` are supplied the increment above betSize is
 * further scaled by the per-position Kelly fraction (p−q)/odds.  A thin-edge
 * YES at 0.52 shrinks toward betSize while a high-value YES at 0.70 approaches
 * the full t²-sized increment.  Omitting these params preserves the original
 * behaviour (Kelly multiplier = 1).
 *
 * When config.enableDynamicSizing is false, always returns config.betSize so
 * behavior is identical to legacy fixed sizing.
 *
 * The result is never below betSize nor above maxBetSize, and if the config
 * is inverted (betSize > maxBetSize) the minimum (betSize) is returned so the
 * downstream hard maxBetSize cap is never exceeded.
 */
export function computeDynamicBetSize(
  confidence: number,
  config: Pick<
    BotConfig,
    "enableDynamicSizing" | "betSize" | "maxBetSize" | "minConfidence" | "dynamicSizingMaxConfidence"
  >,
  yesPrice?: number | null,
  direction?: "yes" | "no" | null,
): number {
  const minBet = config.betSize;
  const maxBet = config.maxBetSize ?? minBet;

  // Disabled, a non-widening range, or a non-finite confidence → legacy fixed
  // (minimum) sizing. Guarding against NaN/Infinity keeps the downstream
  // contractCount math from producing a bogus (or zero) order size.
  if (!config.enableDynamicSizing || maxBet <= minBet || !Number.isFinite(confidence)) {
    return minBet;
  }

  const floor = config.minConfidence;
  const ceiling = config.dynamicSizingMaxConfidence;

  // Degenerate range: ceiling not above floor → step function at the floor.
  if (ceiling <= floor) {
    return confidence >= floor ? maxBet : minBet;
  }

  if (confidence <= floor) return minBet;
  if (confidence >= ceiling) {
    // Even at the ceiling, apply the Kelly fraction to the full increment.
    const kellyMult =
      yesPrice != null && direction != null
        ? computeKellyMultiplier(confidence, yesPrice, direction)
        : 1;
    return minBet + kellyMult * (maxBet - minBet);
  }

  // Kelly³: cube the normalized position so the curve stays near the minimum
  // through moderate conviction and only accelerates steeply near the ceiling.
  // On a $1–$10 range with the default 65–90% window, the dollar midpoint ($5)
  // requires ~85% confidence — protecting capital on medium-confidence bets.
  const t = ((confidence - floor) / (ceiling - floor)) ** 3;

  // Per-position Kelly multiplier: shrinks the increment above minBet when the
  // market price implies thin edge, leaving it untouched when edge is high.
  const kellyMult =
    yesPrice != null && direction != null
      ? computeKellyMultiplier(confidence, yesPrice, direction)
      : 1;

  return minBet + kellyMult * t * (maxBet - minBet);
}

// ---------------------------------------------------------------------------
// Coin streak state — pure persistence helpers
// ---------------------------------------------------------------------------

export interface CoinStreakEntry {
  consecutiveLosses: number;
  pauseUntilWindowKey: string | null;
}

/**
 * Build the JSON snapshot that gets written to the DB.
 * Only entries with non-trivial state are included (keeps the JSON small).
 */
export function buildStreakSnapshot(
  state: Map<string, CoinStreakEntry>,
): Record<string, CoinStreakEntry> {
  const snapshot: Record<string, CoinStreakEntry> = {};
  for (const [sym, entry] of state.entries()) {
    if (entry.consecutiveLosses > 0 || entry.pauseUntilWindowKey !== null) {
      snapshot[sym] = { ...entry };
    }
  }
  return snapshot;
}

/**
 * Restore coinStreakState from a persisted snapshot.
 * Auto-clears any pauseUntilWindowKey that has already expired:
 * Expiry semantics (per task spec):
 *   active  → pauseUntilWindowKey > currentWindowKey  (strictly in the future)
 *   expired → pauseUntilWindowKey <= currentWindowKey (current window or past)
 *
 * The coin resumes betting starting FROM the pauseUntilWindowKey window — the
 * pause covered all windows BEFORE that key, not the key window itself.
 *
 * Window keys are ISO "YYYY-MM-DDTHH:mm" strings; lexicographic comparison is correct.
 */
export function restoreStreakState(
  saved: Record<string, CoinStreakEntry>,
  nowWindowKey: string,
): { state: Map<string, CoinStreakEntry>; clearedSyms: string[] } {
  const out = new Map<string, CoinStreakEntry>();
  const clearedSyms: string[] = [];
  for (const [sym, entry] of Object.entries(saved)) {
    const pauseKey = entry.pauseUntilWindowKey ?? null;
    // Keep the pause only when the pause target is strictly in the future.
    // pauseKey === nowWindowKey means the coin resumes this window → clear.
    const effectivePause = pauseKey !== null && pauseKey > nowWindowKey ? pauseKey : null;
    out.set(sym.toUpperCase(), {
      consecutiveLosses: entry.consecutiveLosses ?? 0,
      pauseUntilWindowKey: effectivePause,
    });
    if (pauseKey !== null && effectivePause === null) {
      clearedSyms.push(sym.toUpperCase());
    }
  }
  return { state: out, clearedSyms };
}

// ── Extreme Caution gate — pure helpers ──────────────────────────────────────
//
// These functions are extracted from _runBotTick so they can be unit-tested
// without the bot's I/O dependencies.  Each helper encodes exactly one guard
// condition; the caller composes them as needed.

/**
 * Returns true when the Extreme Caution EARLY guard should BLOCK a YES entry.
 *
 * All four conditions must hold simultaneously:
 *   1. decisionMode === "conviction"
 *   2. extremeCautionEnabled is true
 *   3. direction is "yes"
 *   4. abortedThisWindow contains the `${sym}:${windowKey}` key
 *
 * If any condition is false the guard does not fire and the bet proceeds
 * to the live-price gate.  Tests should verify each condition independently.
 */
export function checkExtremeCautionEarlyGuard(
  decisionMode: string,
  extremeCautionEnabled: boolean,
  direction: string,
  abortedThisWindow: Set<string>,
  sym: string,
  windowKey: string,
): boolean {
  return (
    decisionMode === "conviction" &&
    extremeCautionEnabled &&
    direction === "yes" &&
    abortedThisWindow.has(`${sym}:${windowKey}`)
  );
}

/**
 * Computes the YES-ask bounce threshold used in the NO cross-check gate.
 *
 * A FOK buy-NO fills at the cheapest YES ask ≤ the limit price.  If
 * freshYesAsk exceeds this ceiling, the YES ask has bounced above the
 * conviction zone and the NO order must be aborted.
 *
 * Threshold is bifurcated by extremeCautionEnabled:
 *   extremeCautionEnabled = true  → exact (1 − lockPrice), no tolerance
 *   extremeCautionEnabled = false → (1 − lockPrice) + 0.01  (1¢ spread room)
 *
 * The tighter threshold (EC on) guards against YES-ask bounce in markets
 * where price has already shown instability that triggered a bid-floor abort.
 * Rounded to 2 decimal places to avoid IEEE 754 drift.
 */
export function computeNoAskBounceThreshold(lockPrice: number, extremeCautionEnabled: boolean): number {
  if (extremeCautionEnabled) {
    return Math.round((1 - lockPrice) * 100) / 100;
  }
  return Math.round(((1 - lockPrice) + 0.01) * 100) / 100;
}

/**
 * Pure predicate for the YES cross-check bid-floor abort.
 *
 * Encodes the conditions under which:
 *   1. The conviction live-price gate must abort the YES order (abort=true)
 *   2. The abort must be recorded in extremeCautionAbortedThisWindow (populateECSet=true)
 *
 * The caller is responsible for all side-effects (Set.add, Set.delete, return).
 * Both tick.ts and tests use this function so they both validate the same logic.
 *
 * Conditions:
 *   - usedPollerFallback=true  → no abort (poller path; ask check already confirmed zone)
 *   - freshYesBid ≥ lockPrice  → no abort (bid is in zone; sub-zone fills are impossible)
 *   - freshYesBid < lockPrice  → abort; populateECSet = extremeCautionEnabled
 */
export function evaluateYesBidFloorAbort(
  freshYesBid: number,
  lockPrice: number,
  usedPollerFallback: boolean,
  extremeCautionEnabled: boolean,
): { abort: boolean; populateECSet: boolean } {
  if (usedPollerFallback) return { abort: false, populateECSet: false };
  if (freshYesBid >= lockPrice) return { abort: false, populateECSet: false };
  return { abort: true, populateECSet: extremeCautionEnabled };
}

/**
 * Computes the NO-ask ceiling used in the YES Extreme Caution complement check.
 *
 * When Extreme Caution is enabled and direction is YES, the derived NO ask
 * (1 − freshYesBid) must not exceed this ceiling.  Exceeding it means the
 * complementary side of the book is pricing YES back below the zone floor —
 * a strong signal the price has bounced out.
 *
 * Formula: Math.round((1 − lockPrice + 0.005) × 1000) / 1000
 * (0.5¢ tolerance; tighter than the NO gate's 1¢; rounded to 3 decimals.)
 *
 * Only applied when extremeCautionEnabled is true (caller's responsibility).
 */
export function computeExtremeCautionNoAskCeiling(lockPrice: number): number {
  return Math.round((1 - lockPrice + 0.005) * 1000) / 1000;
}

/**
 * Selects the matching time-bet schedule bracket for the given elapsed time.
 *
 * Brackets are sorted descending by minutesElapsed; the first bracket whose
 * minutesElapsed ≤ elapsedMin is selected (highest matching bracket wins).
 * Returns null when no bracket matches (elapsedMin is before all brackets).
 *
 * Example schedule [{minutesElapsed:3, betAmount:2}, {minutesElapsed:7, betAmount:1}]:
 *   elapsedMin=1  → null (too early)
 *   elapsedMin=3  → {minutesElapsed:3, betAmount:2}
 *   elapsedMin=5  → {minutesElapsed:3, betAmount:2}  (highest ≤ 5)
 *   elapsedMin=7  → {minutesElapsed:7, betAmount:1}  (highest ≤ 7)
 *   elapsedMin=14 → {minutesElapsed:7, betAmount:1}
 */
export function selectTimeBetBracket(
  schedule: Array<{ minutesElapsed: number; betAmount: number }>,
  elapsedMin: number,
): { minutesElapsed: number; betAmount: number } | null {
  const sorted = [...schedule].sort((a, b) => b.minutesElapsed - a.minutesElapsed);
  return sorted.find(b => elapsedMin >= b.minutesElapsed) ?? null;
}

// ── Signal divergence early-exit cutout ──────────────────────────────────────
// Fires when ≥2 of 3 signals (stat, Claude, ML) that were supporting the bet
// at entry have since flipped to oppose it.  Only triggers during the first
// DIVERGENCE_MAX_MINUTES of the position while the contract still has ≥50% of
// its entry value — i.e. there is still meaningful value to recover.

export const DIVERGENCE_MAX_MINUTES = 8;
export const DIVERGENCE_MIN_SIGNALS_FLIPPED = 2;
export const DIVERGENCE_PRICE_FLOOR_MULT = 0.50;

/**
 * Check whether the signal divergence early-exit cutout should fire.
 *
 * A signal is "flipped" when it was actively supporting the bet direction at
 * entry (true for YES, false for NO) and is now actively opposing it.
 * Null signals (unavailable at entry or now) are ignored — they cannot flip.
 *
 * Conditions (all must hold):
 *   1. minutesElapsed < DIVERGENCE_MAX_MINUTES (early window only, ≤8 min)
 *   2. Contract still has ≥ DIVERGENCE_PRICE_FLOOR_MULT × entry value (≥50%)
 *   3. ≥ DIVERGENCE_MIN_SIGNALS_FLIPPED of 3 signals have flipped
 */
export function checkSignalDivergenceCutout(
  direction: "yes" | "no",
  minutesElapsed: number,
  currentYesPrice: number | null,
  entryYesPrice: number,
  entrySignals: { statAbove: boolean | null; claudeAbove: boolean | null; mlAbove: boolean | null },
  currentStatAbove: boolean | null,
  currentClaudeAbove: boolean | null,
  currentMlAbove: boolean | null,
): { triggered: boolean; reason: string } {
  if (minutesElapsed >= DIVERGENCE_MAX_MINUTES) {
    return { triggered: false, reason: `divergence-cutout: min${minutesElapsed} ≥ ${DIVERGENCE_MAX_MINUTES} — beyond early window` };
  }

  // Price floor: contract value must still be ≥ 50% of what we paid.
  // If price is unavailable we cannot verify the condition — hold.
  if (currentYesPrice === null) {
    return { triggered: false, reason: `divergence-cutout: currentYesPrice unavailable — cannot verify price floor, holding` };
  }
  const contractValueAtEntry = direction === "yes" ? entryYesPrice : (1 - entryYesPrice);
  const contractValueNow     = direction === "yes" ? currentYesPrice : (1 - currentYesPrice);
  const priceFloor = contractValueAtEntry * DIVERGENCE_PRICE_FLOOR_MULT;
  if (contractValueNow < priceFloor) {
    return {
      triggered: false,
      reason: `divergence-cutout: contract ${(contractValueNow * 100).toFixed(0)}¢ < floor ${(priceFloor * 100).toFixed(0)}¢ — not enough value to exit`,
    };
  }

  let flippedCount = 0;
  const flipped: string[] = [];

  function checkFlip(name: string, entryVal: boolean | null, currentVal: boolean | null): void {
    if (entryVal === null || currentVal === null) return;
    const wasForBet  = direction === "yes" ? entryVal === true  : entryVal === false;
    const nowAgainst = direction === "yes" ? currentVal === false : currentVal === true;
    if (wasForBet && nowAgainst) { flippedCount++; flipped.push(name); }
  }

  checkFlip("stat",   entrySignals.statAbove,   currentStatAbove);
  checkFlip("claude", entrySignals.claudeAbove, currentClaudeAbove);
  checkFlip("ml",     entrySignals.mlAbove,     currentMlAbove);

  if (flippedCount >= DIVERGENCE_MIN_SIGNALS_FLIPPED) {
    return {
      triggered: true,
      reason: `Signal divergence: ${flipped.join("+")} flipped vs ${direction.toUpperCase()} at min ${minutesElapsed} — contract now ${(contractValueNow * 100).toFixed(0)}¢ vs entry ${(contractValueAtEntry * 100).toFixed(0)}¢ — early cutout (${flippedCount}/${DIVERGENCE_MIN_SIGNALS_FLIPPED})`,
    };
  }

  return {
    triggered: false,
    reason: `divergence-cutout: ${flippedCount}/${DIVERGENCE_MIN_SIGNALS_FLIPPED} signals flipped — not enough to exit`,
  };
}

