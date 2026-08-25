// ─── Types ──────────────────────────────────────────────────────────────────

export type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous" | "conviction";

export interface RegularUnresolvedIntent {
  clientOrderId: string;
  status: "reserved" | "unknown";
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  requestedCount: number;
  limitPrice: number | null;
  reason: string | null;
  reconciliationReason: string | null;
  createdAt: string;
  lastReconciledAt: string | null;
}

export interface QuietHoursV2 {
  enabled: boolean;

  silencedUtcHours: number[];                    // UTC hours 0–23 silenced every day

  autoTuneEnabled?: boolean;
  autoTuneDays?: number;
  autoTuneThreshold?: number;
  autoTuneIntervalHours?: number;                // how often auto-tune runs: 1 | 2 | 4 | 6 | 12

  reducedBetUtcHours: Record<string, number>;    // UTC hour → % reduction 1–99 (all days)
  // Per-day-of-week overrides (JS getUTCDay(): "0"=Sun, "1"=Mon, …, "6"=Sat)
  silencedByDow?: Record<string, number[]>;               // dow → UTC hours silenced on that day only
  reducedByDow?:  Record<string, Record<string, number>>; // dow → utcHour → % reduction 1–99 that day only
  dataGatheringByDow?: Record<string, number[]>;          // dow → UTC hours with ≤2 bets (capped when collection is on; blocked when off)
  /** Per-cell overrides: operator can set a custom $ cap or promote to % of global bet (removes $ cap). */
  dataGatheringOverrides?: Record<string, Record<string, { type: 'dollar'; amount: number } | { type: 'percent'; pct: number }>>;
  calibratedAt?: string;  // ISO timestamp — set by Calibrate All
}

export interface QuietHoursHourStat {
  utcHour: number;
  totalBets: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  totalPnl: number;
  avgPnl: number;
}

export interface QuietHoursAnalysis {
  hourStats: QuietHoursHourStat[];
  suggestedSilencedHours: number[];
  days: number;
  targetWinRate: number;
  dow?: string;                                           // "all" | "weekday" | "weekend" | "0"–"6"
  hourStatsByDow?: Record<string, QuietHoursHourStat[]>; // keyed "0"–"6"
}

export interface BotConfig {
  betSize: number;
  dailyLossLimit: number;
  signalThreshold: number;
  minConfidence: number;
  decisionMode: DecisionMode;
  paperDecisionMode?: DecisionMode;
  liveDecisionMode?: DecisionMode;
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number;
  maxEntryMinutes: number;
  minRemainingMinutes: number;
  maxBetsPerWindow: number;
  enabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietHoursV2?: QuietHoursV2;
  quietHoursMode?: 'global' | 'per_market';
  perSymbolQuietHours?: Record<string, QuietHoursV2>;
  dataGatheringBetCap?: number;  // $ cap for hours with ≤ 2 historical bets (default 1.00)
  dataGatheringEnabled?: boolean; // master switch (default true); when false, sparse hours are blocked
  maxConsecutiveLosses: number;
  circuitBreakerPauseWindows: number;
  enableDirectionCap: boolean;
  maxSameDirectionBets: number;
  enableMomentumFilter: boolean;
  momentumWindowCount: number;
  enableAutoTuning: boolean;
  autoTuneWindowSize: number;
  enableBorderGuard: boolean;
  borderProximityPct: number;
  borderLookbackBets: number;
  requireMonitorReady: boolean;
  regimePenalty: number;
  mlVetoMinConfidence: number;
  betProfile: "normal" | "aggressive";
  paperStartingBalance: number;
  paperWinReturnRate: number;
  shadowPaperBets?: boolean;
  shadowPaperIgnoreQuietHours?: boolean;
  paperBalanceResetAt: string | null;
  liveStatsResetAt: string | null;
  paperStatsResetAt: string | null;
  maxBetSize: number;
  minAccountBalance: number;
  maxTotalExposure: number;
  maxDailyLossPerCoin: number;
  coinStreakLossLimit: number;
  coinStreakPauseWindows: number;
  maxSlippageCents: number;
  minReturnMultiple: number;
  enableDynamicSizing: boolean;
  dynamicSizingMaxConfidence: number;
  profitLockPct: number;
  freeRunMode?: boolean;
  consensusMinCents: number;
  momentumLookbackCandles: number;
  windowEntryBufferSeconds?: number;
  minWindowEntryMinutes?: number;
  convictionEarlyBypassEnabled?: boolean;
  convictionEarlyBypassThreshold?: number;
  convictionEarlyBypassCap?: number;
  betDelayMinutes?: number;
  minHoldMinutes?: number;
  enableMidExit?: boolean;
  disableMidExitForConviction?: boolean;
  enableTimeStop?: boolean;
  coinStreakPenalty1LossPp?: number;
  coinStreakPenalty2PlusLossPp?: number;
  unanimousMinModelConfidence?: number;
  directionalRegressionLookback?: number;
  directionalRegressionThreshold?: number;
  directionalRegressionPenaltyPp?: number;
  priceBufferPct?: number;
  kalshiLockPrice?: number;
  proximityGuardEnabled?: boolean;
  proximityEarlyPct?: number;
  proximityLatePct?: number;
  proximityLateWindowMinutes?: number;
  proximityEarlyPctOverrides?: Record<string, number>;
  proximityLatePctOverrides?: Record<string, number>;
  convictionDailyLossLimit?: number;
  convictionMaxDailySpend?: number;
  convictionStopLossFloor?: number;
  convictionStopLossActivationMinute?: number;
  convictionMinEntryMinutes?: number;
  perMarketConvictionConfig?: Record<string, {
    lockPrice?: number | null;
    lockPriceCap?: number | null;
    minEntryMinute?: number | null;
  } | null>;
  convictionBoostBetSize?: number;
  convictionBoostProbability?: number;
  convictionBoostMinWinRate?: number;
  statRegimeBoostEnabled?: boolean;
  statRegimeBoostMinER?: number;
  statRegimeBoostMaxOscillations?: number;
  convictionStabilityEnabled?: boolean;
  convictionStabilityMinER?: number;
  convictionStabilityMaxOsc?: number;
  convictionStabilityMaxVolPct?: number;
  convictionStabilityMinMLConf?: number;
  convictionStabilityMaxBetProbability?: number;
  convictionStabilityMaxBetsPerWindow?: number;
  maxBetMinWindowEntryMinutes?: number;
  allowLateEntries?: boolean;
  coinOverrides?: Record<string, { paused?: boolean; maxBetSize?: number }>;
  maxBetTrajectoryEnabled?: boolean;
  regularBetTrajectoryEnabled?: boolean;
  maxBetTrajectoryLookbackMinutes?: number;
  maxBetTrajectoryDangerBandPct?: number;
  maxBetTrajectoryCurrentMarginMinPct?: number;
  maxBetTrajectoryFinalMinutes?: number;
  maxBetTrajectoryBlockOnCross?: boolean;
  maxBetTrajectoryMinVelocityATR?: number;
  extremeCautionEnabled?: boolean;
  extremeCautionBetOverride?: number | null;
  timeBetScheduleEnabled?: boolean;
  timeBetSchedule?: Array<{ minutesElapsed: number; betAmount: number }>;
  betRandomizerEnabled?: boolean;
  betRandomizerValues?: number[];
  convictionCatastrophicFillThresholdCents?: number;
  convictionDirectionGuardEnabled?: boolean;
  convictionDirectionGuardMinSeconds?: number;
  convictionDirectionLookbackCandles?: number;
  kalshiLockPriceCap?: number;
  strikeProximityMinPct?: number;
  strikeProximityAtrScale?: boolean;
  strikeProximityMinPctOverrides?: Record<string, number>;
  lockPrice082Migrated?: boolean;
}

