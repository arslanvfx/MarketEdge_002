export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Prediction {
  target: string;
  label: string;
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  changePct: number;
}

// Response from GET /crypto/ml-prediction/:symbol
export interface MLPredResponse {
  symbol:      string;
  above:       boolean | null;
  confidence:  number | null;
  prob:        number | null;
  ready:       boolean;
  windows:     number;
  samples:     number;
  minWindows:  number;
  valAccuracy: number | null;
}

// Shape returned by the prediction history endpoint
export interface PredictionRecord {
  symbol: string;
  snappedAt: string;
  targetTime: string;
  targetLabel: string;
  priceAtSnapshot: number;
  predictedPrice: number;
  predictedDirection: "up" | "down" | "flat";
  confidence: number;
  kalshiTarget: number | null;
  actualPrice: number | null;
  errorPct: number | null;
  correct: boolean | null;
  evaluatedAt: string | null;
  status: "pending" | "evaluated";
  source?: "stat" | "claude" | "ensemble" | "ml";
  id?: string;
  abstained?: boolean | null;
}

// Regime-aware blend weights returned alongside an AI run so the client can
// reproduce the exact combined call shown in the two model columns.
export interface EnsembleWeights {
  stat: number;
  claude: number;
}

// Auto-pilot's per-coin decision: whether Claude is auto-enabled and why.
export interface AutoPilotDecision {
  symbol: string;
  active: boolean;
  reason: string;
  exploring: boolean;
  claudeAccuracyPct: number | null;
  statAccuracyPct: number | null;
  claudeN: number;
  statN: number;
  marginPct: number | null;
}

// Shape returned by /crypto/ai-settings
export interface AiSettings {
  mode: "stat" | "claude";
  claudeCoins: string[];
  trainingCoins: string[];
  selfConsistencySamples?: number;
  autoPilot: {
    enabled: boolean;
    maxActive: number;
    decisions: AutoPilotDecision[];
  };
}

// Self-learning analytics shape from /crypto/prediction-analytics
export type PromptRegime = "trending" | "drifting" | "choppy";
export interface SourceMetrics {
  n: number;
  hits: number;
  accuracyPct: number | null;
  avgErrorPct: number | null;
}
export interface CoinAnalytics {
  symbol: string;
  bySource: { stat: SourceMetrics; claude: SourceMetrics; ensemble: SourceMetrics };
  byRegime: {
    stat: Record<PromptRegime, SourceMetrics>;
    claude: Record<PromptRegime, SourceMetrics>;
    ensemble: Record<PromptRegime, SourceMetrics>;
  };
  abstention: {
    evaluated: number;
    avoidedLoss: number;
    missedWin: number;
    avoidedLossPct: number | null;
  };
  calibration: Array<{
    band: string;
    n: number;
    avgConfidencePct: number | null;
    hitRatePct: number | null;
  }>;
  ensembleWeights: {
    overall: EnsembleWeights;
    byRegime: Record<PromptRegime, EnsembleWeights>;
  };
}

// Shape returned by the Kalshi BTC 15-min target endpoint
export interface KalshiTarget {
  available: boolean;
  targetPrice: number | null;
  ticker?: string;
  eventTicker?: string;
  closeTime?: string;
  openTime?: string;
  isLive?: boolean;
  yesBid?: number;
  yesAsk?: number;
  url?: string;
  minutesElapsed?: number;
  windowOpenPrice?: number | null;
}

// Shape returned by the on-demand AI endpoint
export interface AIPredictionItem {
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
}

// Context stored alongside each Claude AI run
export interface AiEntry {
  preds: AIPredictionItem[];
  at: Date;
  priceAtRun: number;
  eventTickerAtRun: string | undefined;
  ensembleWeights?: EnsembleWeights;
  abstainMinConf?: number;
}

export interface DriftAlert {
  lockedAbove: boolean | null;
  claudeAbove: boolean | null;
  lockedDirection: "up" | "down" | "flat";
  claudeDirection: "up" | "down" | "flat";
  detectedAt: Date;
  windowTarget: string;
}

export interface TrackerWindowCall {
  direction: "up" | "down" | "flat";
  aboveKalshi: boolean | null;
  predictedPrice: number;
  confidence: number;
  snappedAt: string;
  strikeProximityPct?: number | null;
}

