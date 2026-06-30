// ---------------------------------------------------------------------------
// Pure performance-analytics and auto-tune logic.
// No DB or network access — everything takes plain data in, returns plain data
// out so the functions are fully unit-testable.
// ---------------------------------------------------------------------------

export interface SettledBetRecord {
  symbol: string;
  direction: string | null;
  pnl: string | null;
  exitReason: string | null;
  createdAt: string | Date;
  exitedAt: string | Date | null;
  signals: Record<string, unknown> | null;
  outcome: string | null;
}

export interface SymbolStats {
  wins: number;
  losses: number;
  betCount: number;
  winRate: number | null;
  currentConsecutiveLosses: number;
}

export interface HourBandStats {
  band: string;
  wins: number;
  losses: number;
  betCount: number;
  winRate: number | null;
}

export interface DirectionStats {
  wins: number;
  losses: number;
  betCount: number;
  winRate: number | null;
}

export interface ConfidenceBandStats {
  band: string;
  lowerBound: number;
  wins: number;
  losses: number;
  betCount: number;
  winRate: number | null;
}

export interface AgreementLevelStats {
  level: string;
  agreeing: number;
  total: number;
  wins: number;
  losses: number;
  betCount: number;
  winRate: number | null;
}

export interface PerformanceReport {
  totalBets: number;
  wins: number;
  losses: number;
  overallWinRate: number | null;
  last10WinRate: number | null;
  last30WinRate: number | null;
  last24hWinRate: number | null;
  bySymbol: Record<string, SymbolStats>;
  byHourBand: Record<string, HourBandStats>;
  byDirection: { yes: DirectionStats; no: DirectionStats };
  byConfidenceBand: Record<string, ConfidenceBandStats>;
  byAgreementLevel: Record<string, AgreementLevelStats>;
  optimalConfidenceThreshold: number | null;
  avgConfidenceWinners: number | null;
  avgConfidenceLosers: number | null;
  exitReasonBreakdown: Record<string, number>;
  circuitBreakerTriggers: number;
  recommendations: string[];
  computedAt: string;
}

export interface AutoTuneBotConfig {
  minConfidence: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  enableAutoTuning: boolean;
  /** The factory-default minConfidence value — used to gate the lower rule. */
  defaultMinConfidence: number;
}

/**
 * How long (ms) must elapse before the same confidence-floor rule can fire again.
 * 6 hours prevents oscillating up-then-down in back-to-back windows.
 */
export const CONFIDENCE_FLOOR_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