export interface TrajectoryGateResult {
  symbol: string;
  blocked: boolean;
  reason: "projected_cross" | "gate_inactive" | "insufficient_data" | "adverse_momentum_to_cross" | null;
  velocity: number;
  projectedPrice: number;
  currentMarginPct: number;
  projectedMarginPct: number;
  minutesRemaining: number;
  direction: "yes" | "no";
  computedAt: number;
  atrPct: number;
  effectiveCurrentMarginMinPct: number;
  effectiveDangerBandPct: number;
  timeWeight: number;
  adverseVelocity: boolean;
}

export interface LogicModeStats {
  mode: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  avgConfidence: number | null;
}

export interface BacktestModeStats {
  mode: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  coverage: number;
}

export interface OpenPosition {
  id: string; symbol: string; windowKey: string; ticker: string;
  direction: "yes" | "no"; entryYesPrice: number; contractCount: number;
  betAmount: number; kalshiTarget: number; openedAt: number;
  cryptoPriceAtEntry: number | null;
  currentYesPrice: number | null;
  unrealizedPnl: number | null;
  guardStates: GuardStates | null;
  guardReason: string | null;
  source?: "bot" | "manual" | "scalper";
  mode?: "paper" | "live";
  decisionMode?: string;
  entrySignals?: { statAbove: boolean | null; claudeAbove: boolean | null; mlAbove: boolean | null };
}

export interface GuardStates {
  holdDurationMet?: boolean; flipConfirmed?: boolean;
  erSupports?: boolean; timingSupports?: boolean; phase2Active?: boolean;
  [key: string]: boolean | undefined;
}

/** Effective Smart Hours entry mode for a single symbol (server-resolved). */
export type SymbolSmartHoursMode = "active" | "silenced" | "reduced" | "no-schedule";

export interface BotStatus {
  mode: "paper" | "live"; status: string; paused: boolean;
  config: BotConfig; openPositions: OpenPosition[];
  dailyPnl: number; dailySpendAmount: number; accountBalance: number | null;
  warmupSecondsRemaining: number | null; configured: boolean;
  circuitBreakerWindowsRemaining: number;
  consecutiveLosses: number;
  isInQuietHours: boolean;
  quietHoursV2State?: { mode: "active" | "silenced" | "reduced"; reducedBetAmount?: number; utcHour: number };
  autoTuneQHLastRunAt?: string | null;
  autoTuneQHLastChanges?: { silenced: number[]; unsilenced: number[] } | null;
  dbDegraded?: boolean;
  dbDegradedSince?: string | null;
  isProductionEnv?: boolean;
  mlStatus?: {
    ready: boolean; readyCount: number; totalCount: number;
    minWindows: number; minRequired: number;
  };
  coinStreakState?: Record<string, { consecutiveLosses: number; pauseUntilWindowKey: string | null }>;
  convictionPollerRunning?: boolean;
  convictionPriceAgeMs?: Record<string, number>;
  /** Whether Smart Hours is in global or per-market mode. */
  smartHoursScope?: "global" | "per_market";
  /**
   * Per-symbol effective Smart Hours mode resolved on the server.
   * Keys are upper-case symbols (BTC, ETH, …).
   * "no-schedule" = per-market mode is active but no schedule is configured for this symbol.
   */
  symbolSmartHoursModes?: Record<string, SymbolSmartHoursMode>;
  /** ISO timestamp at which symbolSmartHoursModes was resolved. */
  symbolSmartHoursResolvedAt?: string;
}