export interface WindowBetSignal {
  ready: boolean;
  minutesElapsed: number;
  recommendation: "bet" | "stay_away" | "caution";
  reason: string;
  preWindowER: number | null;
  factors: {
    efficiencyRatio: number;
    oscillationCount: number;
    spikeFlag: boolean;
    netDriftPct: number;
  };
}

export interface WMAccuracyStats {
  bet: { total: number; correct: number; accuracy: number | null };
  stay_away: { total: number; correct: number; accuracy: number | null };
  caution: { total: number; correct: number; accuracy: number | null };
  totalSamples: number;
  days: number;
}

export interface LiveDirectionResult {
  aboveKalshi: boolean | null;
  direction: "up" | "down" | "flat";
  confidence: number;
  at: string;
  cached: boolean;
}

// Shape returned by the /crypto/trading-windows endpoint
export interface TradingWindowBucket {
  count: number;
  evaluatedCount: number;
  accuracyPct: number | null;
  avgEfficiencyRatio: number | null;
  trendingPct: number | null;
  sparse: boolean;
}
export interface RecommendedWindow {
  hour: number;
  label: string;
  score: number;
  avgEfficiencyRatio: number;
  accuracyPct: number | null;
  rank: "best" | "worst";
}
export interface TradingWindowsData {
  hourly: Array<TradingWindowBucket & { hour: number; label: string }>;
  daily: Array<TradingWindowBucket & { dayIndex: number; label: string }>;
  byDayHour: Array<Array<TradingWindowBucket & { hour: number; label: string }>>;
  recommendedWindows: RecommendedWindow[];
  totalSamples: number;
  lastUpdatedAt: string;
  recommendation: string;
  hasEnoughData: boolean;
}

// Per-symbol (or aggregate), per-minute-mark accuracy from the timing analysis endpoint
export interface TimingAnalysisRow {
  symbol: string | null;
  minuteMark: number;
  label: string;
  sampleCount: number;
  accuracy: number | null;
  avgYesPrice: number | null;
  avgReturn: number | null;  // potential upside per $1 if correct: (1-p)/p
  ev: number | null;         // EV = accuracy*(1/yesPrice) - (1-accuracy)
}

// ---------------------------------------------------------------------------
// Kalshi bot types
// ---------------------------------------------------------------------------

export interface BotConfig {
  betSize: number;
  dailyLossLimit: number;
  signalThreshold: number;
  minConfidence: number;
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number;
  maxEntryMinutes: number;
  enabled: boolean;
}

export interface BotGuardStates {
  holdDurationOk: boolean;
  flipConfirmed: boolean;
  magnitudeOk: boolean;
  consensusOk: boolean;
  timingOverride: boolean;
  erOk: boolean;
  mlFlipped?: boolean;
  phase2Active: boolean;
  phase2UptickDetected: boolean;
  phase2Timeout: boolean;
  phase2YesPrice: number | null;
  phase2RecentLow: number | null;
}

export interface BotOpenPosition {
  id: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  direction: "yes" | "no";
  entryYesPrice: number;
  contractCount: number;
  betAmount: number;
  kalshiTarget: number;
  openedAt: number;
  phase2Activated: boolean;
}

export interface BotStateSnapshot {
  mode: "paper" | "live";
  status: "idle" | "position_open" | "paused" | "daily_limit_hit";
  paused: boolean;
  config: BotConfig;
  openPosition: BotOpenPosition | null;
  openPositionCurrentYesPrice: number | null;
  openPositionUnrealizedPnl: number | null;
  dailyPnl: number;
  dailyLossCount: number;
  dailyDate: string;
  accountBalance: number | null;
  lastUpdatedAt: string;
  lastGuardStates: BotGuardStates | null;
  lastGuardReason: string | null;
  configured: boolean;
  warmupSecondsRemaining: number | null;
}

export interface BotBetRecord {
  id: string;
  symbol: string;
  windowKey: string;
  direction: string | null;
  action: string;
  mode: string;
  entryPrice: string | null;
  exitPrice: string | null;
  betAmount: string | null;
  pnl: string | null;
  exitReason: string | null;
  phase2Activated: boolean | null;
  createdAt: string;
  exitedAt: string | null;
  outcome: "win" | "loss" | "push" | null;
}

