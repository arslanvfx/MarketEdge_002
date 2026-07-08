// Pure directional-outcome accumulation helper.
// No I/O dependencies — importable from unit tests without DB setup.

export type DirectionalOutcomeEntry = {
  yesWins: number;
  yesLosses: number;
  noWins: number;
  noLosses: number;
};

/**
 * Updates a directional-outcomes Map for one settled bet.
 * Mutates the Map in-place; initialises the window entry when absent.
 *
 * @param map       - recentDirectionalOutcomes shared Map
 * @param direction - "yes" | "no" (direction the bet was placed in)
 * @param pnl       - positive = win, negative = loss, 0 = ignored
 * @param windowKey - ISO-8601 15-min window key (YYYY-MM-DDTHH:mm)
 */
export function applyDirectionalOutcome(
  map: Map<string, DirectionalOutcomeEntry>,
  direction: string,
  pnl: number,
  windowKey: string,
): void {
  const dd = map.get(windowKey) ?? { yesWins: 0, yesLosses: 0, noWins: 0, noLosses: 0 };
  if (direction === "yes") {
    if (pnl > 0) dd.yesWins++; else if (pnl < 0) dd.yesLosses++;
  } else if (direction === "no") {
    if (pnl > 0) dd.noWins++; else if (pnl < 0) dd.noLosses++;
  }
  map.set(windowKey, dd);
}

/**
 * Computes the directional regime dampener penalty for one direction.
 * Returns penaltyPp when win rate is below threshold with enough samples,
 * 0 otherwise.
 *
 * @param wins      - number of winning bets in that direction
 * @param losses    - number of losing bets in that direction
 * @param minBets   - minimum sample size required before penalty fires (default 2)
 * @param threshold - win-rate threshold below which penalty fires (default 0.35)
 * @param penaltyPp - penalty in percentage points (default 10)
 * @param freeRun   - when true, always returns 0 (freeRunMode exemption)
 */
export function computeDirectionalPenaltyPp(
  wins: number,
  losses: number,
  minBets: number,
  threshold: number,
  penaltyPp: number,
  freeRun = false,
): number {
  if (freeRun) return 0;
  const total = wins + losses;
  if (total < minBets) return 0;
  return wins / total < threshold ? penaltyPp : 0;
}
