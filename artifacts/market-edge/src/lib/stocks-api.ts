// Shared client for the stock trading vertical. Mirrors the api-server
// /api/stocks/* endpoints. Everything degrades gracefully when Alpaca keys
// are absent (backend returns configured:false and empty datasets).

export const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");
export const STOCKS_BASE = `${API_BASE}/stocks`;

// ─── Types (mirror api-server/src/lib/stock/types.ts) ────────────────────────

export type TradingMode = "day" | "swing" | "long";
export type BotMode = "paper" | "live";
export type Direction = "up" | "down";
export type Sentiment = "bullish" | "bearish" | "neutral";

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

export interface WatchlistEntry {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  addedAt: string;
}

export interface UniverseStatus {
  builtAt: number;
  totalAssets: number;
  candidateCount: number;
  source: "market" | "static-fallback" | "none";
  building: boolean;
}

export interface StockMeta {
  configured: boolean;
  sectors: string[];
  universeSize: number;
  universe?: UniverseStatus;
  lastScanAt: number;
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
  magnitude?: number;
  sentimentScore?: number;
}

export interface EarningsInfo {
  ticker: string;
  date: string;
  hoursUntil: number;
  soon: boolean;
}

export interface StatSignal {
  direction: Direction;
  confidence: number;
  rsi: number;
  atrPct: number;
  efficiencyRatio: number;
  netDriftPct: number;
  volumeBias: number;
  bbPosition: number;
  reasoning: string;
}

export type AnalystRating = "buy" | "sell" | "hold";

export interface ClaudeSignal {
  direction: Direction;
  confidence: number;
  reasoning: string;
  rating: AnalystRating;
  cached: boolean;
}

export interface MlSignal {
  direction: Direction;
  confidence: number;
  ready: boolean;
  windows?: number;
  minWindows?: number;
  valAccuracy?: number | null;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type ChartRange = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";

export const CHART_RANGES: ChartRange[] = ["1D", "5D", "1M", "3M", "6M", "1Y"];

export interface ChartData {
  range: ChartRange;
  resolution: string;
  candles: Candle[];
  /** Per-candle 21-day SMA (flat current daily level on intraday ranges). */
  sma21: (number | null)[];
  sma50: (number | null)[];
  sma180: (number | null)[];
  /** Per-candle RSI(14) at the chart's own resolution. */
  rsi14: (number | null)[];
}

export interface StockAnalysis {
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
  sector: string;
  companyName: string;
  candles: Candle[];
  chart?: ChartData | null;
}

export type ResearchHorizon = TradingMode;

export interface ResearchReport {
  ticker: string;
  companyName: string;
  sector: string;
  horizon: ResearchHorizon;
  confidence: number;      // 0-100 conviction in the upside thesis
  bullFactors: string[];
  bearFactors: string[];
  summary: string;
  price: number | null;
  webSearchUsed: boolean;
  createdAt: string;
}

export interface ResearchProgress {
  running: boolean;
  total: number;
  done: number;
}

export interface ScanProgress {
  scanning: boolean;
  phase: "idle" | "snapshots" | "screening" | "scoring" | "research" | "done";
  total: number;
  done: number;
  currentTicker: string;
  pct: number;
  screened: number;
  universeSize: number;
  researchTotal: number;
  researchDone: number;
  researchRunning: boolean;
}

export interface StockBotConfig {
  enabled: boolean;
  mode: BotMode;
  tradingModes: TradingMode[];
  positionSizePct: number;
  maxConcurrentPositions: number;
  maxDayPositions: number;
  maxSwingPositions: number;
  maxLongPositions: number;
  dailyLossLimit: number;
  minConfidence: number;
  stopLossPct: number;
  targetGainPct: number;
  swingMaxHoldDays: number;
  longMaxHoldDays: number;
  earningsBlackout: boolean;
  earningsBlackoutHours: number;
  newsSensitivity: number;
  autoStartStop: boolean;
  sectorFocus: string[];
  maxPositionDollars: number | null;
}

export interface AlpacaAccount {
  equity: number;
  cash: number;
  buyingPower: number;
  daytradeCount: number;
  patternDayTrader: boolean;
}

export interface AlpacaPosition {
  ticker: string;
  qty: number;
  avgEntry: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
}

export interface BotDecision {
  ts: number;
  ticker: string;
  action: "ENTER" | "EXIT" | "SKIP";
  horizon: TradingMode | null;
  confidence: number | null;
  reason: string;
}

export interface BotCycleStatus {
  lastCycleAt: number;
  lastCycleSummary: string;
  running: boolean;
  decisions?: BotDecision[];
}

export interface BotStatus {
  config: StockBotConfig;
  account: AlpacaAccount | null;
  positions: AlpacaPosition[];
  cycle: BotCycleStatus;
  configured: boolean;
}

export interface HistoryRow {
  id: string;
  ticker: string;
  sector: string | null;
  action: string;
  trading_mode: TradingMode | null;
  mode: BotMode;
  side: string | null;
  qty: number | null;
  confidence: number | null;
  entry_price: number | null;
  exit_price: number | null;
  stop_loss: number | null;
  target_price: number | null;
  notional: number | null;
  pnl: number | null;
  exit_reason: string | null;
  outcome: "win" | "loss" | "push" | null;
  signal_type: "technical" | "ai" | "ml" | "unknown";
  created_at: string;
  exited_at: string | null;
}

export interface StockPnl {
  closed: number;
  open: number;
  totalPnl: number;
  todayPnl: number;
  wins: number;
  losses: number;
  winRate: number;
}

// ─── Fetch helpers ───────────────────────────────────────────────────────────

export async function stockGet<T>(path: string): Promise<T> {
  const res = await fetch(`${STOCKS_BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export type TokenGetter = () => Promise<string | null>;

export async function stockAuth<T>(
  getToken: TokenGetter,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: object,
): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${STOCKS_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let msg = `${method} ${path} → ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface ClosePositionResult {
  closed: boolean;
  ticker: string;
  qty: number;
  exitPrice: number;
  pnl: number;
}

/** Manually close an open bot position at market (records exit as "manual"). */
export async function closeStockPosition(
  getToken: TokenGetter,
  ticker: string,
): Promise<ClosePositionResult> {
  return stockAuth<ClosePositionResult>(
    getToken,
    `/bot/positions/${encodeURIComponent(ticker)}/close`,
    "POST",
  );
}

// ─── Formatters ──────────────────────────────────────────────────────────────

export const fmtUsd = (n: number | null | undefined, decimals = 2): string => {
  if (n == null || isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

export const fmtSignedUsd = (n: number | null | undefined): string => {
  if (n == null || isNaN(n)) return "—";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const fmtPct = (n: number | null | undefined, decimals = 2): string => {
  if (n == null || isNaN(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
};

export const fmtDateTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) +
    " EST"
  );
};

export const sentimentColor = (s: Sentiment): string =>
  s === "bullish"
    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
    : s === "bearish"
      ? "text-red-400 bg-red-500/10 border-red-500/30"
      : "text-muted-foreground bg-muted border-border";

export const SECTORS = [
  "Technology",
  "Healthcare",
  "Financials",
  "Consumer Discretionary",
  "Consumer Staples",
  "Communication Services",
  "Industrials",
  "Energy",
  "Real Estate",
  "Utilities",
  "Materials",
] as const;