export interface CoinBotStats {
  symbol: string;
  bets: number;
  wins: number;
  losses: number;
  pnl: number;
}

export interface BotStats {
  totalBets: number;
  wins: number;
  losses: number;
  totalPnl: number;
  paperBets: number;
  liveBets: number;
  paperWins: number;
  paperLosses: number;
  liveWins: number;
  liveLosses: number;
  bySymbol: CoinBotStats[];
}

export interface TrendPoint {
  betNumber: number;
  outcome: "win" | "loss";
  symbol: string;
  pnl: number;
  createdAt: string;
  rollingWinRate: number;
}

// ---------------------------------------------------------------------------
// Bet signal — intra-window momentum read on whether the last 15 minutes are
// trending cleanly, just drifting, choppy, or showing an abnormal spike.
// ---------------------------------------------------------------------------

export interface BetSignal {
  level: "trending" | "drifting" | "choppy" | "spike";
  er: number;              // efficiency ratio 0–1 (clean trend vs chop)
  oscCount: number;        // direction reversals in the last 15 candles
  netDriftPct: number;     // net signed move over the window, %
  totalPathPct: number;    // total path traveled over the window, %
  spikeFlag: boolean;      // abnormal spike candle detected
  spikeMultiple: number;   // largest candle range ÷ median range
  driftUp: boolean;        // window net direction is up
  driftTowardTarget: boolean | null; // is the window drift heading toward the strike? null when no target
}

// Build a bet signal from the coin's intra-window momentum metrics.
// kalshiTarget is optional — coins without a market still get an ER/spike read.
export function computeBetSignal(
  ind: {
    efficiencyRatio?: number;
    oscillationCount?: number;
    netDriftPct?: number;
    totalPathPct?: number;
    spikeFlag?: boolean;
    spikeMultiple?: number;
  },
  kalshiTarget: number | null,
  livePrice: number,
): BetSignal {
  const er = ind.efficiencyRatio ?? 0;
  const oscCount = ind.oscillationCount ?? 0;
  const netDriftPct = ind.netDriftPct ?? 0;
  const totalPathPct = ind.totalPathPct ?? 0;
  const spikeFlag = ind.spikeFlag ?? false;
  const spikeMultiple = ind.spikeMultiple ?? 0;

  // Spike overrides the ER-based classification.
  const level: BetSignal["level"] =
    spikeFlag ? "spike"
    : er >= 0.55 ? "trending"
    : er >= 0.25 ? "drifting"
    : "choppy";

  const driftUp = netDriftPct >= 0;
  // Trend-gap alignment: is the dominant direction heading toward the strike?
  // Above target + drifting down = closing the gap (toward strike → flip risk).
  // Below target + drifting up = closing the gap (toward strike → flip risk).
  // Drift that widens the gap moves away from the strike (safer).
  let driftTowardTarget: boolean | null = null;
  if (kalshiTarget !== null && livePrice > 0 && Math.abs(netDriftPct) > 0.0001) {
    const aboveTarget = livePrice >= kalshiTarget;
    driftTowardTarget = aboveTarget ? !driftUp : driftUp;
  }

  return {
    level,
    er,
    oscCount,
    netDriftPct,
    totalPathPct,
    spikeFlag,
    spikeMultiple,
    driftUp,
    driftTowardTarget,
  };
}

export interface CoinPrediction {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
  change1hPct: number;
  high24h: number;
  low24h: number;
  indicators: {
    rsi: number;
    sma20: number;
    ema12: number;
    ema26: number;
    macd: number;
    trend: "up" | "down" | "flat";
    trendStrength: number;
    volatilityPct: number;
    bbUpper?: number;
    bbLower?: number;
    bbWidth?: number;
    bbPctB?: number;
    atr14?: number;
    efficiencyRatio?: number;
    oscillationCount?: number;
    netDriftPct?: number;
    totalPathPct?: number;
    spikeFlag?: boolean;
    spikeMultiple?: number;
  };
  sparkline: number[];
  candles: Candle[];
  predictions: Prediction[];
  kalshiTarget?: number | null; // Kalshi RTI strike for current 15-min window
}

export interface CoinPrice {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
}
