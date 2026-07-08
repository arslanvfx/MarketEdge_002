// Pure, zero-dependency decision core for the Kalshi bot.
//
// No imports from ./crypto or any DB/API module — this file is intentionally
// isolated so it can be unit-tested without any I/O setup.
//
// Signal priority (highest to lowest):
//
//   PATH A — ML primary:
//     ML model is ready (mlConfidence ≥ ML_PRIMARY_MIN_CONFIDENCE).
//     ML decides the direction; each agreeing validator (Claude, Stat, WM)
//     adds ML_SIGNAL_BOOST (6%) to the base ML confidence score.
//
//   PATH B — Claude primary (ML not ready):
//     Claude decides the direction.  Stat must agree or be absent; if Stat
//     disagrees there is no tiebreaker — the window is skipped.
//     WM agreement adds CONFIDENCE_BOOST_PER_SIGNAL (8%).
//
//   PATH C — Stat primary (no ML, no Claude):
//     Stat decides the direction.  Base = statConfidence or
//     BASE_CONFIDENCE_HALF_PAIR (60%).  WM adds CONFIDENCE_BOOST_PER_SIGNAL.
//
// Final gates applied to all paths: EV gate, minConfidence gate.

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

  // Direction-aware EV gate — applied after direction is decided so YES and NO
  // bets each use the correct payoff formula for their actual cost structure.
  // Pre-direction EV used the YES formula for all bets, which incorrectly
  // blocked cheap NO contracts (high yes_price = low NO cost = high payoff).
  //
  // Thresholds are asymmetric:
  //   YES: −0.05  — tight, since historical accuracy is calibrated on YES bets.
  //   NO : −0.15  — relaxed, because the accuracy metric is derived almost entirely
  //                 from YES-bet history.  Applying the same threshold to NO bets
  //                 treats YES-calibrated accuracy as a perfect proxy for NO win
  //                 rate, which over-rejects valid NO entries in bearish windows
  //                 where the Kalshi market has partially but not fully priced in
  //                 the move (yesPrice 30–40%).  The min-return gate (1.45×) still
  //                 hard-blocks truly overpriced NO bets (yesPrice < 31%).
  if (result.action === "BET_YES" || result.action === "BET_NO") {
    const dirEV = computeEVForDirection(result.action, inp.yesPrice, inp.signalAccuracyPct);
    const evFloor = result.action === "BET_NO" ? -0.15 : -0.05;
    if (dirEV !== null && dirEV < evFloor) {
      return {
        action: "SKIP",
        confidence: result.confidence,
        reasoning: `Negative EV (${dirEV.toFixed(3)}) at yes=${inp.yesPrice?.toFixed(2)} acc=${inp.signalAccuracyPct?.toFixed(0)}% (floor ${evFloor})`,
        signalsAgreeing: result.signalsAgreeing,
        signalsTotal: result.signalsTotal,
        ev: dirEV,
      };
    }
  }

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

  return result;
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

  // ── Alignment gate — applied before any path decision ────────────────────
  // Fires only when ML's dissent is meaningful (>= ML_ALIGNMENT_GATE_MIN_CONFIDENCE = 56%).
  // Below 56% ML is treated as noise — PATH B handles it without blocking.
  //
  // Two distinct sub-cases when Claude disagrees with ML:
  //
  // (A) Only Claude disagrees (Stat agrees with ML or is absent) → always SKIP.
  //     A single high-quality signal (Claude) opposing ML is enough to block.
  //
  // (B) Both Stat AND Claude disagree with ML (2-vs-1):
  //     • Either signal is strong (≥ STAT_CLAUDE_DOMINANCE_THRESHOLD = 60%) → SKIP.
  //       Their consensus outweighs even a 70%+ ML.
  //     • Both signals are weak (< 60%) AND ML ≥ primary threshold (70%) → allow.
  //       ML's high confidence overrides two weak, uncertain signals.
  //       Veto below is also waived for this case; PATH A proceeds without penalty.
  const mlMeaningfulDissent = inp.mlConfidence != null && inp.mlConfidence >= ML_ALIGNMENT_GATE_MIN_CONFIDENCE;
  if (mlMeaningfulDissent && inp.claudeAbove !== null && inp.mlAbove !== null && inp.claudeAbove !== inp.mlAbove) {
    const statAlsoOpposes = inp.statAbove !== null && inp.statAbove !== inp.mlAbove;

    if (statAlsoOpposes) {
      // 2-vs-1: both Stat and Claude oppose ML.
      // Null confidence is treated conservatively as "strong" (>= threshold).
      const statConf = inp.statConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD;
      const claudeConf = inp.claudeConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD;
      const bothWeak = statConf < STAT_CLAUDE_DOMINANCE_THRESHOLD && claudeConf < STAT_CLAUDE_DOMINANCE_THRESHOLD;
      const mlPrimaryConf = inp.mlMinConfidence ?? ML_PRIMARY_MIN_CONFIDENCE;
      const mlStrongEnough = (inp.mlConfidence as number) >= mlPrimaryConf;

      if (bothWeak && mlStrongEnough) {
        // ML overrides two weak signals — fall through to PATH A.
        // (Veto below is waived; DISSENT_PENALTY is not applied.)
      } else {
        const reason = (!bothWeak)
          ? `Stat+Claude both disagree with ML and are strong (stat=${Math.round(statConf)}% claude=${Math.round(claudeConf)}% ≥ ${STAT_CLAUDE_DOMINANCE_THRESHOLD}%) — consensus wins`
          : `Stat+Claude both disagree with ML but ML (${inp.mlConfidence}%) is below primary threshold (${mlPrimaryConf}%) — cannot override`;
        return skip(reason, ev);
      }
    } else {
      // Case A: only Claude disagrees (stat agrees with ML or is absent).
      // Default: SKIP — a single high-quality signal opposing ML is enough to block.
      // Exception (ML dominance): when stat actively AGREES with ML direction
      // (2-vs-1 in ML's favour with Claude as sole dissenter), Claude's confidence
      // is weak (< STAT_CLAUDE_DOMINANCE_THRESHOLD), and ML leads Claude by
      // ≥ ML_DOMINANCE_MARGIN — allow PATH A to proceed.  A weak trending-context
      // Claude read cannot veto a stronger ML+Stat aligned short-window signal.
      const statAgreesWithML = inp.statAbove !== null && inp.statAbove === inp.mlAbove;
      const mlConf    = inp.mlConfidence ?? 0;
      const claudeConf = inp.claudeConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD;
      const mlPrimaryConf = inp.mlMinConfidence ?? ML_PRIMARY_MIN_CONFIDENCE;
      const mlDominatesWeakClaude =
        statAgreesWithML &&
        claudeConf < STAT_CLAUDE_DOMINANCE_THRESHOLD &&
        mlConf >= claudeConf + ML_DOMINANCE_MARGIN &&
        mlConf >= mlPrimaryConf;
      if (!mlDominatesWeakClaude) {
        return skip(
          `Claude-ML misalignment: Claude=${inp.claudeAbove ? "YES" : "NO"} ML=${inp.mlAbove ? "YES" : "NO"} (${inp.mlConfidence}%) — skipping until they agree`,
          ev,
        );
      }
      // Fall through to PATH A — stat+ML beat a weak Claude; DISSENT_PENALTY
      // will reduce ML's confidence score for Claude's opposition in PATH A.
    }
  }

  // Whether the ML model is ready to lead
  const mlMinConf = inp.mlMinConfidence ?? ML_PRIMARY_MIN_CONFIDENCE;
  let mlLeadReady =
    inp.mlAbove !== null &&
    inp.mlConfidence != null &&
    inp.mlConfidence >= mlMinConf;

  // Veto PATH A: ML must have at least one confirming signal to lead.
  // Exception A: both Stat and Claude actively oppose ML but are BOTH weak
  // (< STAT_CLAUDE_DOMINANCE_THRESHOLD).  The alignment gate above already
  // blocked the "strong opposition" case, so if we reach here with both
  // opposing, their confidences are confirmed < 60% — ML overrides.
  // Exception B (ML dominance): exactly one signal opposes (the other is absent)
  // and that signal is weak AND ML confidence exceeds it by ≥ ML_DOMINANCE_MARGIN
  // pp.  A single weak, complement-absent signal cannot block a clearly stronger
  // ML read.  Strong opposition (≥ STAT_CLAUDE_DOMINANCE_THRESHOLD) is never
  // overridden here — the alignment gate above already handles that case.
  const mlDir = inp.mlAbove;
  const mlHasConfirmation =
    (inp.statAbove !== null && inp.statAbove === mlDir) ||
    (inp.claudeAbove !== null && inp.claudeAbove === mlDir);
  if (mlLeadReady && mlDir !== null && !mlHasConfirmation) {
    const mlConf = inp.mlConfidence ?? 0;
    // Exception A: both weakly oppose (alignment gate confirmed both < 60%).
    const bothWeaklyOppose =
      inp.statAbove !== null && inp.statAbove !== mlDir &&
      inp.claudeAbove !== null && inp.claudeAbove !== mlDir;
    // Exception B: stat opposes alone (claude absent), stat is weak, ML dominates.
    const statOpposes   = inp.statAbove   !== null && inp.statAbove   !== mlDir;
    const claudeOpposes = inp.claudeAbove !== null && inp.claudeAbove !== mlDir;
    const mlDominatesStatAlone =
      statOpposes && inp.claudeAbove === null &&
      (inp.statConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD) < STAT_CLAUDE_DOMINANCE_THRESHOLD &&
      mlConf >= (inp.statConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD) + ML_DOMINANCE_MARGIN;
    // Exception B (mirror): claude opposes alone (stat absent), claude is weak, ML dominates.
    const mlDominatesClaudeAlone =
      claudeOpposes && inp.statAbove === null &&
      (inp.claudeConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD) < STAT_CLAUDE_DOMINANCE_THRESHOLD &&
      mlConf >= (inp.claudeConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD) + ML_DOMINANCE_MARGIN;
    if (!bothWeaklyOppose && !mlDominatesStatAlone && !mlDominatesClaudeAlone) {
      mlLeadReady = false; // standard veto: no confirming signal
    }
  }

  // ── PATH A: ML primary ────────────────────────────────────────────────────
  if (mlLeadReady) {
    const mlDir2 = inp.mlAbove as boolean;
    const action: BotDecisionAction = mlDir2 ? "BET_YES" : "BET_NO";

    // Hard gate: ML must have at least one core signal available.
    // (The "both weak" exception keeps both statAbove and claudeAbove non-null,
    // so this guard only fires when genuinely no validators exist.)
    if (inp.statAbove === null && inp.claudeAbove === null) {
      return skip(
        `ML solo: no core signals available (Stat=null, Claude=null) — require at least one validator before betting`,
        ev,
      );
    }

    let confidence = inp.mlConfidence as number;

    // Agreeing validator → +ML_SIGNAL_BOOST.
    // Opposing validator → −DISSENT_PENALTY, BUT ONLY if their confidence is
    // "strong" (≥ STAT_CLAUDE_DOMINANCE_THRESHOLD = 60%).  Weak opposition
    // (<60%) cannot block the bet (alignment gate already enforced this) so
    // applying a penalty would arbitrarily reduce ML's lead confidence for
    // signals that weren't strong enough to influence the decision.
    // Null confidence is treated conservatively as strong (= penalty applies).
    const claudeOpposesStrongly =
      inp.claudeAbove !== null && inp.claudeAbove !== mlDir2 &&
      (inp.claudeConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD) >= STAT_CLAUDE_DOMINANCE_THRESHOLD;
    const statOpposesStrongly =
      inp.statAbove !== null && inp.statAbove !== mlDir2 &&
      (inp.statConfidence ?? STAT_CLAUDE_DOMINANCE_THRESHOLD) >= STAT_CLAUDE_DOMINANCE_THRESHOLD;

    if      (inp.claudeAbove === mlDir2)  confidence += ML_SIGNAL_BOOST;
    else if (claudeOpposesStrongly)       confidence -= DISSENT_PENALTY;

    if      (inp.statAbove   === mlDir2)  confidence += ML_SIGNAL_BOOST;
    else if (statOpposesStrongly)         confidence -= DISSENT_PENALTY;

    if (inp.wmDriftAbove === mlDir2) confidence += ML_SIGNAL_BOOST;
    // WM dissent: no penalty — WM is a secondary signal.

    if (confidence < inp.minConfidence) {
      const { signalsAgreeing, signalsTotal } = countSignals(mlDir2, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
      return {
        action: "SKIP", confidence,
        reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (ML primary)`,
        signalsAgreeing, signalsTotal, ev,
      };
    }

    const { signalsAgreeing, signalsTotal } = countSignals(mlDir2, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);

    const claudeDesc = inp.claudeAbove !== null
      ? inp.claudeAbove === mlDir2
        ? `Claude:+${ML_SIGNAL_BOOST}`
        : claudeOpposesStrongly
          ? `Claude:−${DISSENT_PENALTY}`
          : `Claude:~(weak)`
      : "Claude:—";
    const statDesc = inp.statAbove !== null
      ? inp.statAbove === mlDir2
        ? `Stat:+${ML_SIGNAL_BOOST}`
        : statOpposesStrongly
          ? `Stat:−${DISSENT_PENALTY}`
          : `Stat:~(weak)`
      : "Stat:—";
    const wmDesc = inp.wmDriftAbove !== null
      ? `WM:${inp.wmDriftAbove === mlDir2 ? `+${ML_SIGNAL_BOOST}` : "—"}`
      : "";
    const validators = [claudeDesc, statDesc, wmDesc].filter(Boolean).join(" ");
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `ML primary: ML:✓(${Math.round(inp.mlConfidence as number)}%) ${validators} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── PATH B: Claude primary (ML not ready) ─────────────────────────────────
  if (inp.claudeAbove !== null) {
    const claudeDir = inp.claudeAbove;
    const action: BotDecisionAction = claudeDir ? "BET_YES" : "BET_NO";

    // If Stat is available and disagrees with Claude → ML can arbitrate.
    // The Claude-ML misalignment pre-check above already handled the case
    // where ML disagrees with Claude (returning SKIP before reaching here),
    // so if mlAbove is non-null here it is guaranteed to agree with Claude.
    if (inp.statAbove !== null && inp.statAbove !== claudeDir) {
      if (inp.mlAbove == null) {
        return skip(
          `Claude and Stat disagree: Claude=${claudeDir} Stat=${inp.statAbove} — no ML to arbitrate`,
          ev,
        );
      }
      if (inp.mlAbove !== claudeDir) {
        // Safety net: ML sides with Stat against Claude — skip
        return skip(
          `Claude/Stat split: Claude=${claudeDir} Stat=${inp.statAbove} ML=${inp.mlAbove} — ML+Stat oppose Claude direction`,
          ev,
        );
      }
      // ML sides with Claude (Claude+ML vs Stat, 2-of-3) — proceed at half-pair confidence
    }

    const base = inp.statAbove === claudeDir ? BASE_CONFIDENCE_FULL_PAIR : BASE_CONFIDENCE_HALF_PAIR;
    let confidence = base;
    if (inp.wmDriftAbove === claudeDir) confidence += CONFIDENCE_BOOST_PER_SIGNAL;

    // ML vote in PATH B: direction-symmetric treatment.
    // Agreement → +ML_SIGNAL_BOOST; dissent → −DISSENT_PENALTY.
    // Both apply only when ML confidence is meaningful (≥ ML_ALIGNMENT_GATE_MIN_CONFIDENCE = 56).
    // Below that threshold ML is noise — no boost, no penalty.
    // This makes unanimous YES and unanimous NO calls score identically (65+6=71),
    // preventing any directional bias introduced by the confidence floor.
    // (When ML disagrees at ≥56%, the alignment gate above would normally have already
    //  returned SKIP — the dissent branch here is a safety net for edge cases.)
    const mlMeaningful =
      inp.mlAbove !== null &&
      inp.mlConfidence != null &&
      inp.mlConfidence >= ML_ALIGNMENT_GATE_MIN_CONFIDENCE;
    if (mlMeaningful && inp.mlAbove === claudeDir) confidence += ML_SIGNAL_BOOST;
    else if (mlMeaningful && inp.mlAbove !== claudeDir) confidence -= DISSENT_PENALTY;

    if (confidence < inp.minConfidence) {
      const { signalsAgreeing, signalsTotal } = countSignals(claudeDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
      return {
        action: "SKIP", confidence,
        reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (Claude primary)`,
        signalsAgreeing, signalsTotal, ev,
      };
    }

    const { signalsAgreeing, signalsTotal } = countSignals(claudeDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);

    const statDesc = inp.statAbove !== null ? `Stat:✓` : "Stat:—";
    const mlSignalDesc = mlMeaningful
      ? inp.mlAbove === claudeDir ? ` ML:+${ML_SIGNAL_BOOST}` : ` ML:−${DISSENT_PENALTY}`
      : "";
    const wmBoostDesc = inp.wmDriftAbove === claudeDir ? ` WM:+${CONFIDENCE_BOOST_PER_SIGNAL}` : "";
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `Claude primary: Claude:✓ ${statDesc}${mlSignalDesc}${wmBoostDesc} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── PATH C: Stat primary (no ML, no Claude) ───────────────────────────────
  if (inp.statAbove !== null) {
    const statDir = inp.statAbove;
    const action: BotDecisionAction = statDir ? "BET_YES" : "BET_NO";
    const base = inp.statConfidence != null
      ? Math.max(inp.statConfidence, 50)
      : BASE_CONFIDENCE_HALF_PAIR;
    let confidence = base;
    if (inp.wmDriftAbove === statDir) confidence += CONFIDENCE_BOOST_PER_SIGNAL;
    // ML is below the lead threshold (< ML_PRIMARY_MIN_CONFIDENCE) but if it
    // agrees with Stat it still adds confirming signal value — same as WM does.
    // When ML disagrees with Stat no penalty is applied (Stat leads, ML is
    // advisory only in this path).
    const mlAgreesStat = inp.mlAbove !== null && inp.mlAbove === statDir;
    if (mlAgreesStat) confidence += ML_SIGNAL_BOOST;

    if (confidence < inp.minConfidence) {
      const { signalsAgreeing, signalsTotal } = countSignals(statDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
      return {
        action: "SKIP", confidence,
        reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (Stat primary)`,
        signalsAgreeing, signalsTotal, ev,
      };
    }

    const { signalsAgreeing, signalsTotal } = countSignals(statDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
    const wmBoostDesc = inp.wmDriftAbove === statDir ? ` WM:+${CONFIDENCE_BOOST_PER_SIGNAL}` : "";
    const mlBoostDesc = mlAgreesStat ? ` ML:+${ML_SIGNAL_BOOST}` : "";
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `Stat primary: Stat:✓(${Math.round(base)}%)${wmBoostDesc}${mlBoostDesc} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── No signals ────────────────────────────────────────────────────────────
  return skip("No signals available", ev);
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

export type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous";

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
  // Allow up to 8 bets per window (matches 8-coin training set: BTC/ETH/XRP/HYPE/BNB/SOL/DOGE/LINK).
  maxBetsPerWindow: 8,
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
  requireMonitorReady: true,
  // Confidence-based dynamic bet sizing — disabled by default (legacy behavior).
  enableDynamicSizing: false,
  dynamicSizingMaxConfidence: 90,
  profitLockPct: 0,
  minHoldMinutes: 4,
  enableMidExit: false,
  freeRunMode: false,
  consensusMinCents: 25,
  momentumLookbackCandles: 8,
  // SOL/DOGE/XRP ML accuracy sits at ~59-60%, just under the global 65% gate.
  // Lower per-coin floors so they qualify for PATH A at their realistic confidence range.
  mlPrimaryMinConfidenceOverrides: { SOL: 60, DOGE: 62, XRP: 60 },
};

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

// ---------------------------------------------------------------------------
// Pure staleness gate helper — live signal readiness (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Decides whether the bot tick should defer entry to wait for a fresh live
 * Claude direction, or fall through because we've been waiting too long.
 *
 * Design:
 *  • cache fresh (age ≤ maxAgeMs) → proceed immediately (defer: false)
 *  • cache stale AND time-past-buffer < maxDeferSeconds → defer one tick
 *  • cache stale AND time-past-buffer ≥ maxDeferSeconds → fall through to
 *    opening snap (usedFallback: true) so the window is never permanently
 *    blocked by a down Claude API.
 *
 * Parameters:
 *  liveDirEntry        — current cache entry (undefined = cache empty)
 *  nowMs               — current timestamp (injectable for testing)
 *  maxAgeMs            — maximum acceptable cache age (default: 2 min)
 *  secondsPastBuffer   — how many seconds have elapsed since the entry buffer
 *                        cleared (secondsElapsed − WINDOW_ENTRY_BUFFER_S)
 *  maxDeferSeconds     — how long to keep deferring before giving up and using
 *                        the opening snap (default: 90 s)
 */
export function shouldDeferForLiveSignal(
  liveDirEntry: { at: number } | undefined,
  nowMs: number,
  maxAgeMs: number,
  secondsPastBuffer: number,
  maxDeferSeconds: number,
): { defer: boolean; usedFallback: boolean } {
  const liveDirAge = liveDirEntry ? nowMs - liveDirEntry.at : Infinity;
  if (liveDirAge <= maxAgeMs) {
    return { defer: false, usedFallback: false };
  }
  // Cache is stale.  Give up deferring once maxDeferSeconds have elapsed
  // past the entry buffer so a permanently-down Claude API can't block bets
  // for the entire window.
  if (secondsPastBuffer >= maxDeferSeconds) {
    return { defer: false, usedFallback: true };
  }
  return { defer: true, usedFallback: false };
}

// ---------------------------------------------------------------------------
// Pure override helpers — live signal freshness (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Applies the live-direction cache override to Claude's opening snap.
 *
 * The opening snap (historyStore) is written once at window-open and never
 * updated.  liveDirectionCache is refreshed by fetchLiveDirection (2-min TTL)
 * and represents Claude's current market read.
 *
 * Returns the resolved claudeAbove value, whether the live cache was used,
 * and whether the live direction contradicts the opening call (a "flip").
 */
export function applyClaudeLiveOverride(
  openingAbove: boolean | null,
  openingSnapAtMs: number,
  liveDirEntry: { at: number; result: { aboveKalshi: boolean | null } } | undefined,
): { claudeAbove: boolean | null; isLive: boolean; flipped: boolean } {
  if (!liveDirEntry || liveDirEntry.result.aboveKalshi === null) {
    return { claudeAbove: openingAbove, isLive: false, flipped: false };
  }
  if (liveDirEntry.at <= openingSnapAtMs) {
    return { claudeAbove: openingAbove, isLive: false, flipped: false };
  }
  const liveAbove = liveDirEntry.result.aboveKalshi;
  return {
    claudeAbove: liveAbove,
    isLive: true,
    flipped: openingAbove !== null && liveAbove !== openingAbove,
  };
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

/**
 * Applies the mid-snap predCache override to the opening stat signal.
 *
 * The stat snap in historyStore is written once at window-open (~T+1 min).
 * The tracker fires a mid-window analyzeCoin re-run at T+7 and writes the
 * result to predCache.  If that cache entry is newer than the opening snap
 * and recent enough (< 10 min), derive a fresher statAbove by comparing the
 * live price in the cache entry against the Kalshi target.
 *
 * `nowMs` is injectable for deterministic testing (defaults to Date.now()).
 */
export function applyStatPredCacheOverride(
  openingAbove: boolean | null,
  openingSnapAtMs: number,
  predCacheEntry: { at: number; value: { price: number; kalshiTarget?: number | null; predictions?: Array<{ predictedPrice: number }> } } | undefined,
  kalshiTarget: number | null,
  nowMs: number = Date.now(),
): { statAbove: boolean | null; isLive: boolean; flipped: boolean } {
  const PRED_CACHE_MAX_AGE_MS = 10 * 60_000;
  if (!predCacheEntry) {
    return { statAbove: openingAbove, isLive: false, flipped: false };
  }
  // Guard: if the opening stat snap has fired and produced a real forward prediction,
  // trust it unconditionally — do not override it with any live-price comparison.
  if (openingAbove !== null) {
    return { statAbove: openingAbove, isLive: false, flipped: false };
  }
  const kal = predCacheEntry.value.kalshiTarget ?? kalshiTarget;
  const predAge = nowMs - predCacheEntry.at;
  if (predCacheEntry.at <= openingSnapAtMs || predAge >= PRED_CACHE_MAX_AGE_MS || kal == null) {
    return { statAbove: openingAbove, isLive: false, flipped: false };
  }
  // Use the model's forward predicted price, NOT the live spot price.
  // The live price is a current-position check ("are we above/below right now?"),
  // whereas the predictor page and the stat snap both use the model's forecast
  // ("will price be above/below at window close?").  Using live price here
  // diverges from the predictor's stat signal and caused YES bets when the
  // model was predicting a fall below the target.
  const predPrice = predCacheEntry.value.predictions?.[0]?.predictedPrice;
  if (predPrice == null) {
    // No forward prediction available — returning null is safer than substituting
    // a live-price positional check as a stat signal.
    return { statAbove: null, isLive: false, flipped: false };
  }
  return {
    statAbove: predPrice >= kal,
    isLive: true,
    flipped: false,
  };
}
