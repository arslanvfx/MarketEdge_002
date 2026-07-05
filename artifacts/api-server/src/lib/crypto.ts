// ---------------------------------------------------------------------------
// crypto.ts — barrel re-exporting from focused sub-modules
// ---------------------------------------------------------------------------
// DAG: data → stat → kalshi → history → analytics → claude → tracker → barrel

// ── crypto-indicators (primitives — also re-exported through crypto-data) ──
export { intraWindowMetrics } from "./crypto-indicators";
export type { Candle, OrderBook } from "./crypto-indicators";

// ── crypto-data ─────────────────────────────────────────────────────────────
export {
  COINBASE,
  COINGECKO,
  UA,
  GECKO_ID,
  CRYPTO_COINS,
  PRED_TTL,
  predCache,
  windowPredCache,
  currentWindowKey,
  fetchJson,
  getGeckoPrices,
  getTicker,
  getCandles,
  getStats,
  get5mCandles,
  getOrderBook,
} from "./crypto-data";
export type { CoinDef, Prediction, CoinPrediction, CoinPrice, CoinStats } from "./crypto-data";

// ── crypto-stat ──────────────────────────────────────────────────────────────
export {
  regimeFromER,
  intraWindowBlock,
  nextQuarterTargets,
  estLabel,
  analyzeCoin,
  analyzeCoinAt,
} from "./crypto-stat";
export type { PromptRegime } from "./crypto-stat";

// ── crypto-kalshi ─────────────────────────────────────────────────────────────
export {
  KALSHI_SERIES,
  kalshiTargetCache,
  confirmedTargetStore,
  getConfirmedTargetMs,
  getLastKalshiTicker,
  kalshiWindowStore,
  updateKalshiWindowPrice,
  lastMLAboveCache,
  getLastMLAbove,
  getKalshiWindowContext,
  getKalshiCachedData,
  fetchKalshiTarget,
} from "./crypto-kalshi";

// ── crypto-history ────────────────────────────────────────────────────────────
export {
  QUARTER_MS,
  MAX_HISTORY,
  RETENTION_DAYS,
  TRAINING_COINS,
  ACCURACY_THRESHOLD_PCT,
  historyStore,
  snapInFlight,
  midSnapFired,
  recordId,
  getPredictionHistory,
  getPredictionHeadlines,
  clearPredictionHistoryOld,
  clearAccuracyLogsOnly,
  clearPredictionHistory,
  rowToRecord,
  initHistoryFromDB,
  pruneOldPredictionRecords,
  dbInsertRecord,
  dbUpdateRecord,
  dbUpdateLiveDirection,
} from "./crypto-history";
export type { PredictionRecord } from "./crypto-history";

// ── crypto-analytics ──────────────────────────────────────────────────────────
export {
  getPredictionAnalytics,
  getAllPredictionAnalytics,
  getTradingWindows,
  calibrateConfidence,
  ENSEMBLE_ABSTAIN_MIN_CONF,
  ensembleWeights,
  computeEnsemble,
} from "./crypto-analytics";
export type {
  SourceMetrics,
  AbstentionMetrics,
  CoinAnalytics,
  TradingWindowBucket,
  RecommendedWindow,
  TradingWindowsData,
  EnsembleWeights,
  EnsembleCall,
} from "./crypto-analytics";

// ── crypto-claude ─────────────────────────────────────────────────────────────
export {
  getSelfConsistencySamples,
  setSelfConsistencySamples,
  applyAIPredictions,
  fetchAIPredictions,
  refineSnappedPrediction,
  refineWithSelfConsistency,
  fetchKalshiBtcCall,
  liveDirectionCache,
  liveDirectionInFlight,
  liveDirectionLastAutoTrigger,
  LIVE_DIR_AUTO_COOLDOWN,
  fetchLiveDirection,
  fetchTrendStabilityForBot,
} from "./crypto-claude";
export type {
  AIPrediction,
  LiveDirectionResult,
  TrendStability,
  TrendStabilityResult,
} from "./crypto-claude";

// ── crypto-tracker ────────────────────────────────────────────────────────────
export {
  runAutoPilot,
  getAiSettings,
  setAutoPilot,
  isAiGloballyEnabled,
  setGlobalAiMode,
  setCoinClaudeEnabled,
  isCoinClaudeEnabled,
  getTrackerWindowCall,
  getStatWindowCall,
  computeWindowBetSignal,
  getWindowBetSignal,
  startPredictionTracker,
  getCachedPrediction,
  fetchCryptoPredictions,
  fetchCryptoPrices,
  getWindowMonitorAccuracy,
  getTimingAnalysis,
} from "./crypto-tracker";
// setSelfConsistencySamples wrapper lives in crypto-tracker but the canonical
// export is already provided by crypto-claude above — no duplicate needed.
export type {
  TrackerWindowCall,
  WindowBetSignal,
  WMAccuracyStats,
  TimingAnalysisRow,
} from "./crypto-tracker";
