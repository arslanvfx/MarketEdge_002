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
  openCapDollars: number | null;
  freefallGuardEnabled: boolean;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
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

export interface ScalperStatusMarket {
  symbol: string;
  state: string;
  effectiveBandMin: number;
  effectiveBandMax: number;
  effectiveWindowSeconds: number;
  effectiveBudgetDollars: number;
  lastAsk: number | null;
  secondsRemaining: number | null;
  freefallBlocked: boolean;
  targetProximityBlocked: boolean;
  targetDistancePct: number | null;
  reason: string | null;
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

