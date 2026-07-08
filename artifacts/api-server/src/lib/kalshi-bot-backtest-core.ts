// Pure backtest approval function — zero dependencies, no I/O.
//
// Mirrors the live engine's gating rules (kalshi-bot-engine.ts) so that
// backtestModeApproval stays in sync with makeBotDecision as the engine evolves.
//
// Backtest question: "given the signals stored at bet time, would mode X have
// placed THIS specific bet in the same direction?"
//
// classic   — yes, always (all existing bets passed the classic cascade)
// ml_gate   — simplified three-tier formula: Claude leads direction, ML vetoes
//             only when it disagrees AND is strictly more confident than Claude,
//             all three signals required (see computeMLGateDecision)
// consensus — majority of [stat, claude, ml] must agree; tie = SKIP = rejected
// unanimous — all 3 of [stat, claude, ml] must be available and unanimously agree

import { ML_BOOST, STAT_BOOST, STAT_PENALTY } from "./kalshi-bot-engine-core.ts";

/**
 * Returns true if the given decision mode would have approved the bet,
 * false if it would have skipped it or would have bet the opposite direction.
 *
 * @param mode          Decision mode to test
 * @param aboveExpected true when the actual bet was BET_YES, false for BET_NO
 * @param statAbove     Stat signal stored at bet time  (null = not available)
 * @param claudeAbove   Claude signal stored at bet time
 * @param mlAbove       ML signal stored at bet time
 * @param statConf      Stat confidence stored at bet time (null on older rows)
 * @param claudeConf    Claude confidence stored at bet time (null on older rows)
 * @param mlConf        ML confidence stored at bet time (null on older rows)
 * @param minConfidence Composite floor to simulate for ml_gate; null = skip the
 *                      composite gate (historical per-bet config is unknown)
 */
export function backtestModeApproval(
  mode: string,
  aboveExpected: boolean,
  statAbove: boolean | null,
  claudeAbove: boolean | null,
  mlAbove: boolean | null,
  statConf: number | null = null,
  claudeConf: number | null = null,
  mlConf: number | null = null,
  minConfidence: number | null = null,
): boolean {
  // ── classic ───────────────────────────────────────────────────────────────
  // All existing settled bets passed the classic cascade by definition.
  if (mode === "classic") return true;

  // ── ml_gate ───────────────────────────────────────────────────────────────
  // Mirrors computeMLGateDecision (kalshi-bot-engine-core.ts) — the simplified
  // three-tier formula:
  //   1. Gate 1: all three signals must be available (bot waits otherwise).
  //   2. Direction = Claude's direction; must match the actual bet direction.
  //   3. ML veto: ML disagrees AND mlConf > claudeConf (strict) → SKIP.
  //      Missing confidences are treated as 0, same as the live formula.
  //   4. Composite gate: claudeConf + (ML agrees ? +8 : 0) + (Stat agrees ? +4 : −4)
  //      must clear minConfidence — only simulated when a floor is provided AND
  //      Claude's confidence was recorded (older rows lack confidences; rejecting
  //      them all on a 0-base composite would misattribute history).
  if (mode === "ml_gate") {
    if (statAbove === null || claudeAbove === null || mlAbove === null) {
      return false; // Gate 1: any missing signal → the bot would still be waiting
    }

    if (claudeAbove !== aboveExpected) return false; // Claude leads — opposite direction

    const cConf = claudeConf ?? 0;
    const mConf = mlConf ?? 0;
    if (mlAbove !== claudeAbove && mConf > cConf) return false; // ML veto

    if (minConfidence !== null && claudeConf !== null) {
      const composite =
        cConf +
        (mlAbove === claudeAbove ? ML_BOOST : 0) +
        (statAbove === claudeAbove ? STAT_BOOST : -STAT_PENALTY);
      if (composite < minConfidence) return false;
    }

    return true;
  }

  // ── consensus ─────────────────────────────────────────────────────────────
  // Mirrors kalshi-bot-engine.ts ~lines 263-313:
  //   - Collect votes from [stat, claude, ml].
  //   - < 2 available signals → warm-up fallback to classic.
  //   - Tie (equal yes/no votes) → SKIP.
  //   - Majority direction must match actual bet direction.
  if (mode === "consensus") {
    const available = ([statAbove, claudeAbove, mlAbove] as Array<boolean | null>)
      .filter((v): v is boolean => v !== null);

    if (available.length < 2) return true; // warm-up: fall back to classic

    const yesCount = available.filter(v => v === true).length;
    const noCount  = available.filter(v => v === false).length;

    if (yesCount === noCount) return false; // tie → consensus SKIPs

    const majorityDir = yesCount > noCount; // true = YES, false = NO
    return majorityDir === aboveExpected;   // must match actual bet direction
  }

  // ── unanimous ─────────────────────────────────────────────────────────────
  // All 3 signals must be available AND all must agree on the same direction.
  // Any missing signal or any disagreement → SKIP (no warm-up fallback).
  if (mode === "unanimous") {
    if (statAbove === null || claudeAbove === null || mlAbove === null) {
      return false; // any unavailable signal → SKIP
    }
    // All three must agree with the actual bet direction
    return statAbove === aboveExpected && claudeAbove === aboveExpected && mlAbove === aboveExpected;
  }

  // Unknown mode — approve by default so new modes don't silently disappear.
  return true;
}
