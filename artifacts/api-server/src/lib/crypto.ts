import { anthropic } from "@workspace/integrations-anthropic-ai";

// Real-time crypto price predictor.
//
// Price sources:
//   CoinGecko (primary) — free, no key, aggregates across all major exchanges.
//     /simple/price?ids=...&vs_currencies=usd&include_24hr_change=true
//   Coinbase Exchange (candles + 24h stats fallback) — no key, US-friendly.
//     candles: /products/{id}/candles?granularity=60  → [time,low,high,open,close,vol] newest-first
//     stats:   /products/{id}/stats  → { open(24h), high, low, last, volume }
//
// We pull recent 1-minute candles, compute a set of technical indicators, then
// project the price forward to the next quarter-hour boundaries (:00/:15/:30/:45).
// All predictions are model-based estimates derived from recent chart behaviour.

const COINBASE = "https://api.exchange.coinbase.com";
const COINGECKO = "https://api.coingecko.com/api/v3";
// Kraken is the primary constituent exchange for CF Benchmarks BRTI —
// the index that Kalshi uses to settle all KXBTC markets. Using Kraken's
// bid/ask midpoint for BTC gives the closest publicly-available proxy to
// what Kalshi displays as the current BTC reference price.
const KRAKEN = "https://api.kraken.com/0/public";
const UA = "MarketEdge/1.0 (crypto-predictor)";

// Coinbase product → Kraken pair (only for coins that need BRTI-aligned pricing).
const KRAKEN_PAIR: Record<string, string> = {
  "BTC-USD": "XBTUSD",
};

// CoinGecko IDs for each symbol.
const GECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  LINK: "chainlink",
  DOGE: "dogecoin",
};

export interface CoinDef {
  symbol: string;
  product: string;
  name: string;
}

export const CRYPTO_COINS: CoinDef[] = [
  { symbol: "BTC", product: "BTC-USD", name: "Bitcoin" },
  { symbol: "ETH", product: "ETH-USD", name: "Ethereum" },
  { symbol: "SOL", product: "SOL-USD", name: "Solana" },
  { symbol: "XRP", product: "XRP-USD", name: "XRP" },
  { symbol: "LINK", product: "LINK-USD", name: "Chainlink" },
  { symbol: "DOGE", product: "DOGE-USD", name: "Dogecoin" },
];

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Prediction {
  target: string; // ISO timestamp of the quarter-hour boundary
  label: string; // EST formatted clock label, e.g. "10:15 AM"
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number; // 0-100
  changePct: number; // vs current price
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
    trendStrength: number; // 0-1 signal-to-noise
    volatilityPct: number; // per-minute vol as pct
  };
  sparkline: number[]; // recent closes (last ~60)
  candles: Candle[]; // recent candles for charting (last ~90)
  predictions: Prediction[];
}

