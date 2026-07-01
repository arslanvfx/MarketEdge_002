// Pure backtest approval function — zero dependencies, no I/O.
//
// Mirrors the live engine's gating rules (kalshi-bot-engine.ts) so that
// backtestModeApproval stays in sync with makeBotDecision as the engine evolves.
//
// Backtest question: "given the signals stored at bet time, would mode X have
// placed THIS specific bet in the same direction?"
//
// classic   — yes, always (all existing bets passed the classic cascade)
// ml_gate   — runs core pair (PATH B/C) without ML; ML can only veto, not lead
// consensus — majority of [stat, claude, ml] must agree; tie = SKIP = rejected
// unanimous — all 3 of [stat, claude, ml] must be available and unanimously agree

/**
 * Returns true if the given decision mode would have approved the bet,
 * false if it would have skipped it or would have bet the opposite direction.
 *
 * @param mode          Decision mode to test
 * @param aboveExpected true when the actual bet was BET_YES, false for BET_NO
 * @param statAbove     Stat signal stored at bet time  (null = not available)
 * @param claudeAbove   Claude signal stored at bet time
 * @param mlAbove       ML signal stored at bet time
 */
export function backtestModeApproval(
  mode: string,
  aboveExpected: boolean,
  statAbove: boolean | null,
  claudeAbove: boolean | null,
  mlAbove: boolean | null,
): boolean {
  // ── classic ───────────────────────────────────────────────────────────────
  // All existing settled bets passed the classic cascade by definition.
  if (mode === "classic") return true;

  // ── ml_gate ───────────────────────────────────────────────────────────────
  // Mirrors kalshi-bot-engine.ts ~lines 316-358:
  //   1. Run core pair (PATH B/C) WITHOUT ML (ml_gate never lets ML lead).
  //   2. If core pair would SKIP → ml_gate skips.
  //   3. If core pair bets opposite direction → ml_gate bets opposite (not counted).
  //   4. If core pair bets same direction → apply ML veto.
  if (mode === "ml_gate") {
    let coreBetDir: boolean | null = null;

    if (claudeAbove !== null) {
      // PATH B: Claude primary.  If Stat is available and disagrees → SKIP
      // (no ML to act as tiebreaker in ml_gate mode).
      if (statAbove !== null && statAbove !== claudeAbove) {
        coreBetDir = null;
      } else {
        coreBetDir = claudeAbove;
      }
    } else if (statAbove !== null) {
      // PATH C: Stat primary (Claude unavailable).
      coreBetDir = statAbove;
    }
    // else: no core signals → core pair SKIPs (coreBetDir stays null)

    if (coreBetDir === null) return false;           // core pair SKIPs
    if (coreBetDir !== aboveExpected) return false;  // core pair bets opposite

    // ML veto: reject if ML is available and disagrees with the direction.
    return mlAbove === null || mlAbove === aboveExpected;
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
