// Shared types for the stock trading vertical. Fully independent of the crypto
// prediction system — nothing here is imported from crypto.ts / kalshi-bot.ts.

export type TradingMode = "day" | "swing" | "long";
export type BotMode = "paper" | "live";
export type Direction = "up" | "down";
export type Sentiment = "bullish" | "bearish" | "neutral";

export interface Candle {
  t: number; // epoch ms of bar open
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface NewsItem {
  id: string;
  ticker: string;
  headline: string;
  summary?: string;
  url?: string;
  source?: string;
  publishedAt?: string;
  sentiment?: Sentiment;
  magnitude?: number;      // 1-5
  sentimentScore?: number; // -1..1
}

export interface EarningsInfo {
  ticker: string;
  date: string;       // ISO date of next report
  hoursUntil: number; // hours until the report (negative if past)
  soon: boolean;      // within the configured blackout window
}

export interface StatSignal {
  direction: Direction;
  confidence: number; // 50-100
  rsi: number;
  atrPct: number;
  efficiencyRatio: number;
  netDriftPct: number;
  volumeBias: number; // -1..1
  bbPosition: number; // 0..1 position within Bollinger band
  reasoning: string;
}

export type AnalystRating = "buy" | "sell" | "hold";

export interface ClaudeSignal {
  direction: Direction;
  confidence: number; // 50-100
  reasoning: string;
  rating: AnalystRating; // buy / sell / hold analyst-style verdict
  cached: boolean;
}

export interface MlSignal {
  direction: Direction;
  confidence: number; // 50-100
  ready: boolean;     // false while under the training gate
}

export interface StockSignals {
  ticker: string;
  price: number;
  changePct: number;
  stat: StatSignal;
  claude?: ClaudeSignal;
  ml?: MlSignal;
  news: NewsItem[];
  earnings?: EarningsInfo;
  combinedDirection: Direction;
  combinedConfidence: number;
}

export type ResearchHorizon = "day" | "swing" | "long";

/** Claude's actionable verdict on a researched stock. */
export type ResearchStance = "buy_now" | "buy" | "watch" | "avoid";

export interface ResearchReport {
  ticker: string;
  companyName: string;
  sector: string;
  horizon: ResearchHorizon;
  stance: ResearchStance;
  confidence: number; // 0-100
  summary: string;
  bullFactors: string[];
  bearFactors: string[];
  /** 1-2 sentence financials/valuation assessment (P/E vs peers, growth, balance sheet). */
  valuation: string;
  price: number | null;
  webSearchUsed: boolean;
  createdAt: string;
}

export interface ScannerRow {
  ticker: string;
  companyName: string;
  sector: string;
  price: number;
  changePct: number;
  score: number;
  direction: Direction | null;
  confidence: number;
  newsSentiment: Sentiment;
  earningsSoon: boolean;
  details?: Record<string, unknown>;
  updatedAt: string;
}

export interface OpenPosition {
  id: string;
  ticker: string;
  sector: string | null;
  tradingMode: TradingMode;
  mode: BotMode;
  qty: number;
  entryPrice: number;
  stopLoss: number | null;
  targetPrice: number | null;
  notional: number;
  confidence: number;
  signals: unknown;
  alpacaOrderId: string | null;
  createdAt: string;
}

export interface StockBotConfig {
  enabled: boolean;
  mode: BotMode;                 // paper | live
  tradingModes: TradingMode[];   // which modes are active
  positionSizePct: number;       // % of equity per position
  maxConcurrentPositions: number;
  maxDayPositions: number;
  maxSwingPositions: number;
  maxLongPositions: number;
  dailyLossLimit: number;        // $ loss before halting for the day
  minConfidence: number;         // 50-100 entry gate
  stopLossPct: number;           // global trailing/hard stop % (fallback)
  targetGainPct: number;         // global take-profit target % (fallback)
  // Per-mode stop/target overrides (null = fall back to global)
  dayStopLossPct: number | null;
  dayTargetGainPct: number | null;
  swingStopLossPct: number | null;
  swingTargetGainPct: number | null;
  longStopLossPct: number | null;
  longTargetGainPct: number | null;
  swingMaxHoldDays: number;
  longMaxHoldDays: number;
  earningsBlackout: boolean;     // avoid entries within blackout window
  earningsBlackoutHours: number;
  newsSensitivity: number;       // 1-5 magnitude threshold that moves confidence
  autoStartStop: boolean;        // auto-enable at market open, disable at close
  sectorFocus: string[];         // [] = all sectors; else restrict to these sectors
  maxPositionDollars: number | null; // null = no cap; otherwise min(%, $) sizing
  // Advanced
  dynamicSizing: boolean;        // scale position size by confidence (minConf→maxCap)
  minMarketCapBillion: number;   // 0=any, 1, 5, 10 → filter micro-caps
  maxSectorPct: number;          // 0=disabled; max % of open budget in one sector
}