export interface CoinPrice {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers with a short in-memory cache to dedupe concurrent polling.
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type CacheEntry<T> = { at: number; value: T };
const candleCache = new Map<string, CacheEntry<Candle[]>>();
const statsCache = new Map<string, CacheEntry<CoinStats>>();
const tickerCache = new Map<string, CacheEntry<number>>();
const CANDLE_TTL = 8_000;
const STATS_TTL = 4_000;
const TICKER_TTL = 2_000; // very short — this is the per-tick live price
// Full coin analysis cache: predictions are stable for 3.5 min (no need to
// recompute the statistical model on every 3-second price tick).
const PRED_TTL = 60_000; // 60 seconds — fresh enough to drop stale quarter-hour intervals quickly
const predCache = new Map<string, CacheEntry<CoinPrediction>>();

// CoinGecko — single batched request for all coins (24h change reference).
interface GeckoEntry {
  usd: number;
  usd_24h_change: number;
}
type GeckoPrices = Record<string, GeckoEntry>;
let geckoCache: CacheEntry<GeckoPrices> | null = null;
const GECKO_TTL = 15_000; // CoinGecko free tier; only used for 24h change %

async function getGeckoPrices(): Promise<GeckoPrices> {
  if (geckoCache && Date.now() - geckoCache.at < GECKO_TTL) return geckoCache.value;
  const ids = Object.values(GECKO_ID).join(",");
  const data = await fetchJson<GeckoPrices>(
    `${COINGECKO}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
  );
  geckoCache = { at: Date.now(), value: data };
  return data;
}

// Kraken bid/ask midpoint — used for BTC to match CF Benchmarks BRTI
// (the settlement index Kalshi uses for all KXBTC markets).
const krakenTickerCache = new Map<string, CacheEntry<number>>();
async function getKrakenMid(pair: string): Promise<number> {
  const hit = krakenTickerCache.get(pair);
  if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;
  const raw = await fetchJson<{ result: Record<string, { a: string[]; b: string[] }> }>(
    `${KRAKEN}/Ticker?pair=${pair}`,
  );
  const entry = Object.values(raw.result ?? {})[0];
  if (!entry) throw new Error(`Kraken: no result for ${pair}`);
  const mid = (parseFloat(entry.a[0]) + parseFloat(entry.b[0])) / 2;
  krakenTickerCache.set(pair, { at: Date.now(), value: mid });
  return mid;
}

// Live ticker price. BTC uses Kraken mid (closest proxy to CF Benchmarks BRTI,
// the index Kalshi settles against). All other coins use Coinbase last-trade.
async function getTicker(product: string): Promise<number> {
  const krakenPair = KRAKEN_PAIR[product];
  if (krakenPair) {
    return getKrakenMid(krakenPair).catch(async () => {
      // Fall back to Coinbase if Kraken is unavailable.
      const hit = tickerCache.get(product);
      if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;
      const raw = await fetchJson<Record<string, string>>(
        `${COINBASE}/products/${product}/ticker`,
      );
      const price = parseFloat(raw.price ?? "0");
      tickerCache.set(product, { at: Date.now(), value: price });
      return price;
    });
  }
  const hit = tickerCache.get(product);
  if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/ticker`,
  );
  const price = parseFloat(raw.price ?? "0");
  tickerCache.set(product, { at: Date.now(), value: price });
  return price;
}

interface CoinStats {
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
}

async function getCandles(product: string): Promise<Candle[]> {
  const hit = candleCache.get(product);
  if (hit && Date.now() - hit.at < CANDLE_TTL) return hit.value;
  const raw = await fetchJson<number[][]>(
    `${COINBASE}/products/${product}/candles?granularity=60`,
  );
  // Coinbase returns newest-first; reverse to oldest-first for indicator math.
  const candles: Candle[] = raw
    .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .sort((a, b) => a.t - b.t);
  candleCache.set(product, { at: Date.now(), value: candles });
  return candles;
}

async function getStats(product: string): Promise<CoinStats> {
  const hit = statsCache.get(product);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.value;
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/stats`,
  );
  const stats: CoinStats = {
    open: parseFloat(raw.open ?? "0"),
    high: parseFloat(raw.high ?? "0"),
    low: parseFloat(raw.low ?? "0"),
    last: parseFloat(raw.last ?? "0"),
    volume: parseFloat(raw.volume ?? "0"),
  };
  statsCache.set(product, { at: Date.now(), value: stats });
  return stats;
}

// ---------------------------------------------------------------------------
// Indicator math
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function sma(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const slice = xs.slice(-period);
  return mean(slice);
}

function ema(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = xs[0];
  for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  // seed with the first `period` deltas
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Ordinary least-squares slope (per index step) and R² over the series.
function linReg(ys: number[]): { slope: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2 };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------
// Quarter-hour target generation (next 4 boundaries from now)
// ---------------------------------------------------------------------------

function nextQuarterTargets(now: Date, count = 4): Date[] {
  const targets: Date[] = [];
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  // advance to the next quarter-hour strictly after `now`
  const minutesToNext = 15 - (d.getMinutes() % 15);
  d.setMinutes(d.getMinutes() + (minutesToNext === 0 ? 15 : minutesToNext));
  for (let i = 0; i < count; i++) {
    targets.push(new Date(d.getTime() + i * 15 * 60_000));
  }
  return targets;
}

function estLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// ---------------------------------------------------------------------------
// Prediction model
// ---------------------------------------------------------------------------

function analyzeCoin(
  coin: CoinDef,
  candles: Candle[],
  stats: CoinStats,
  now: Date,
  geckoPrice?: number,
): CoinPrediction {
  const closes = candles.map((c) => c.c);
  // Prefer CoinGecko (aggregated across exchanges) → Coinbase last → latest candle.
  const price = geckoPrice ?? (stats.last > 0 ? stats.last : closes[closes.length - 1] ?? 0);

  // Per-minute log returns over the recent window.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const recentRets = rets.slice(-30);
  const meanRet = mean(recentRets); // per-minute drift (log)
  const vol = stddev(recentRets); // per-minute volatility (log)

  // Trend via linear regression over the last 30 minutes of price.
  const recentCloses = closes.slice(-30);
  const { slope, r2 } = linReg(recentCloses);
  const slopeRet = price > 0 ? slope / price : 0; // convert price slope to per-min return

  // Indicators.
  const rsiVal = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12 - ema26;

  // Mean-reversion bias from RSI extremes (small, per-minute).
  let mrBias = 0;
  if (rsiVal > 70) mrBias = -((rsiVal - 70) / 30) * 0.0004;
  else if (rsiVal < 30) mrBias = ((30 - rsiVal) / 30) * 0.0004;

  // Blended per-minute drift: momentum + regression trend + mean reversion.
  const drift = 0.45 * meanRet + 0.4 * slopeRet + 0.15 * mrBias;

  // Trend classification (signal-to-noise of the slope vs volatility).
  const trendStrength = clamp(Math.abs(slopeRet) / (vol + 1e-9), 0, 1);
  let trend: "up" | "down" | "flat" = "flat";
  if (macd > 0 && slopeRet > 0) trend = "up";
  else if (macd < 0 && slopeRet < 0) trend = "down";
  else if (slopeRet > vol * 0.5) trend = "up";
  else if (slopeRet < -vol * 0.5) trend = "down";

  const change24hPct = stats.open > 0 ? ((price - stats.open) / stats.open) * 100 : 0;
  const price1hAgo = closes.length >= 61 ? closes[closes.length - 61] : closes[0];
  const change1hPct = price1hAgo > 0 ? ((price - price1hAgo) / price1hAgo) * 100 : 0;

  const targets = nextQuarterTargets(now, 4);
  const predictions: Prediction[] = targets.map((target) => {
    const minutesAhead = Math.max(1, Math.round((target.getTime() - now.getTime()) / 60_000));
    const predictedPrice = price * Math.exp(drift * minutesAhead);
    // ~1 sigma random-walk band scaling with sqrt(time).
    const band = price * vol * Math.sqrt(minutesAhead);
    const low = predictedPrice - band;
    const high = predictedPrice + band;
    const changePct = price > 0 ? ((predictedPrice - price) / price) * 100 : 0;
    let direction: "up" | "down" | "flat" = "flat";
    if (changePct > 0.05) direction = "up";
    else if (changePct < -0.05) direction = "down";
    // Confidence: regression fit + trend strength, decaying with horizon.
    const conf = clamp(
      50 + r2 * 25 + trendStrength * 15 - (minutesAhead / 60) * 22,
      20,
      92,
    );
    return {
      target: target.toISOString(),
      label: estLabel(target),
      minutesAhead,
      predictedPrice,
      low,
      high,
      direction,
      confidence: Math.round(conf),
      changePct,
    };
  });

  return {
    symbol: coin.symbol,
    product: coin.product,
    name: coin.name,
    price,
    change24hPct,
    change1hPct,
    high24h: stats.high,
    low24h: stats.low,
    indicators: {
      rsi: Math.round(rsiVal * 10) / 10,
      sma20,
      ema12,
      ema26,
      macd,
      trend,
      trendStrength: Math.round(trendStrength * 100) / 100,
      volatilityPct: Math.round(vol * 10000) / 100,
    },
    sparkline: closes.slice(-60),
    candles: candles.slice(-90),
    predictions,
  };
}

// ---------------------------------------------------------------------------
// Claude AI prediction refinement — shared core used by both the automatic
// cache-refresh path and the on-demand /ai-predict endpoint.
// ---------------------------------------------------------------------------

export interface AIPrediction {
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
}

// Calls Claude with the full chart context for a CoinPrediction.
// Returns refined predictions in the same order as coin.predictions, or null
// if Claude is unavailable (caller falls back to the statistical model).
async function callClaudeForPredictions(coin: CoinPrediction): Promise<AIPrediction[] | null> {
  try {
    const recent = coin.candles.slice(-30);
    const candleRows = recent
      .map(
        (c) =>
          `${c.t},${c.o.toFixed(6)},${c.h.toFixed(6)},${c.l.toFixed(6)},${c.c.toFixed(6)},${c.v.toFixed(2)}`,
      )
      .join("\n");

    const rsiHint =
      coin.indicators.rsi >= 70 ? "overbought" : coin.indicators.rsi <= 30 ? "oversold" : "neutral";

    const baselineRows = coin.predictions
      .map(
        (p, i) =>
          `Target ${i + 1} (+${p.minutesAhead}min): $${p.predictedPrice.toFixed(6)}, range $${p.low.toFixed(6)}–$${p.high.toFixed(6)}, ${p.direction}, conf ${p.confidence}%`,
      )
      .join("\n");

    const userPrompt = `Refine price predictions for ${coin.symbol} (${coin.name}).
Current price: $${coin.price.toFixed(6)}

INDICATORS:
RSI(14): ${coin.indicators.rsi} (${rsiHint})
MACD: ${coin.indicators.macd >= 0 ? "Bullish" : "Bearish"} (raw: ${coin.indicators.macd.toFixed(6)})
Trend: ${coin.indicators.trend.toUpperCase()} | Strength: ${Math.round(coin.indicators.trendStrength * 100)}%
Volatility: ${coin.indicators.volatilityPct.toFixed(3)}%/min
SMA(20): $${coin.indicators.sma20.toFixed(6)}
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}%
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}%
24h range: $${coin.low24h.toFixed(6)}–$${coin.high24h.toFixed(6)}