export interface HistoryRecord {
  id: string; symbol: string; windowKey: string; ticker: string | null;
  direction: string | null; action: string; mode: string;
  signals: Record<string, unknown> | null;
  entryPrice: string | null; exitPrice: string | null;
  contractCount: number | null; betAmount: string | null;
  pnl: string | null; exitReason: string | null;
  phase2Activated: boolean | null; outcome: string | null;
  kalshiTarget: string | null;
  cryptoPriceAtEntry: string | null; cryptoPriceAtExit: string | null;
  createdAt: string; exitedAt: string | null;
  decisionMode: string | null;
  source: string | null;
  entryYesPrice: string | null;
}

export interface ConvictionPriceBand {
  band: string;
  lowerBound: number;
  upperBound: number;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
}

export interface ConvictionThresholdData {
  bands: ConvictionPriceBand[];
  suggestedLockPrice: number | null;
  totalBets: number;
}

export interface WindowEval {
  symbol: string; action: "BET_YES" | "BET_NO" | "SKIP";
  confidence: number; score: number; reason: string;
  windowKey: string; selected: boolean; betPlacedThisWindow: boolean; evaluatedAt: string;
  placedBetDirection?: "yes" | "no";
  placedBetConfidence?: number;
  trendStability: "clean" | "choppy" | "reversing" | null;
  regime: "trending_up" | "trending_down" | "ranging" | null;
}

export interface BotConditionsSnapshot {
  windowKey: string;
  mode: "paper" | "live";
  freeRunMode: boolean;
  botEnabled: boolean;
  botPaused: boolean;
  isInQuietHours: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietHoursV2State?: { mode: "active" | "silenced" | "reduced"; reducedBetAmount?: number; utcHour: number };
  circuitBreakerActive: boolean;
  circuitBreakerWindowsRemaining: number;
  dailyLimitHit: boolean;
  dailyPnl: number;
  dailyLossLimit: number;
  dbDegraded: boolean;
  doubtPenaltyPp: number;
  unanimousFailurePenaltyPp: number;
  warmupSecondsRemaining: number;
  directionCapEnabled: boolean;
  maxSameDirectionBets: number;
  directionCountYes: number;
  directionCountNo: number;
  maxBetsPerWindow: number;
  totalBetsThisWindow: number;
  /** Whether Smart Hours is in global or per-market mode. */
  smartHoursScope?: "global" | "per_market";
  /**
   * Per-symbol effective Smart Hours mode resolved via the server canonical resolver.
   * "no-schedule" = per-market mode but no schedule configured (entries proceed active).
   * Only present in responses from servers that support this field.
   */
  symbolSmartHoursModes?: Record<string, SymbolSmartHoursMode>;
  /** ISO timestamp at which symbolSmartHoursModes was resolved. */
  symbolSmartHoursResolvedAt?: string;
  emptyBookBlockedCoins: string[];
  emptyBookAttempts: Record<string, number>;
  nearStrikeFilteredCoins: string[];
  yesBlockedCoins: string[];
  fullyBlockedCoins: string[];
  autoTunePausedCoins: Record<string, number>;
}

export interface BotStats {
  totalBets: number; wins: number; losses: number; totalPnl: number;
  paperBets: number; liveBets: number;
  bySymbol: Array<{ symbol: string; bets: number; wins: number; losses: number; pnl: number }>;
}

export interface SymbolStats {
  wins: number; losses: number; betCount: number; winRate: number | null;
  currentConsecutiveLosses: number;
}

export interface HourBandStats {
  band: string; wins: number; losses: number; betCount: number; winRate: number | null;
}

export interface DirectionStats {
  wins: number; losses: number; betCount: number; winRate: number | null;
}

export interface ConfidenceBandStats {
  band: string; lowerBound: number;
  wins: number; losses: number; betCount: number; winRate: number | null;
}

export interface AgreementLevelStats {
  level: string; agreeing: number; total: number;
  wins: number; losses: number; betCount: number; winRate: number | null;
}

export interface DayOfWeekStats {
  day: number; dayName: string;
  wins: number; losses: number; betCount: number; winRate: number | null;
}
export interface HourOfDayStats {
  hour: number;
  wins: number; losses: number; betCount: number; winRate: number | null;
}
export interface MaxBetStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  regularTotal: number;
  regularWins: number;
  regularLosses: number;
  regularWinRate: number | null;
  regularTotalPnl: number;
}