export interface AutoTuneMutation {
  ruleName: string;
  oldValue: string;
  newValue: string;
  triggerReason: string;
  configMutation?: Partial<AutoTuneBotConfig>;
  pauseCoin?: { symbol: string; windows: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

function hourBand(utcHour: number): string {
  const start = Math.floor(utcHour / 2) * 2;
  const end = (start + 2) % 24;
  return `${String(start).padStart(2, "0")}-${String(end).padStart(2, "0")}`;
}

function isHourInQuietRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function extractEffectiveConfidence(signals: Record<string, unknown> | null): number | null {
  if (!signals) return null;
  // Prefer the stored effectiveConfidence (composite post-penalty score logged at bet time)
  const ec = signals["effectiveConfidence"];
  if (typeof ec === "number") return ec;
  // Fall back to individual model confidences
  const c = signals["statConfidence"] ?? signals["claudeConfidence"] ?? signals["confidence"];
  if (typeof c === "number") return c;
  return null;
}

// Kept for backwards compatibility in existing call sites
function extractConfidence(signals: Record<string, unknown> | null): number | null {
  return extractEffectiveConfidence(signals);
}

// ---------------------------------------------------------------------------
// computePerformanceReport
// ---------------------------------------------------------------------------

export function computePerformanceReport(
  bets: SettledBetRecord[],
  nowOverride?: Date,
): PerformanceReport {
  const now = nowOverride ?? new Date();
  const computedAt = now.toISOString();

  const settled = bets.filter(b => b.outcome === "win" || b.outcome === "loss");

  const totalBets = settled.length;
  const wins = settled.filter(b => b.outcome === "win").length;
  const losses = settled.filter(b => b.outcome === "loss").length;
  const overallWinRate = totalBets > 0 ? wins / totalBets : null;

  // Sliding-window win rates (bets must be sorted oldest-first by caller)
  const last10 = settled.slice(-10);
  const last10Wins = last10.filter(b => b.outcome === "win").length;
  const last10WinRate = last10.length > 0 ? last10Wins / last10.length : null;

  const last30 = settled.slice(-30);
  const last30Wins = last30.filter(b => b.outcome === "win").length;
  const last30WinRate = last30.length > 0 ? last30Wins / last30.length : null;

  // Last-24h win rate
  const cutoff24h = now.getTime() - 24 * 60 * 60 * 1000;
  const last24h = settled.filter(b => {
    const ts = b.exitedAt ?? b.createdAt;
    return toDate(ts).getTime() >= cutoff24h;
  });
  const last24hWins = last24h.filter(b => b.outcome === "win").length;
  const last24hWinRate = last24h.length > 0 ? last24hWins / last24h.length : null;

  // Per-symbol stats — bets arrive oldest-first so we iterate in order
  const bySymbol: Record<string, SymbolStats> = {};
  const symBetsChron: Record<string, SettledBetRecord[]> = {};

  for (const b of settled) {
    const sym = (b.symbol ?? "UNKNOWN").toUpperCase();
    if (!bySymbol[sym]) {
      bySymbol[sym] = { wins: 0, losses: 0, betCount: 0, winRate: null, currentConsecutiveLosses: 0 };
      symBetsChron[sym] = [];
    }
    bySymbol[sym].betCount++;
    if (b.outcome === "win") bySymbol[sym].wins++;
    else bySymbol[sym].losses++;
    symBetsChron[sym].push(b);
  }

  for (const sym of Object.keys(bySymbol)) {
    const s = bySymbol[sym];
    s.winRate = s.betCount > 0 ? s.wins / s.betCount : null;

    // Count current consecutive loss streak from most-recent backwards
    let streak = 0;
    const sb = symBetsChron[sym] ?? [];
    for (let i = sb.length - 1; i >= 0; i--) {
      if (sb[i].outcome === "loss") streak++;
      else break;
    }
    s.currentConsecutiveLosses = streak;
  }

  // Per-2h-UTC-band stats
  const byHourBand: Record<string, HourBandStats> = {};
  for (const b of settled) {
    const ts = b.exitedAt ?? b.createdAt;
    const hour = toDate(ts).getUTCHours();
    const band = hourBand(hour);
    if (!byHourBand[band]) byHourBand[band] = { band, wins: 0, losses: 0, betCount: 0, winRate: null };
    byHourBand[band].betCount++;
    if (b.outcome === "win") byHourBand[band].wins++;
    else byHourBand[band].losses++;
  }
  for (const stats of Object.values(byHourBand)) {
    stats.winRate = stats.betCount > 0 ? stats.wins / stats.betCount : null;
  }

  // Per-direction stats
  const byDirection = {
    yes: { wins: 0, losses: 0, betCount: 0, winRate: null as number | null },
    no: { wins: 0, losses: 0, betCount: 0, winRate: null as number | null },
  };
  for (const b of settled) {
    const dir = (b.direction ?? "").toLowerCase();
    if (dir === "yes" || dir === "no") {
      byDirection[dir].betCount++;
      if (b.outcome === "win") byDirection[dir].wins++;
      else byDirection[dir].losses++;
    }
  }
  byDirection.yes.winRate = byDirection.yes.betCount > 0
    ? byDirection.yes.wins / byDirection.yes.betCount : null;
  byDirection.no.winRate = byDirection.no.betCount > 0
    ? byDirection.no.wins / byDirection.no.betCount : null;

  // Confidence band breakdown — 5-point buckets; needs ≥ 5 samples to be meaningful
  const CONF_BANDS = [
    { label: "50-55", lo: 50, hi: 55 },
    { label: "55-60", lo: 55, hi: 60 },
    { label: "60-65", lo: 60, hi: 65 },
    { label: "65-70", lo: 65, hi: 70 },
    { label: "70-75", lo: 70, hi: 75 },
    { label: "75+",   lo: 75, hi: 101 },
  ];
  const byConfidenceBand: Record<string, ConfidenceBandStats> = {};
  for (const { label, lo } of CONF_BANDS) {
    byConfidenceBand[label] = { band: label, lowerBound: lo, wins: 0, losses: 0, betCount: 0, winRate: null };
  }
  for (const b of settled) {
    const conf = extractEffectiveConfidence(b.signals);
    if (conf === null) continue;
    const band = CONF_BANDS.find(({ lo, hi }) => conf >= lo && conf < hi);
    if (!band) continue;
    const s = byConfidenceBand[band.label];
    s.betCount++;
    if (b.outcome === "win") s.wins++;
    else s.losses++;
  }
  for (const s of Object.values(byConfidenceBand)) {
    s.winRate = s.betCount > 0 ? s.wins / s.betCount : null;
  }

  // Optimal threshold: lowest band with ≥ 5 bets AND ≥ 55% win rate
  // Used by the auto-tuner to jump directly to a data-validated floor
  const optimalBand = CONF_BANDS.find(({ label }) => {
    const s = byConfidenceBand[label];
    return s.betCount >= 5 && s.winRate !== null && s.winRate >= 0.55;
  });
  const optimalConfidenceThreshold = optimalBand ? optimalBand.lo : null;

  // Signal agreement breakdown: how many signals agreed when the bet was placed
  const byAgreementLevel: Record<string, AgreementLevelStats> = {};
  for (const b of settled) {
    const signals = b.signals;
    if (!signals) continue;
    const agreeing = typeof signals["signalsAgreeing"] === "number" ? signals["signalsAgreeing"] : null;
    const total = typeof signals["signalsTotal"] === "number" ? signals["signalsTotal"] : null;
    if (agreeing === null || total === null || total === 0) continue;
    const key = `${agreeing}/${total}`;
    if (!byAgreementLevel[key]) {
      byAgreementLevel[key] = { level: key, agreeing, total, wins: 0, losses: 0, betCount: 0, winRate: null };
    }
    byAgreementLevel[key].betCount++;
    if (b.outcome === "win") byAgreementLevel[key].wins++;
    else byAgreementLevel[key].losses++;
  }
  for (const s of Object.values(byAgreementLevel)) {
    s.winRate = s.betCount > 0 ? s.wins / s.betCount : null;
  }

  // Average confidence for winners vs losers
  const winnerConfs = settled
    .filter(b => b.outcome === "win")
    .map(b => extractEffectiveConfidence(b.signals))
    .filter((c): c is number => c !== null);
  const loserConfs = settled
    .filter(b => b.outcome === "loss")
    .map(b => extractEffectiveConfidence(b.signals))
    .filter((c): c is number => c !== null);
  const avgConfidenceWinners = winnerConfs.length > 0
    ? winnerConfs.reduce((a, v) => a + v, 0) / winnerConfs.length : null;
  const avgConfidenceLosers = loserConfs.length > 0
    ? loserConfs.reduce((a, v) => a + v, 0) / loserConfs.length : null;

  // Exit reason breakdown
  const exitReasonBreakdown: Record<string, number> = {};
  for (const b of settled) {
    const r = b.exitReason ?? "unknown";
    exitReasonBreakdown[r] = (exitReasonBreakdown[r] ?? 0) + 1;
  }

  // Circuit breaker trigger count — proxy: count each distinct run where
  // consecutive losses first reach the hard-coded CB threshold of 3.
  const CB_THRESHOLD = 3;
  let cbStreak = 0;
  let cbFiredForStreak = false;
  let circuitBreakerTriggers = 0;
  for (const b of settled) {
    if (b.outcome === "loss") {
      cbStreak++;
      if (!cbFiredForStreak && cbStreak >= CB_THRESHOLD) {
        circuitBreakerTriggers++;
        cbFiredForStreak = true;
      }
    } else {
      cbStreak = 0;
      cbFiredForStreak = false;
    }
  }

  // Human-readable recommendations (top 4)
  const recommendations: string[] = [];

  // Confidence-band insight: if we have a clear winning band, surface it
  const bestConfBand = Object.values(byConfidenceBand)
    .filter(s => s.betCount >= 5 && s.winRate !== null && s.winRate >= 0.60)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
  if (bestConfBand) {
    recommendations.push(
      `Best confidence zone: ${bestConfBand.band}% → ${Math.round((bestConfBand.winRate ?? 0) * 100)}% win rate (${bestConfBand.betCount} bets) — raise confidence floor to ${bestConfBand.lowerBound}%`,
    );
  }

  const worstBands = Object.values(byHourBand)
    .filter(b => b.betCount >= 5 && b.winRate !== null && b.winRate < 0.4)
    .sort((a, b) => (a.winRate ?? 1) - (b.winRate ?? 1));
  if (worstBands.length > 0) {
    const worst = worstBands[0];
    recommendations.push(
      `Add ${worst.band} UTC to quiet hours (${Math.round((worst.winRate ?? 0) * 100)}% win rate, ${worst.betCount} bets)`,
    );
  }

  const sortedByWinRate = Object.entries(bySymbol)
    .filter(([, s]) => s.betCount >= 3 && s.winRate !== null)
    .sort(([, a], [, b]) => (b.winRate ?? 0) - (a.winRate ?? 0));

  if (sortedByWinRate.length > 0) {
    const [sym, stats] = sortedByWinRate[0];
    recommendations.push(
      `${sym} performing best: ${Math.round((stats.winRate ?? 0) * 100)}% win rate (${stats.betCount} bets)`,
    );
  }

  if (sortedByWinRate.length > 1) {
    const [sym, stats] = sortedByWinRate[sortedByWinRate.length - 1];
    recommendations.push(
      `${sym} underperforming: ${Math.round((stats.winRate ?? 0) * 100)}% win rate — consider reducing exposure`,
    );
  }

  if (last30WinRate !== null && last30.length >= 10 && last30WinRate < 0.55 && recommendations.length < 4) {
    const confHint = optimalConfidenceThreshold !== null
      ? ` — data suggests raising floor to ${optimalConfidenceThreshold}%`
      : " — consider raising confidence floor";
    recommendations.push(
      `Win rate ${Math.round(last30WinRate * 100)}% over last ${last30.length} bets${confHint}`,
    );
  }

  return {
    totalBets,
    wins,
    losses,
    overallWinRate,
    last10WinRate,
    last30WinRate,
    last24hWinRate,
    bySymbol,
    byHourBand,
    byDirection,
    byConfidenceBand,
    byAgreementLevel,
    optimalConfidenceThreshold,
    avgConfidenceWinners,
    avgConfidenceLosers,
    exitReasonBreakdown,
    circuitBreakerTriggers,
    recommendations: recommendations.slice(0, 4),
    computedAt,
  };
}

// ---------------------------------------------------------------------------
// decrementPausedCoins — pure helper for per-coin pause countdown
// ---------------------------------------------------------------------------

/**
 * Advance the pause countdown by one window for every paused coin.
 * Coins whose counter reaches 0 are removed (they resume).
 * Returns a new Map — the input is not mutated.
 */
export function decrementPausedCoins(
  pausedCoins: ReadonlyMap<string, number>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [sym, remaining] of pausedCoins.entries()) {
    if (remaining > 1) {
      next.set(sym, remaining - 1);
    }
    // remaining <= 1 → coin resumes; omit from output map
  }
  return next;
}

// ---------------------------------------------------------------------------
// mergeQuietWindow — wrap-around-safe quiet-hour expansion helper
// ---------------------------------------------------------------------------

/**
 * Return the minimal expansion of the quiet window [qS, qE) that also covers
 * the bad band [bS, bE) on a 24-hour clock.  Handles both non-wrapping and
 * midnight-wrapping windows by choosing whichever edge (start or end) requires
 * the smaller angular extension.
 */
export function mergeQuietWindow(
  qS: number, qE: number,
  bS: number, bE: number,
): { quietHoursStart: number; quietHoursEnd: number } {
  // Forward angular distance from a to b on [0, 24)
  const fwd = (a: number, b: number) => (b - a + 24) % 24;

  // Cost to extend the END of the quiet window forward to cover bE
  const costEnd = fwd(qE, bE);
  // Cost to extend the START of the quiet window backward to cover bS
  const costStart = fwd(bS, qS);

  if (costEnd <= costStart) {
    // Extend end forward
    const newEnd = (qE + costEnd) % 24;
    return { quietHoursStart: qS, quietHoursEnd: newEnd };
  } else {
    // Extend start backward
    const newStart = (qS - costStart + 24) % 24;
    return { quietHoursStart: newStart, quietHoursEnd: qE };
  }
}

// ---------------------------------------------------------------------------
// runAutoTuneRules
// ---------------------------------------------------------------------------

/**
 * runAutoTuneRules
 *
 * @param lastFiredAt  Map of ruleName → most-recent Date that rule was applied
 *                     (sourced from bot_auto_tune_log). Used to enforce the
 *                     6-hour cooldown on confidence-floor rules so they cannot
 *                     thrash up-then-down in back-to-back 15-min windows.
 * @param nowOverride  Optional clock override for unit tests.
 */
export function runAutoTuneRules(
  report: PerformanceReport,
  config: AutoTuneBotConfig,
  currentPausedCoins: ReadonlyMap<string, number>,
  lastFiredAt: ReadonlyMap<string, Date> = new Map(),
  nowOverride?: Date,
): AutoTuneMutation[] {
  if (!config.enableAutoTuning) return [];

  const now = nowOverride ?? new Date();
  const mutations: AutoTuneMutation[] = [];

  /**
   * Returns true when the named rule is still within its cooldown window.
   * A rule is on cooldown if it was last applied less than CONFIDENCE_FLOOR_COOLDOWN_MS ago.
   */
  function isOnCooldown(ruleName: string): boolean {
    const last = lastFiredAt.get(ruleName);
    if (!last) return false;
    return now.getTime() - last.getTime() < CONFIDENCE_FLOOR_COOLDOWN_MS;
  }

  // Rule 1 — Quiet-hours auto-expand
  // Any 2-hour UTC band with ≥ 20 bets and < 40% win rate gets flagged for
  // quiet-hour coverage. Only one band is expanded per run to avoid thrashing.
  const worstBands = Object.values(report.byHourBand)
    .filter(b => b.betCount >= 20 && b.winRate !== null && b.winRate < 0.4)
    .sort((a, b) => (a.winRate ?? 1) - (b.winRate ?? 1));

  for (const stats of worstBands.slice(0, 1)) {
    const bandStart = parseInt(stats.band.split("-")[0], 10);
    const bandEnd = (bandStart + 2) % 24;

    // Skip if BOTH hours of the band are already inside the quiet window
    const h0Covered = isHourInQuietRange(bandStart, config.quietHoursStart, config.quietHoursEnd);
    const h1Covered = isHourInQuietRange((bandStart + 1) % 24, config.quietHoursStart, config.quietHoursEnd);
    if (h0Covered && h1Covered) continue;

    // Expand the current quiet window to absorb this band.
    // Use mergeQuietWindow which correctly handles midnight-wrapping windows.
    const newWindow = mergeQuietWindow(
      config.quietHoursStart, config.quietHoursEnd,
      bandStart, bandEnd,
    );

    mutations.push({
      ruleName: "quiet_hours_expand",
      oldValue: `${config.quietHoursStart}-${config.quietHoursEnd}`,
      newValue: `${newWindow.quietHoursStart}-${newWindow.quietHoursEnd}`,
      triggerReason:
        `Hour band ${stats.band} UTC: ${Math.round((stats.winRate ?? 0) * 100)}% win rate over ${stats.betCount} bets (< 40% threshold)`,
      configMutation: newWindow,
    });
    break;
  }

  // Rule 2 — Per-coin auto-pause
  // A coin with ≥ 5 current consecutive losses (not already paused) gets
  // suspended for 4 windows.
  for (const [sym, stats] of Object.entries(report.bySymbol)) {
    if (stats.currentConsecutiveLosses >= 5 && !currentPausedCoins.has(sym)) {
      mutations.push({
        ruleName: "per_coin_pause",
        oldValue: "active",
        newValue: "paused:4windows",
        triggerReason: `${sym}: ${stats.currentConsecutiveLosses} consecutive losses`,
        pauseCoin: { symbol: sym, windows: 4 },
      });
    }
  }

  // Rule 3 — Confidence-floor auto-raise
  // Overall win rate over last 30 bets < 55% → raise floor. Prefers jumping directly
  // to the data-validated optimal threshold (lowest 5-pt band with ≥ 55% win rate and
  // ≥ 5 samples) over a blind +5 so the bot reaches the right level in one step.
  // Guarded by a 6-hour cooldown to prevent thrashing.
  if (
    report.last30WinRate !== null &&
    report.totalBets >= 30 &&
    report.last30WinRate < 0.55 &&
    config.minConfidence < 80 &&
    !isOnCooldown("confidence_floor_raise")
  ) {
    // Prefer the data-driven optimal threshold over blind +5 when available and higher
    const dataTarget = report.optimalConfidenceThreshold;
    const blindTarget = config.minConfidence + 5;
    const newConfidence = Math.min(
      80,
      dataTarget !== null && dataTarget > config.minConfidence ? dataTarget : blindTarget,
    );
    const triggerReason = dataTarget !== null && dataTarget > config.minConfidence
      ? `Data-driven: ${dataTarget}% is lowest confidence band with ≥55% win rate ` +
        `(last-30 WR: ${Math.round(report.last30WinRate * 100)}%)`
      : `Win rate ${Math.round(report.last30WinRate * 100)}% over last 30 bets is below 55% — raising +5`;
    mutations.push({
      ruleName: "confidence_floor_raise",
      oldValue: String(config.minConfidence),
      newValue: String(newConfidence),
      triggerReason,
      configMutation: { minConfidence: newConfidence },
    });
  }

  // Rule 4 — Confidence-floor auto-lower (symmetrical to Rule 3)
  // Win rate over last 30 bets > 70% AND current floor is above the factory
  // default → lower minConfidence -5 (floor: defaultMinConfidence).
  // Also guarded by a 6-hour cooldown shared with the raise rule so the two
  // rules cannot fire in alternating windows and thrash the floor value.
  const canLower =
    report.last30WinRate !== null &&
    report.totalBets >= 30 &&
    report.last30WinRate > 0.70 &&
    config.minConfidence > config.defaultMinConfidence;

  if (canLower && !isOnCooldown("confidence_floor_raise") && !isOnCooldown("confidence_floor_lower")) {
    const newConfidence = Math.max(config.defaultMinConfidence, config.minConfidence - 5);
    mutations.push({
      ruleName: "confidence_floor_lower",
      oldValue: String(config.minConfidence),
      newValue: String(newConfidence),
      triggerReason:
        `Win rate ${Math.round((report.last30WinRate ?? 0) * 100)}% over last 30 bets exceeds 70% threshold — relaxing confidence floor`,
      configMutation: { minConfidence: newConfidence },
    });
  }

  return mutations;
}