RECENT 30 1-MIN CANDLES (oldest first, unix/open/high/low/close/volume):
${candleRows}

STATISTICAL MODEL BASELINE:
${baselineRows}

Instructions:
1. Identify concrete support and resistance levels from the candle data
2. Detect chart patterns (consolidation, breakout, wedge, flag, double top/bottom, channel, etc.)
3. For each of the ${coin.predictions.length} quarter-hour targets, provide your refined price estimate, a pessimistic low, and an optimistic high — these should reflect real price structure and key levels, not just formula extrapolation
4. Set direction (up/down/flat) and confidence (0-100) based on signal confluence

Return ONLY valid JSON, exactly ${coin.predictions.length} items in the same order as the baseline:
{
  "analysis": [
    {"predictedPrice": 0.0, "low": 0.0, "high": 0.0, "direction": "up", "confidence": 70}
  ]
}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system:
        "You are an expert crypto technical analyst and quantitative trader. Analyze chart patterns and price structure to produce refined short-term price predictions with concrete price targets. Your predictions should reflect real support/resistance levels and observable chart patterns. Respond with ONLY valid JSON — no markdown, no extra text.",
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      analysis: Array<{
        predictedPrice: number;
        low: number;
        high: number;
        direction: string;
        confidence: number;
      }>;
    };

    if (!Array.isArray(parsed.analysis) || parsed.analysis.length === 0) {
      return null;
    }

    const VALID_DIRS = new Set<string>(["up", "down", "flat"]);
    return coin.predictions.map((pred, i) => {
      const ai = parsed.analysis[i];
      if (!ai) {
        return {
          minutesAhead: pred.minutesAhead,
          predictedPrice: pred.predictedPrice,
          low: pred.low,
          high: pred.high,
          direction: pred.direction,
          confidence: pred.confidence,
        };
      }
      return {
        minutesAhead: pred.minutesAhead,
        predictedPrice: Number(ai.predictedPrice) || pred.predictedPrice,
        low: Number(ai.low) || pred.low,
        high: Number(ai.high) || pred.high,
        direction: (VALID_DIRS.has(ai.direction) ? ai.direction : pred.direction) as
          | "up"
          | "down"
          | "flat",
        confidence: Math.min(92, Math.max(20, Number(ai.confidence) || pred.confidence)),
      };
    });
  } catch {
    return null; // caller uses statistical baseline
  }
}

