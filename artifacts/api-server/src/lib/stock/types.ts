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

export interface ClaudeSignal {
  direction: Direction;
  confidence: number; // 50-100
  reasoning: string;
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
  stopLossPct: number;           // trailing/hard stop %
  targetGainPct: number;         // take-profit target %
  swingMaxHoldDays: number;
  longMaxHoldDays: number;
  earningsBlackout: boolean;     // avoid entries within blackout window
  earningsBlackoutHours: number;
  newsSensitivity: number;       // 1-5 magnitude threshold that moves confidence
}