export interface PerformanceReport {
  totalBets: number; wins: number; losses: number;
  overallWinRate: number | null;
  last10WinRate: number | null;
  last30WinRate: number | null;
  last24hWinRate: number | null;
  bySymbol: Record<string, SymbolStats>;
  byHourBand: Record<string, HourBandStats>;
  byDirection: { yes: DirectionStats; no: DirectionStats };
  byConfidenceBand: Record<string, ConfidenceBandStats>;
  byAgreementLevel: Record<string, AgreementLevelStats>;
  byDayOfWeek: Record<string, DayOfWeekStats>;
  byHourOfDay: Record<string, HourOfDayStats>;
  optimalConfidenceThreshold: number | null;
  avgConfidenceWinners: number | null; avgConfidenceLosers: number | null;
  exitReasonBreakdown: Record<string, number>;
  circuitBreakerTriggers: number;
  maxBetStats?: MaxBetStats;
  recommendations: string[];
  computedAt: string;
}

export interface AutoTuneLogEntry {
  id: number; createdAt: string;
  ruleName: string; oldValue: string | null; newValue: string | null;
  triggerReason: string;
}

export interface PipelineResult {
  sym: string;
  windowKey: string;
  completedAt: number;
  kalshiTarget: number;
  statAbove: boolean | null;
  statConfidence: number | null;
  claudeAbove: boolean | null;
  claudeConfidence: number | null;
  mlAbove: boolean | null;
  mlConfidence: number | null;
  claudeCallMs: number;
  isRecheck: boolean;
}

export interface CoinSignals {
  statAbove: boolean | null;
  statConfidence: number | null;
  claudeAbove: boolean | null;
  claudeConfidence: number | null;
  mlAbove: boolean | null;
  mlConfidence: number | null;
  wmRecommendation: "bet" | "caution" | "stay_away" | null;
  wmReady: boolean;
  claudeEnabled: boolean;
}