// Merges AIPrediction results back into a CoinPrediction, updating price
// targets, ranges, directions, confidence, and changePct.
function applyAIPredictions(coin: CoinPrediction, aiPreds: AIPrediction[]): CoinPrediction {
  return {
    ...coin,
    predictions: coin.predictions.map((p, i) => {
      const ai = aiPreds[i];
      if (!ai) return p;
      const predictedPrice = ai.predictedPrice;
      return {
        ...p,
        predictedPrice,
        low: ai.low,
        high: ai.high,
        direction: ai.direction,
        confidence: ai.confidence,
        changePct: coin.price > 0 ? ((predictedPrice - coin.price) / coin.price) * 100 : p.changePct,
      };
    }),
  };
}

// On-demand endpoint — forces a fresh Claude analysis for the selected coin
// (bypasses the predCache so the user always gets a new read on demand).
export async function fetchAIPredictions(symbol: string): Promise<{
  coin: string;
  predictions: AIPrediction[];
  generatedAt: string;
}> {
  const coinDef = CRYPTO_COINS.find((c) => c.symbol === symbol.toUpperCase());
  if (!coinDef) throw new Error(`Unknown symbol: ${symbol}`);

  const now = new Date();
  const [candles, stats, tickerPrice] = await Promise.all([
    getCandles(coinDef.product),
    getStats(coinDef.product),
    getTicker(coinDef.product).catch(() => 0),
  ]);
  const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
  const coin = analyzeCoin(coinDef, candles, stats, now, livePrice);

  const aiPreds = await callClaudeForPredictions(coin);
  if (!aiPreds) throw new Error("Claude analysis unavailable");

  return { coin: symbol, predictions: aiPreds, generatedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Prediction History Tracker
// Snaps predictions at each 15-min boundary, evaluates accuracy once the
// window closes. Keeps up to 8 entries per coin (= 2 hours of history).
// ---------------------------------------------------------------------------

export interface PredictionRecord {
  symbol: string;
  snappedAt: string;              // ISO — when snapshot was taken
  targetTime: string;             // ISO — the 15-min boundary being predicted
  targetLabel: string;            // "10:15 AM" in ET
  priceAtSnapshot: number;        // live price when snapshot was captured
  predictedPrice: number;         // model's price target for targetTime
  predictedDirection: "up" | "down" | "flat";
  confidence: number;
  kalshiTarget: number | null;    // Kalshi KXBTC15M strike at snap time (BTC only)
  actualPrice: number | null;     // filled in after targetTime passes
  errorPct: number | null;        // abs % difference from predicted
  correct: boolean | null;        // was the Kalshi YES/NO call right?
  evaluatedAt: string | null;
  status: "pending" | "evaluated";
}

const QUARTER_MS = 15 * 60 * 1000;
const MAX_HISTORY = 30; // last 30 quarter-hour predictions per coin
// Fallback accuracy threshold used when no Kalshi target is available.
// For coins other than BTC (no KXBTC15M market), a prediction is a "hit"
// only if direction is correct AND price is within this % of actual.
export const ACCURACY_THRESHOLD_PCT = 1.0;

// ---------------------------------------------------------------------------
// Kalshi KXBTC15M target price — fetched at snap time for BTC predictions
// ---------------------------------------------------------------------------

async function fetchKalshiBtcTarget(): Promise<number | null> {
  try {
    const resp = await fetch(
      "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5",
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as { markets?: { floor_strike?: number }[] };
    for (const m of body.markets ?? []) {
      if (typeof m.floor_strike === "number" && m.floor_strike > 0) return m.floor_strike;
    }
    return null;
  } catch {
    return null;
  }
}
const historyStore = new Map<string, PredictionRecord[]>(); // symbol → records

export function getPredictionHistory(symbol: string): PredictionRecord[] {
  return (historyStore.get(symbol.toUpperCase()) ?? []).slice().reverse(); // newest first
}

// ---------------------------------------------------------------------------
// Claude-powered refinement for the tracker snapshot.
// Called once per 15-min boundary per coin; falls back to statistical model.
// ---------------------------------------------------------------------------

async function refineSnappedPrediction(
  coin: CoinPrediction,
  basePred: Prediction,
): Promise<{ predictedPrice: number; direction: "up" | "down" | "flat"; confidence: number } | null> {
  try {
    const recent = coin.candles.slice(-30);
    const candleRows = recent
      .map(
        (c) =>
          `${c.t},${c.o.toFixed(6)},${c.h.toFixed(6)},${c.l.toFixed(6)},${c.c.toFixed(6)},${c.v.toFixed(2)}`,
      )
      .join("\n");

    const rsiHint =
      coin.indicators.rsi >= 70
        ? "overbought"
        : coin.indicators.rsi <= 30
          ? "oversold"
          : "neutral";

    const prompt = `Predict the price of ${coin.symbol} (${coin.name}) at ${basePred.label} ET (+${basePred.minutesAhead} minutes from now).

Current price: $${coin.price.toFixed(6)}

INDICATORS:
RSI(14): ${coin.indicators.rsi} (${rsiHint})
MACD: ${coin.indicators.macd >= 0 ? "Bullish" : "Bearish"} (raw: ${coin.indicators.macd.toFixed(6)})
Trend: ${coin.indicators.trend.toUpperCase()} | Strength: ${Math.round(coin.indicators.trendStrength * 100)}%
Volatility: ${coin.indicators.volatilityPct.toFixed(3)}%/min
SMA(20): $${coin.indicators.sma20.toFixed(6)}
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}%
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}%
24h range: $${coin.low24h.toFixed(6)}–$${coin.high24h.toFixed(6)}

RECENT 30 1-MIN CANDLES (oldest first, unix/open/high/low/close/volume):
${candleRows}

STATISTICAL MODEL BASELINE: $${basePred.predictedPrice.toFixed(6)}, ${basePred.direction}, conf ${basePred.confidence}%

Study the candle chart carefully. Identify key support/resistance levels and any chart patterns (e.g. consolidation, breakout, wedge, channel). Provide your best price target for the given window.

Return ONLY valid JSON (no markdown):
{"predictedPrice": 0.0, "direction": "up", "confidence": 70}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system:
        "You are an expert crypto technical analyst. Study the chart data and indicators carefully to produce a precise short-term price prediction. Respond with ONLY valid JSON — no markdown, no extra text.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      predictedPrice: number;
      direction: string;
      confidence: number;
    };

    const VALID_DIRS = new Set<string>(["up", "down", "flat"]);
    return {
      predictedPrice: Number(parsed.predictedPrice) || basePred.predictedPrice,
      direction: (VALID_DIRS.has(parsed.direction)
        ? parsed.direction
        : basePred.direction) as "up" | "down" | "flat",
      confidence: Math.min(92, Math.max(20, Number(parsed.confidence) || basePred.confidence)),
    };
  } catch {
    return null; // fall back to statistical model
  }
}

export function startPredictionTracker(): void {
  const tick = async () => {
    const nowMs = Date.now();
    const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);

    await Promise.all(
      CRYPTO_COINS.map(async (coin) => {
        const sym = coin.symbol;
        if (!historyStore.has(sym)) historyStore.set(sym, []);
        const records = historyStore.get(sym)!;

        // 1. Evaluate pending records whose target time has passed.
        for (const rec of records) {
          if (rec.status === "pending" && new Date(rec.targetTime).getTime() <= nowMs) {
            try {
              const actual = await getTicker(coin.product);
              const snapshotPrice = rec.priceAtSnapshot;
              const actualDir: "up" | "down" | "flat" =
                actual > snapshotPrice * 1.0002 ? "up"
                : actual < snapshotPrice * 0.9998 ? "down"
                : "flat";
              const errorPct =
                Math.abs((actual - rec.predictedPrice) / rec.predictedPrice) * 100;
              let correct: boolean;
              if (rec.kalshiTarget !== null && rec.kalshiTarget !== undefined) {
                // Kalshi target known: a "hit" = Claude predicted the same side of
                // the target as where BTC actually landed (mirrors Kalshi YES/NO).
                const predictedAbove = rec.predictedPrice >= rec.kalshiTarget;
                const actualAbove    = actual >= rec.kalshiTarget;
                correct = predictedAbove === actualAbove;
              } else {
                // No Kalshi target (non-BTC, or Kalshi market wasn't active at snap).
                // Fall back: direction correct AND price within threshold.
                const directionCorrect =
                  rec.predictedDirection === "flat"
                    ? actualDir === "flat"
                    : rec.predictedDirection === actualDir;
                correct = directionCorrect && errorPct <= ACCURACY_THRESHOLD_PCT;
              }
              rec.actualPrice = actual;
              rec.errorPct = errorPct;
              rec.correct = correct;
              rec.evaluatedAt = new Date().toISOString();
              rec.status = "evaluated";
            } catch {
              // retry on next tick
            }
          }
        }

        // 2. Snapshot a new prediction for the next boundary if not already done.
        const targetISO = nextBoundary.toISOString();
        const timeToNext = nextBoundary.getTime() - nowMs;
        const alreadySnapped = records.some((r) => r.targetTime === targetISO);

        // Only snapshot when there's at least 60s left (avoid capturing a
        // stale prediction right before the boundary flips).
        if (!alreadySnapped && timeToNext > 60_000) {
          try {
            const [candles, stats, tickerPrice] = await Promise.all([
              getCandles(coin.product),
              getStats(coin.product),
              getTicker(coin.product).catch(() => 0),
            ]);
            const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
            const analysis = analyzeCoin(coin, candles, stats, new Date(nowMs), livePrice);
            const basePred =
              analysis.predictions.find((p) => p.target === targetISO) ??
              analysis.predictions[0];
            if (basePred) {
              // Ask Claude to study the chart and refine the prediction.
              // Falls back to the statistical model if the API call fails.
              // For BTC, also snap the Kalshi KXBTC15M target in parallel.
              const [ai, kalshiTarget] = await Promise.all([
                refineSnappedPrediction(analysis, basePred),
                sym === "BTC" ? fetchKalshiBtcTarget() : Promise.resolve(null),
              ]);
              records.push({
                symbol: sym,
                snappedAt: new Date(nowMs).toISOString(),
                targetTime: targetISO,
                targetLabel: basePred.label,
                priceAtSnapshot: analysis.price,
                predictedPrice: ai?.predictedPrice ?? basePred.predictedPrice,
                predictedDirection: ai?.direction ?? basePred.direction,
                confidence: ai?.confidence ?? basePred.confidence,
                kalshiTarget,
                actualPrice: null,
                errorPct: null,
                correct: null,
                evaluatedAt: null,
                status: "pending",
              });
              if (records.length > MAX_HISTORY)
                records.splice(0, records.length - MAX_HISTORY);
            }
          } catch {
            // non-fatal — will retry next tick
          }
        }
      }),
    );
  };

  // Run immediately on startup, then every 60 seconds.
  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), 60_000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchCryptoPredictions(): Promise<{
  generatedAt: string;
  coins: CoinPrediction[];
}> {
  const now = new Date();
  const coins = await Promise.all(
    CRYPTO_COINS.map(async (coin) => {
      try {
        // Return cached analysis if within the 3.5-min stable window.
        const hit = predCache.get(coin.symbol);
        if (hit && Date.now() - hit.at < PRED_TTL) return hit.value;

        const [candles, stats, tickerPrice] = await Promise.all([
          getCandles(coin.product),
          getStats(coin.product),
          getTicker(coin.product).catch(() => 0),
        ]);
        const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
        const result = analyzeCoin(coin, candles, stats, now, livePrice);

        predCache.set(coin.symbol, { at: Date.now(), value: result });
        return result;
      } catch {
        return null;
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    coins: coins.filter((c): c is CoinPrediction => c !== null),
  };
}

// ---------------------------------------------------------------------------
// Dedicated Kalshi BTC call — one focused Claude question per market window
// ---------------------------------------------------------------------------

interface KalshiBtcCallResult {
  above: boolean;
  confidence: number;
  predictedPrice: number;
}

// Cache keyed by Kalshi eventTicker so the same answer is reused within a window.
const kalshiBtcCallCache = new Map<string, KalshiBtcCallResult>();

export async function fetchKalshiBtcCall(
  kalshiTarget: number,
  eventTicker: string,
): Promise<KalshiBtcCallResult | null> {
  // Return cached result for the same Kalshi window.
  const cached = kalshiBtcCallCache.get(eventTicker);
  if (cached) return cached;

  try {
    const btc = CRYPTO_COINS.find((c) => c.symbol === "BTC")!;
    const [candles, stats, tickerPrice] = await Promise.all([
      getCandles(btc.product),
      getStats(btc.product),
      getTicker(btc.product).catch(() => 0),
    ]);
    const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
    const analysis = analyzeCoin(btc, candles, stats, new Date(), livePrice);
    const price = livePrice ?? analysis.price;

    const recent = candles.slice(-20);
    const candleRows = recent
      .map((c) => `${c.t},${c.o.toFixed(2)},${c.h.toFixed(2)},${c.l.toFixed(2)},${c.c.toFixed(2)}`)
      .join("\n");

    const ind = analysis.indicators;
    const rsiHint = ind.rsi >= 70 ? "overbought" : ind.rsi <= 30 ? "oversold" : "neutral";

    const prompt = `BTC/USD Kalshi market question.

Current price: $${price.toFixed(2)}
Kalshi target (floor strike): $${kalshiTarget.toFixed(2)}
Gap to target: ${(price - kalshiTarget).toFixed(2)} (${((price - kalshiTarget) / kalshiTarget * 100).toFixed(3)}%)

INDICATORS:
RSI(14): ${ind.rsi.toFixed(1)} (${rsiHint})
MACD: ${ind.macd >= 0 ? "Bullish" : "Bearish"} (${ind.macd.toFixed(2)})
Trend: ${ind.trend.toUpperCase()} | Strength: ${Math.round(ind.trendStrength * 100)}%
Volatility: ${ind.volatilityPct.toFixed(3)}%/min
1h change: ${analysis.change1hPct.toFixed(3)}%

RECENT 20 1-MIN CANDLES (unix,open,high,low,close):
${candleRows}

Question: Will BTC close ABOVE or BELOW the Kalshi target of $${kalshiTarget.toFixed(2)} in the next 15 minutes?

Return ONLY valid JSON:
{"side":"above","predictedPrice":0.00,"confidence":70}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system:
        "You are an expert crypto short-term trader. You MUST respond with ONLY a raw JSON object — no markdown, no explanation, no analysis text. Your entire response is the JSON object and nothing else.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";

    // Try to extract a JSON object anywhere in the response.
    let parsed: { side: string; predictedPrice: number; confidence: number } | null = null;
    const jsonMatch = raw.match(/\{[^{}]*"side"[^{}]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }

    // Fallback: parse the prose for ABOVE / BELOW keywords.
    if (!parsed) {
      const lower = raw.toLowerCase();
      const sideInferred = lower.includes("above") ? "above" : "below";
      const confMatch = lower.match(/(\d{2,3})%\s*confidence|\bconfidence[:\s]+(\d{2,3})/);
      const confidence = confMatch ? parseInt(confMatch[1] ?? confMatch[2]) : 65;
      const priceMatch = raw.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
      const inferredPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : price;
      parsed = { side: sideInferred, confidence, predictedPrice: inferredPrice || price };
    }

    const result: KalshiBtcCallResult = {
      above: parsed.side === "above",
      confidence: Math.min(95, Math.max(20, Number(parsed.confidence) || 60)),
      predictedPrice: Number(parsed.predictedPrice) || price,
    };

    kalshiBtcCallCache.set(eventTicker, result);
    // Evict old window answers (keep at most 5 entries)
    if (kalshiBtcCallCache.size > 5) {
      kalshiBtcCallCache.delete(kalshiBtcCallCache.keys().next().value!);
    }
    return result;
  } catch (err) {
    console.error("[fetchKalshiBtcCall] error:", err);
    return null;
  }
}

export async function fetchCryptoPrices(): Promise<{
  generatedAt: string;
  prices: CoinPrice[];
}> {
  const now = new Date();
  // Use CoinGecko for 24h change % (aggregated reference) and Coinbase ticker for
  // the live price (per-tick precision, full decimal, no rounding).
  const gecko = await getGeckoPrices().catch(() => ({} as GeckoPrices));

  const prices = await Promise.all(
    CRYPTO_COINS.map(async (coin) => {
      try {
        const geckoEntry = gecko[GECKO_ID[coin.symbol] ?? ""];
        // Always fetch ticker (precise live price) and stats (24h open for fallback change %).
        const [tickerPrice, stats] = await Promise.all([
          getTicker(coin.product),
          geckoEntry?.usd_24h_change == null ? getStats(coin.product) : Promise.resolve(null),
        ]);
        const change24hPct =
          geckoEntry?.usd_24h_change != null
            ? geckoEntry.usd_24h_change
            : stats
              ? stats.open > 0 ? ((tickerPrice - stats.open) / stats.open) * 100 : 0
              : 0;
        return {
          symbol: coin.symbol,
          product: coin.product,
          name: coin.name,
          price: tickerPrice,
          change24hPct,
        };
      } catch {
        // Full fallback: Coinbase stats
        try {
          const stats = await getStats(coin.product);
          const change24hPct =
            stats.open > 0 ? ((stats.last - stats.open) / stats.open) * 100 : 0;
          return {
            symbol: coin.symbol,
            product: coin.product,
            name: coin.name,
            price: stats.last,
            change24hPct,
          };
        } catch {
          return null;
        }
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    prices: prices.filter((p): p is CoinPrice => p !== null),
  };
}