export interface GapBandRow {
  band: string;
  lowerPct: number;
  upperPct: number;
  bets: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

export interface GapAnalyticsResult {
  bands: GapBandRow[];
  byCoin: Record<string, GapBandRow[]>;
  totalBets: number;
  lastUpdated: string;
}

export interface CoinStabilityResult {
  stable: boolean;
  er: number;
  osc: number;
  volPct: number;
  mlConf: number | null;
  windowKey: string;
  computedAt: number;
  strikeGapPct?: number | null;  // |livePrice − kalshiStrike| / kalshiStrike × 100; null when unavailable
}

export interface BotStepSignal {
  above: boolean | null;
  confidence: number | null;
}

export interface BotStepMath {
  mlConf: number;        // raw ML confidence
  mlContrib: number;     // round(mlConf × ML_WEIGHT)
  claudeConf: number;    // raw Claude confidence
  claudeContrib: number; // round(claudeConf × CLAUDE_WEIGHT)
  statMod: number;       // ±STAT_BOOST (signed)
  composite: number;
  statAgrees: boolean;
  directionalPenalty?: { yes: number; no: number }; // active directional regime dampener pp
}

export interface BotStepOpeningCall {
  direction: "YES" | "NO" | null;
  decision: string;
  claudeConf: number | null;
  composite: number | null;
}

export interface BotStepEntry {
  sym: string;
  strike: number | null;
  stat: BotStepSignal;
  claude: BotStepSignal & { enabled: boolean };
  ml: BotStepSignal;
  ready: boolean;
  direction: "YES" | "NO" | null;
  decision: "WAITING" | "NO_MARKET" | "VETO" | "BET_YES" | "BET_NO" | "BELOW_MIN";
  vetoReason: string | null;
  math: BotStepMath | null;
  openingCall: BotStepOpeningCall | null;
}

export type PipelinePhase =
  | "waiting-target"
  | "fetching-data"
  | "claude-analyzing"
  | "ml-analyzing"
  | "ready";

export interface InFlightEntry {
  sym: string;
  windowKey: string;
  isRecheck: boolean;
  phase: PipelinePhase;
}

export interface CoinGuardEntry {
  symbol: string;
  dailyLoss: number;
  consecutiveLosses: number;
  pauseUntilWindowKey: string | null;
  slippageStrikes: number;
}

export interface CoinGuardState {
  coins: CoinGuardEntry[];
  maxDailyLossPerCoin: number;
}

export interface ScalperConfig {
  enabled: boolean;
  mode: "paper" | "live";
  globalBandMin: number;
  globalBandMax: number;
  finalWindowSeconds: number;
  budgetDollars: number;
  dailyCapDollars: number | null;
  openCapDollars: number;
  freefallGuardEnabled: boolean;
  freefallConsecutiveSeconds: number;
  favorableTrendConfirmationEnabled: boolean;
  coordinatedDirectionClearanceEnabled: boolean;
  adverseExcursionGuardEnabled: boolean;
  adverseExcursionLookbackSeconds: number;
  adverseExcursionThresholdPct: number;
  adverseExcursionRecoverySeconds: number;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
  rapidMoveGuardEnabled: boolean;
  rapidMoveLookbackSeconds: number;
  rapidMoveThresholdPct: number;
  targetProximityGuardEnabled: boolean;
  targetProximityThresholdPct: number;
  circuitBreakerEnabled: boolean;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
  perMarketOverrides: Array<{
    symbol: string;
    paused?: boolean;
    minBand?: number | null;
    maxBand?: number | null;
    windowSeconds?: number | null;
    budgetDollars?: number | null;
  }>;
}

export type ScalpTimingPhase =
  | "preflight_warmup"
  | "waiting_eligibility"
  | "eligible"
  | "closed_expired";

export interface ScalpSkipEvidence {
  timingPhase?: ScalpTimingPhase;
  closeTimeIso?: string;
  secondsRemaining?: number | null;
  effectiveWindowSeconds?: number;
  windowKey?: string;
  distancePct?: number | null;
  minimumPct?: number | null;
  targetPrice?: number | null;
  underlyingPrice?: number | null;
  adverseMovePct?: number | null;
  adverseExcursionBlocked?: boolean | null;
  adverseExcursionPct?: number | null;
  adverseExcursionLookbackSeconds?: number | null;
  adverseExcursionRecoverySeconds?: number | null;
  adverseExcursionRecoverySamples?: number | null;
  adverseExcursionTriggeredAt?: string | null;
  freefallThresholdPct?: number | null;
  freefallConsecutiveSeconds?: number | null;
  consecutiveWrongWayMoves?: number | null;
  consecutiveWrongWaySeconds?: number | null;
  directionalMovePct?: number | null;
  favorableTrendMinimumPct?: number | null;
  uniqueDirectionalSamples?: number | null;
  wrongWayResetCount?: number | null;
  lastWrongWayResetAt?: string | null;
  favorableTrendConfirmationEnabled?: boolean | null;
  favorableTrendConfirmed?: boolean | null;
  favorableTrendReason?: string | null;
  coordinatedDirectionClearanceEnabled?: boolean | null;
  coordinatedDirectionClearanceApplied?: boolean | null;
  coordinatedDirectionClearanceSafe?: boolean | null;
  coordinatedDirectionClearanceReason?: string | null;
  adversePacePctPerSecond?: number | null;
  projectedAdverseMovePct?: number | null;
  projectedDistancePct?: number | null;
  projectedPrice?: number | null;
  targetSideWindowConfirmed?: boolean | null;
  targetSideViolationPrice?: number | null;
  targetSideViolationAt?: string | null;
  rapidMoveBlocked?: boolean | null;
  rapidMovePct?: number | null;
  rapidMoveThresholdPct?: number | null;
  rapidMoveLookbackSeconds?: number | null;
  samplesUsed?: number | null;
  sampleCoverageMs?: number | null;
  protectedSide?: "yes" | "no" | null;
  quotedReason?: string | null;
  identityReason?: string | null;
  quoteFetchOk?: boolean | null;
  identityFetchOk?: boolean | null;
  quoteYesAsk?: number | null;
  quoteNoAsk?: number | null;
  winningAsk?: number | null;
  selectedSide?: "yes" | "no" | null;
  bandMin?: number | null;
  bandMax?: number | null;
  reservedTicker?: string | null;
  refreshedTicker?: string | null;
  refreshedCloseTimeIso?: string | null;
  elapsedMs?: number | null;
  identityRefreshMs?: number | null;
  quoteRefreshMs?: number | null;
  parallelRefreshMs?: number | null;
  skippedAt?: string;
  requestedBudget?: number | null;
  dailyCapDollars?: number | null;
  openCapDollars?: number | null;
  dailyCommittedDollars?: number | null;
  openCommittedDollars?: number | null;
  availableBalance?: number | null;
  maxExposure?: number | null;
  principalExposure?: number | null;
  estimatedFee?: number | null;
  safetyMargin?: number | null;
  totalRequired?: number | null;
  regularPositionId?: string | null;
  regularPositionSide?: "yes" | "no" | null;
  layerDecision?: "same_side_layer" | "opposite_side_block" | null;
}

export interface ScalperStatusMarket {
  symbol: string;
  state: string;
  timingPhase: ScalpTimingPhase;
  effectiveBandMin: number;
  effectiveBandMax: number;
  effectiveWindowSeconds: number;
  effectiveBudgetDollars: number;
  lastAsk: number | null;
  secondsRemaining: number | null;
  secondsUntilEligible: number | null;
  freefallBlocked: boolean;
  freefallSamplesUsed: number;
  freefallRequiredSamples: number;
  freefallObservationSeconds: number;
  freefallMovementPct: number | null;
  rapidMoveBlocked: boolean;
  targetProximityBlocked: boolean;
  targetDistancePct: number | null;
  reason: string | null;
}

export type ScalperLatencyStage =
  | "queue_wait"
  | "cap_claim"
  | "parallel_refresh"
  | "final_requote"
  | "intent_write"
  | "broker_submit"
  | "decision_finalize";

export interface ScalperLatencyStageSummary {
  stage: ScalperLatencyStage;
  sampleSize: number;
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface ScalperStatus {
  config: ScalperConfig;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
  circuitBreakerMessage: string;
  mode: "paper" | "live";
  totalReservationsToday: number;
  openSpend: number;
  dailySpend: number;
  recentOrders: ScalpOrder[];
  recentAttempts: ScalperAttempt[];
  latency: {
    sampleSize: number;
    p50Ms: number | null;
    p90Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
    stages: ScalperLatencyStageSummary[];
    dominantStage: ScalperLatencyStage | null;
    dominantStageP90Ms: number | null;
  };
  scanHealth: {
    running: boolean;
    followUpPending: boolean;
    attemptsInFlight: number;
    shadowObservationPending: boolean;
  };
  incidents: any[];
  lastScanAt: string | null;
  lastError: string | null;
  preflight: {
    state: "idle" | "warming" | "ready" | "blocked";
    mode: "paper" | "live";
    windowKey: string | null;
    checkedAt: string | null;
    startsInSeconds: number | null;
    readySymbols: number;
    totalSymbols: number;
    reason: string | null;
    availableBalance: number | null;
    dailyCommitted: number | null;
    openCommitted: number | null;
    markets: Array<{
      symbol: string;
      ready: boolean;
      reason: string | null;
    }>;
  };
  executionPolicy: {
    scanIntervalMs: number;
    authenticatedRetryCooldownMs: number;
    maxSubmissionsPerWindow: number;
    maxConcurrentCandidates: number;
    maxConcurrentBackgroundSamples: number;
    preflightLeadSeconds: number;
  };
  markets: ScalperStatusMarket[];
  unresolvedAttempts?: ScalperUnresolvedAttempt[];
}

export interface ScalperUnresolvedAttempt {
  attemptId: string;
  orderRecordId: string | null;
  reservationId: string | null;
  mode: "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  status: string;
  side: "yes" | "no" | null;
  contractCount: number | null;
  limitPrice: number | null;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  reason: string | null;
  reservedBudget: number;
  createdAt: string;
}

export interface EntryGuardEvidence {
  schemaVersion: 1;
  phase: "final_pre_submit";
  evaluatedAt: string;
  side: "yes" | "no";
  directionGuardEnabled: boolean;
  favorableTrendConfirmationEnabled?: boolean;
  coordinatedDirectionClearanceEnabled?: boolean;
  rapidMoveGuardEnabled: boolean;
  targetProximityGuardEnabled: boolean;
  samples: Array<{ at: string; price: number }>;
  sampleCoverageMs: number | null;
  samplesUsed: number | null;
  wrongWayResetCount: number | null;
  lastWrongWayResetAt: string | null;
  consecutiveWrongWayMoves: number | null;
  consecutiveWrongWaySeconds: number | null;
  directionalMovePct: number | null;
  favorableTrendMinimumPct?: number | null;
  uniqueDirectionalSamples?: number | null;
  favorableTrendConfirmed?: boolean | null;
  favorableTrendReason?: string | null;
  coordinatedDirectionClearanceApplied?: boolean;
  coordinatedDirectionClearanceSafe?: boolean | null;
  coordinatedDirectionClearanceReason?: string | null;
  adversePacePctPerSecond?: number | null;
  projectedAdverseMovePct?: number | null;
  projectedDistancePct?: number | null;
  projectedPrice?: number | null;
  secondsRemaining?: number | null;
  targetSideWindowConfirmed?: boolean | null;
  targetSideViolationPrice?: number | null;
  targetSideViolationAt?: string | null;
  freefallConsecutiveSeconds: number | null;
  rapidMovePct: number | null;
  rapidMoveThresholdPct: number | null;
  rapidMoveLookbackSeconds: number | null;
  distancePct: number | null;
  minimumPct: number | null;
  targetPrice: number | null;
  underlyingPrice: number | null;
  principalExposure?: number | null;
  estimatedFee?: number | null;
  safetyMargin?: number | null;
  totalRequired?: number | null;
  availableBalance?: number | null;
}

export interface ScalperAttempt {
  id: string;
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  status: "claimed" | "filled" | "zero_fill" | "error" | "skipped" | "unknown";
  reason: string | null;
  reservedBudget: number;
  submissionCount: number;
  side: "yes" | "no" | null;
  observedWinningAsk: number | null;
  executionWinningLimit: number | null;
  submittedLimitPrice: number | null;
  layeredRegularPositionId: string | null;
  layeredRegularSide: "yes" | "no" | null;
  skipEvidence: ScalpSkipEvidence | null;
  entryGuardEvidence: EntryGuardEvidence | null;
  reconciliationEvidence?: Record<string, unknown> | null;
  latency?: {
    mode: "paper" | "live";
    symbol: string;
    windowKey: string;
    detectedAt: string;
    completedAt: string;
    windowRemainingAtDetectedMs: number | null;
    windowRemainingAtCompletionMs: number | null;
    windowExpiredDuringAttempt: boolean;
    totalMs: number;
    queueWaitMs: number | null;
    capClaimMs: number | null;
    identityRefreshMs: number | null;
    quoteRefreshMs: number | null;
    parallelRefreshMs: number | null;
    finalRequoteMs: number | null;
    intentWriteMs: number | null;
    brokerSubmitMs: number | null;
    decisionFinalizeMs: number | null;
    slowestStage: ScalperLatencyStage | null;
    slowestStageMs: number | null;
  } | null;
  retryEligible: boolean;
  retryState: "ready" | "cooldown" | "in_flight" | "terminal";
  retryAfterMs: number | null;
  createdAt: string;
  attemptedAt: string;
}

export interface ScalpOrder {
  id: string;
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  entryYesPrice: number;
  contractCount: number;
  budgetSpent: number;
  orderId: string | null;
  filledCount: number;
  avgFillPrice: number | null;
  limitPrice: number;
  status: string;
  error: string | null;
  settlementResult: string | null;
  outcome: "win" | "loss" | "open" | null;
  pnl: number | null;
  incidentId: string | null;
  layeredRegularPositionId: string | null;
  layeredRegularSide: "yes" | "no" | null;
  entryGuardEvidence: EntryGuardEvidence | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ScalperPerformanceBySymbol {
  symbol: string;
  orders: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  spent: number;
  avgFillPrice: number | null;
}

export interface ScalperPerformance {
  mode: "paper" | "live";
  trackingSince: string;
  trackingVersion: number;
  totalOrders: number;
  filledOrders: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  totalSpent: number;
  avgFillPrice: number | null;
  bySymbol: ScalperPerformanceBySymbol[];
}

export interface ScalperWindowFunnel {
  windowKey: string;
  candidateSymbols: number;
  eligibleQuotes: number;
  finalQuoteLoss: number;
  safetyBlocks: number;
  submissions: number;
  zeroFills: number;
  confirmedFills: number;
  lastActivityAt: string;
}

export interface ScalperWindowFunnelReport {
  mode: "paper" | "live";
  targetMinFills: number;
  targetMaxFills: number;
  activeWindows: number;
  averageConfirmedFills: number | null;
  windowsAtTarget: number;
  windows: ScalperWindowFunnel[];
}

export interface ScalperShadowStudyRecord {
  mode: "paper" | "live";
  windowKey: string;
  symbol: string;
  ticker: string;
  variantSeconds: number;
  status: "observing" | "candidate_found" | "closed_no_candidate" | "settled";
  firstEligibleAt: string;
  firstSafeEntryAt: string | null;
  firstSafeSecondsRemaining: number | null;
  side: "yes" | "no" | null;
  yesAsk: number | null;
  noAsk: number | null;
  winningAsk: number | null;
  hypotheticalContracts: number;
  hypotheticalBudget: number;
  lastBlocker: string | null;
  blockerCounts: Record<string, number>;
  entryEvidence: Record<string, unknown> | null;
  laterQuoteIssueObserved: boolean;
  laterQuoteIssueReason: "invalid" | "outside_band" | null;
  settlementResult: "yes" | "no" | null;
  outcome: "win" | "loss" | null;
  hypotheticalPnl: number | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface ScalperShadowVariantSummary {
  variantSeconds: number;
  observed: number;
  candidates: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  candidatesBeforeLaterQuoteIssue: number;
  averageFirstSafeSecondsRemaining: number | null;
  hypotheticalPnl: number;
}

export interface ScalperShadowActualSummary {
  periodStart: string;
  periodEnd: string;
  filledOrders: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  totalSpent: number;
}

export interface ScalperShadowComparisonCoverage {
  sharedOpportunities: number;
  excludedIncompleteOpportunities: number;
  coverageStart: string | null;
}

export interface ScalperShadowStudyReport {
  mode: "paper" | "live";
  configuredWindowSeconds: number;
  effectiveWindowSecondsBySymbol: Record<string, number>;
  trackingSince: string | null;
  studyStartedAt?: string | null;
  scopeStart?: string;
  scopeEnd?: string;
  actualComparison?: ScalperShadowActualSummary;
  actualOutsideShadowCoverage?: ScalperShadowActualSummary | null;
  comparisonCoverage?: ScalperShadowComparisonCoverage;
  variants: ScalperShadowVariantSummary[];
  recent: ScalperShadowStudyRecord[];
  disclaimer: string;
}

export interface ScalpCalibrationSettings {
  bandMin: number;
  bandMax: number;
  windowSeconds: number;
  budgetDollars: number;
}

export interface ScalpCalibrationTimingSummary {
  variantSeconds: number;
  observedWindows?: number;
  candidateCoverage: number;
  trainingCandidates: number;
  holdoutCandidates: number;
  trainingSettlements: number;
  holdoutSettlements: number;
  trainingWins?: number;
  trainingLosses?: number;
  holdoutWins?: number;
  holdoutLosses?: number;
  trainingWinRate?: number | null;
  holdoutWinRate?: number | null;
  totalSettlements?: number;
  totalWins?: number;
  totalLosses?: number;
  totalWinRate?: number | null;
  trainingPnl: number;
  holdoutPnl: number;
  totalPnl?: number;
  ready?: boolean;
  profitable?: boolean;
}

export interface ScalpCalibrationRecommendation {
  id: string;
  version: number;
  mode: "paper" | "live";
  symbol: string;
  status: "insufficient_data" | "no_change" | "recommended" | "applied" | "reverted" | "superseded";
  currentSettings: ScalpCalibrationSettings;
  proposedSettings: ScalpCalibrationSettings;
  evidenceCutoff: string;
  analysisStart: string;
  evidence: {
    attemptedUniqueWindows: number;
    settledRealFills: number;
    orders: number;
    reservations: number;
    funnelEvents: number;
    shadowRecords: number;
    shadowCandidates: number;
    shadowSettlements: number;
  };
  chronologicalHoldout: {
    current: ScalpCalibrationTimingSummary | null;
    proposed: ScalpCalibrationTimingSummary | null;
  };
  timingOptions?: ScalpCalibrationTimingSummary[];
  dominantBlockers: Array<{ blocker: string; count: number }>;
  confidence: "low" | "moderate" | "high";
  rationale: string[];
  shadowDisclaimer: string;
  createdAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
}

export interface ScalpCalibrationReport {
  mode: "paper" | "live";
  analysisDays: number;
  generatedAt: string | null;
  recommendations: ScalpCalibrationRecommendation[];
  activeApplications: ScalpCalibrationRecommendation[];
}


export interface ScalperContrarianConfig {
  enabled: boolean;
  mode: "paper" | "live";
  budgetDollars: number;
  dailyCapDollars: number;
  openCapDollars: number;
  perWindowCapDollars: number;
  maxDirectContractCost: number;
  circuitBreakerEnabled: boolean;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
  strictEligibility: {
    finalWindowSeconds: number;
    minDirectAsk: number;
    maxDirectAsk: number;
    minRepeatedAdverseMoves: number;
    requireTargetCrossingOrReachableProjection: true;
  };
}

export interface ScalperContrarianSummaryMode {
  daily: number;
  open: number;
  spent: number;
  pnl: number;
  unresolved: number;
}

export interface ScalperContrarianSummary {
  paper: ScalperContrarianSummaryMode;
  live: ScalperContrarianSummaryMode;
  totalOrders: number;
  unresolvedLiveOrders: number;
}

export interface ScalperContrarianGuardEvidence {
  [key: string]: unknown;
  reason?: string | null;
  adverseMovePct?: number | null;
  directionalMovePct?: number | null;
  consecutiveWrongWayMoves?: number | null;
  consecutiveWrongWaySeconds?: number | null;
  latestPrice?: number | null;
  targetPrice?: number | null;
  projectedPrice?: number | null;
  projectedDistancePct?: number | null;
  wrongTargetSide?: boolean | null;
  targetSideViolationPrice?: number | null;
}

export interface ScalperContrarianEvidence {
  [key: string]: unknown;
  guardReason?: string | null;
  targetPrice?: number | null;
  sourceGuard?: ScalperContrarianGuardEvidence | null;
  finalGuard?: ScalperContrarianGuardEvidence | null;
  freshGuard?: ScalperContrarianGuardEvidence | null;
  guard?: ScalperContrarianGuardEvidence | null;
  strictRejectionReason?: string | null;
  monitoringPhase?: string | null;
}

export interface ScalperContrarianOrder {
  id: string;
  reservationId: string | null;
  executionMode: "paper" | "live";
  sourceMode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  protectedSide: "yes" | "no";
  oppositeSide: "yes" | "no";
  contractCount: number;
  yesLimitPrice: number;
  directAsk: number;
  yesAsk: number | null;
  noAsk: number | null;
  clientOrderId: string;
  status: string;
  exchangeOrderId: string | null;
  filledCount: number | null;
  avgYesFillPrice: number | null;
  budgetSpent: number | null;
  settlementResult: "yes" | "no" | null;
  outcome: "win" | "loss" | null;
  pnl: number | null;
  evidence: ScalperContrarianEvidence | null;
  reconciliationEvidence: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  reconciledAt: string | null;
  settledAt: string | null;
}

export interface ScalperContrarianObservation {
  id: string;
  executionMode: "paper" | "live";
  sourceMode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  protectedSide: "yes" | "no";
  oppositeSide: "yes" | "no";
  eligible: boolean;
  reason: string;
  evidence: ScalperContrarianEvidence | null;
  yesAsk: number | null;
  noAsk: number | null;
  directAsk: number | null;
  createdAt: string;
}

export interface ScalperContrarianIncident {
  id: string;
  orderId: string | null;
  reservationId: string | null;
  executionMode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  reason: string;
  evidence: Record<string, unknown> | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ScalperGuardOutcomeStudyAggregate {
  key: string;
  label: string;
  observed: number;
  settled: number;
  originalSideLossesPrevented: number;
  oppositeWins: number;
  oppositeLosses: number;
  winRate: number | null;
  pricedSettled: number;
  hypotheticalPnl: number | null;
}

export interface ScalperGuardOutcomeStudyRecord {
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  closeTime: string;
  guardReason: string;
  crossingType: "target_crossed" | "projected_target_crossing";
  protectedSide: "yes" | "no";
  oppositeSide: "yes" | "no";
  secondsRemaining: number | null;
  yesAsk: number | null;
  noAsk: number | null;
  oppositeAsk: number | null;
  quoteSupported: boolean;
  hypotheticalContracts: number;
  hypotheticalBudget: number;
  hypotheticalAvgYesPrice: number | null;
  settlementResult: "yes" | "no" | null;
  originalOutcome: "win" | "loss" | null;
  oppositeOutcome: "win" | "loss" | null;
  hypotheticalPnl: number | null;
  evidence: ScalperContrarianEvidence | null;
  observedAt: string;
  settledAt: string | null;
}

export interface ScalperGuardOutcomeStudyReport {
  trackingStartedAt: string;
  total: ScalperGuardOutcomeStudyAggregate;
  byMode: ScalperGuardOutcomeStudyAggregate[];
  byGuardReason: ScalperGuardOutcomeStudyAggregate[];
  bySymbol: ScalperGuardOutcomeStudyAggregate[];
  byTiming: ScalperGuardOutcomeStudyAggregate[];
  recent: ScalperGuardOutcomeStudyRecord[];
  disclaimer: string;
}

export interface ScalperContrarianReport {
  config: ScalperContrarianConfig;
  summary: ScalperContrarianSummary;
  guardOutcomeStudy: ScalperGuardOutcomeStudyReport;
  recentOrders: ScalperContrarianOrder[];
  recentObservations: ScalperContrarianObservation[];
  recentIncidents: ScalperContrarianIncident[];
  disclaimer: string;
}
