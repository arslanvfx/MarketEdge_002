// ---------------------------------------------------------------------------
// crypto-claude.ts — all Claude AI prediction functions
// ---------------------------------------------------------------------------

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { isAiFeatureEnabled, getAiThinkingBudget, getAiSelfConsistency } from "./ai-spend";
import {
  clamp, mean, median, vwap,
  priceDp, obBucket, formatOrderBook,
  type Candle, type OrderBook,
} from "./crypto-indicators";
import { CRYPTO_COINS, getCandles, getStats, getTicker, get5mCandles, getOrderBook, type CoinPrediction, type Prediction } from "./crypto-data";
import { historyStore, type PredictionRecord } from "./crypto-history";
import { KALSHI_SERIES, fetchKalshiTarget, kalshiTargetCache, getKalshiWindowContext, updateKalshiWindowPrice, getLastKalshiTicker, lastMLAboveCache } from "./crypto-kalshi";
import { computeStatWindowCall } from "./prediction-utils";
import { getMLStatus, getMLPrediction } from "./ml-store";
import { extractMLFeatures } from "./ml-features";
import { analyzeCoin, regimeFromER, type PromptRegime } from "./crypto-stat";
import { calibrateConfidence, ensembleWeights, ENSEMBLE_ABSTAIN_MIN_CONF } from "./crypto-analytics";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Self-consistency settings (exported so tracker can expose them in API)
// ---------------------------------------------------------------------------
let selfConsistencySamples = 1;
const MAX_SELF_CONSISTENCY = 5;

export function getSelfConsistencySamples(): number {
  return selfConsistencySamples;
}

export function setSelfConsistencySamples(n: number): number {
  selfConsistencySamples = clamp(Math.round(n) || 1, 1, MAX_SELF_CONSISTENCY);
  return selfConsistencySamples;
}

// ---------------------------------------------------------------------------
// Prompt helper: intra-window momentum block for Claude prompts
// ---------------------------------------------------------------------------
function intraWindowBlock(ind: CoinPrediction["indicators"]): string {
  const er = ind.efficiencyRatio;
  const regimeLabel: Record<PromptRegime, string> = {
    trending: "TRENDING (clean directional move — momentum is reliable)",
    drifting: "DRIFTING (mixed — momentum is weak, treat edge as modest)",
    choppy: "CHOPPY (price is sawing back and forth — momentum is unreliable)",
  };
  const regime = regimeLabel[regimeFromER(er)];
  const drift = ind.netDriftPct >= 0 ? "+" : "";
  const spikeLine = ind.spikeFlag
    ? `Spike: YES — a candle ranged ${ind.spikeMultiple.toFixed(2)}× the median; recent move may be a one-off blip, not sustained order flow.`
    : "Spike: none — candle ranges are orderly.";
  return `
INTRA-WINDOW MOMENTUM (last 15 × 1-min candles — what price is doing RIGHT NOW):
Regime: ${regime}
Efficiency ratio: ${er.toFixed(3)} (|net move| ÷ total path; 1=clean trend, 0=pure chop)
Oscillations: ${ind.oscillationCount} close-to-close direction reversals
Net drift: ${drift}${ind.netDriftPct.toFixed(3)}% | Total path travelled: ${ind.totalPathPct.toFixed(3)}%
${spikeLine}`;
}

// ---------------------------------------------------------------------------
// Calibration bias computation (Claude-only records, regime-bucketed)
// ---------------------------------------------------------------------------
const BIAS_MIN_BUCKET = 3;

function computeSignedBias(
  symbol: string,
  opts?: { regime?: PromptRegime; lastN?: number },
): string {
  const lastN = opts?.lastN ?? 10;
  const all = (historyStore.get(symbol) ?? []).filter(
    (r) =>
      r.source === "claude" &&
      r.status === "evaluated" &&
      r.actualPrice !== null &&
      (r.actualPrice ?? 0) > 0,
  );

  let records = all;
  let scope = "all regimes";
  if (opts?.regime) {
    const bucket = all.filter(
      (r) => r.efficiencyRatio != null && regimeFromER(r.efficiencyRatio) === opts.regime,
    );
    if (bucket.length >= BIAS_MIN_BUCKET) {
      records = bucket;
      scope = `${opts.regime} regime`;
    }
  }
  records = records.slice(-lastN);

  if (records.length < 3) {
    return `Insufficient history for bias calibration (n=${records.length}, ${scope}).`;
  }

  const signedPctErrors = records.map(
    (r) => (((r.predictedPrice ?? 0) - (r.actualPrice ?? 0)) / (r.actualPrice ?? 1)) * 100,
  );
  const avg = signedPctErrors.reduce((a, b) => a + b, 0) / signedPctErrors.length;
  const absAvg = Math.abs(avg);

  if (absAvg < 0.5) {
    return `Well-calibrated: avg signed error ${avg >= 0 ? "+" : ""}${avg.toFixed(3)}% (n=${records.length}, ${scope}). No adjustment needed.`;
  }
  const dir = avg > 0 ? "HIGH" : "LOW";
  const adj = avg > 0 ? "DOWN" : "UP";
  return `CALIBRATION REQUIRED: recent predictions averaged ${absAvg.toFixed(2)}% too ${dir} (signed avg = ${avg >= 0 ? "+" : ""}${avg.toFixed(3)}%, n=${records.length}, ${scope}). Shift your price target ${adj} by ~${absAvg.toFixed(2)}% to correct this systematic bias.`;
}

// ---------------------------------------------------------------------------
// AIPrediction interface + callClaudeForPredictions
// ---------------------------------------------------------------------------

export interface AIPrediction {
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
}

async function callClaudeForPredictions(
  coin: CoinPrediction,
  extra?: { candles5m?: Candle[]; orderBook?: OrderBook; kalshiTarget?: number | null; windowOpenPrice?: number | null; minutesElapsed?: number },
): Promise<AIPrediction[] | null> {
  try {
    const dp = priceDp(coin.price);
    const recent = coin.candles.slice(-60);
    const candleRows = recent
      .map(
        (c) =>
          `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`,
      )
      .join("\n");

    const rsiHint =
      coin.indicators.rsi >= 70 ? "overbought" : coin.indicators.rsi <= 30 ? "oversold" : "neutral";

    const bbPos =
      coin.indicators.bbPctB > 80
        ? "near upper band (overbought zone)"
        : coin.indicators.bbPctB < 20
          ? "near lower band (oversold zone)"
          : `mid-band (${coin.indicators.bbPctB.toFixed(1)}%B)`;

    const sorted = [...recent].sort((a, b) => b.v - a.v).slice(0, 3);
    const volSpikes = sorted
      .map((c) => `  t=${c.t} vol=${c.v.toFixed(2)} close=$${c.c.toFixed(dp)}`)
      .join("\n");

    const next15 = coin.predictions[0];
    const baselineRows = next15
      ? `+${next15.minutesAhead}min: $${next15.predictedPrice.toFixed(dp)}, range $${next15.low.toFixed(dp)}–$${next15.high.toFixed(dp)}, ${next15.direction}, conf ${next15.confidence}%`
      : "";

    const atr15Low  = (coin.indicators.atr14 * 1).toFixed(dp);
    const atr15High = (coin.indicators.atr14 * 3).toFixed(dp);
    const expectedMoveBlock = `Expected 15-min move range: $${atr15Low}–$${atr15High} (1–3× ATR). Your predictedPrice MUST be within this band of the current price and expressed to ${dp} decimal places — do NOT round to the nearest whole dollar or half-dollar.`;

    let multiTfBlock = "";
    let htfLine = "";
    if (extra?.candles5m && extra.candles5m.length > 0) {
      const c5m = extra.candles5m.slice(-24);
      const vwapVal = vwap(c5m);
      const rows5m = c5m
        .map((c) => `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`)
        .join("\n");
      const vwapRel = coin.price > vwapVal ? "above VWAP (bullish bias)" : "below VWAP (bearish bias)";
      multiTfBlock = `
VWAP (4-hour, 5-min candles): $${vwapVal.toFixed(dp)} — price is ${vwapRel}

LAST 24 × 5-MIN CANDLES — 2-hour structure (oldest first, unix/open/high/low/close/volume):
${rows5m}`;

      const fullC5m = extra.candles5m;
      if (fullC5m.length >= 4) {
        const oldest5m = fullC5m[0].o;
        const newest5m = fullC5m[fullC5m.length - 1].c;
        const htfChangePct = oldest5m > 0 ? ((newest5m - oldest5m) / oldest5m) * 100 : 0;
        const htfDir = htfChangePct > 0.15 ? "UPTREND" : htfChangePct < -0.15 ? "DOWNTREND" : "SIDEWAYS";
        htfLine = `4h candle trend: ${htfDir} (${htfChangePct >= 0 ? "+" : ""}${htfChangePct.toFixed(3)}% over ${fullC5m.length} × 5-min bars)`;
      }
    }

    const rangeWidth = coin.high24h - coin.low24h;
    const rangePosPct = rangeWidth > 0 ? ((coin.price - coin.low24h) / rangeWidth) * 100 : 50;
    const rangeDesc =
      rangePosPct >= 85 ? "near 24h HIGH — watch for exhaustion/reversal" :
      rangePosPct <= 15 ? "near 24h LOW — watch for oversold bounce" :
      rangePosPct >= 60 ? "upper half of day range — momentum favors upside continuation" :
      rangePosPct <= 40 ? "lower half of day range — momentum favors downside continuation" :
      "mid day range — no strong intraday directional bias";
    const dayTrendBlock = `
DAY CONTEXT — how ${coin.symbol} has traded today (use this to anchor directional bias):
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}% from yesterday's close
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}% (recent hourly momentum)
Day range: $${coin.low24h.toFixed(dp)} – $${coin.high24h.toFixed(dp)} | Current price is ${rangePosPct.toFixed(0)}% up from day low (${rangeDesc})
${htfLine}
RULE: If price has been trending in one direction all day, bias toward continuation unless indicators show a clear reversal (divergence, key rejection, volume breakdown).`;

    let orderBookBlock = "";
    if (extra?.orderBook) {
      orderBookBlock = `
LIVE ORDER BOOK — $${obBucket(coin.price)} price buckets (use these as real support/resistance levels):
${formatOrderBook(extra.orderBook, coin.price, coin.symbol)}`;
    }

    let kalshiBlock = "";
    const kt = extra?.kalshiTarget ?? null;
    if (kt !== null && kt > 0) {
      const gap = ((coin.price - kt) / kt) * 100;
      const side = gap >= 0 ? "ABOVE" : "BELOW";
      let trajectoryLine = "";
      const wop = extra?.windowOpenPrice;
      const wme = extra?.minutesElapsed;
      if (wop && wop > 0 && wme != null) {
        const openGap = ((wop - kt) / kt) * 100;
        const openSide = openGap >= 0 ? "ABOVE" : "BELOW";
        const trend = Math.abs(gap) > Math.abs(openGap) ? "moving away from" : "moving toward";
        trajectoryLine = `\nWindow opened ${wme}min ago at $${wop.toFixed(dp)} (${Math.abs(openGap).toFixed(3)}% ${openSide}) — price is ${trend} the strike.`;
      }
      kalshiBlock = `
══ KALSHI 15-MIN BINARY TARGET ══════════════════════════════════════
Kalshi strike: $${kt.toFixed(dp)}  ← this is ${coin.symbol}'s closing price at the START of this window (previous window's close). The question is whether price ends the window ABOVE or BELOW where it opened.
Current price: $${coin.price.toFixed(dp)} — ${Math.abs(gap).toFixed(3)}% ${side} the strike${trajectoryLine}
PRIMARY QUESTION: Will ${coin.symbol} close ABOVE or BELOW $${kt.toFixed(dp)}?
This is the binary you must answer. All indicators below are evidence for or against.
═════════════════════════════════════════════════════════════════════
`;
    }

    const userPrompt = `${kalshiBlock}Refine price predictions for ${coin.symbol} (${coin.name}).
Current price: $${coin.price.toFixed(dp)}

INDICATORS:
RSI(14): ${coin.indicators.rsi} (${rsiHint})
MACD: ${coin.indicators.macd >= 0 ? "Bullish" : "Bearish"} (signal: ${coin.indicators.macd.toFixed(4)})
Trend: ${coin.indicators.trend.toUpperCase()} | Strength: ${Math.round(coin.indicators.trendStrength * 100)}%
Volatility: ${coin.indicators.volatilityPct.toFixed(3)}%/min
SMA(20): $${coin.indicators.sma20.toFixed(dp)}
Bollinger Bands(20,2): upper=$${coin.indicators.bbUpper.toFixed(dp)} / lower=$${coin.indicators.bbLower.toFixed(dp)} | width=${coin.indicators.bbWidth.toFixed(2)}% | price ${bbPos}
ATR(14): $${coin.indicators.atr14.toFixed(dp)} (expected move per bar)
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}%
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}%
24h range: $${coin.low24h.toFixed(dp)}–$${coin.high24h.toFixed(dp)}
${intraWindowBlock(coin.indicators)}
${dayTrendBlock}
${multiTfBlock}
TOP-3 VOLUME SPIKES (possible order-flow events):
${volSpikes}
${orderBookBlock}
RECENT 60 1-MIN CANDLES (oldest first, unix/open/high/low/close/volume):
${candleRows}

STATISTICAL MODEL BASELINE:
${baselineRows}

PRECISION REQUIREMENT:
${expectedMoveBlock}

Instructions:
1. Use the LIVE ORDER BOOK as your primary support/resistance map — walls are real levels, not inferred ones
2. Use the 5-min candles for 2-hour structure (trend, channels, key swing highs/lows) before zooming into the 1-min detail
3. Identify VWAP position: price above VWAP favors continuation up; below favors continuation down
4. Identify chart patterns and volume-price relationship on both timeframes
5. Use Bollinger Band position to judge momentum compression/expansion
6. Use ATR to calibrate realistic move size over each 15-minute window (see PRECISION REQUIREMENT above)
7. Weigh the INTRA-WINDOW MOMENTUM regime heavily: in a CHOPPY / low efficiency-ratio window price is sawing back and forth, so directional edge is weak — lower your confidence accordingly. Only a TRENDING (high ER) window justifies high confidence
8. If a spike is flagged, treat the recent move with caution — it may be a one-off blip rather than sustained order flow; do not over-extrapolate it
9. Factor in the DAY CONTEXT: if 24h change and 4h candle trend both point the same direction, that macro bias should anchor your prediction. Only override it if you see clear reversal evidence (divergence, key rejection level, volume breakdown)
10. Produce your best price estimate for the NEXT 15-MIN TARGET ONLY, plus a pessimistic low and optimistic high
11. Set direction (up/down/flat) and confidence (0-100) based on signal confluence; penalise confidence when signals conflict or when the window is choppy

Return ONLY valid JSON with exactly 1 item:
{
  "analysis": [
    {"predictedPrice": 0.0, "low": 0.0, "high": 0.0, "direction": "up", "confidence": 70}
  ]
}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: getAiThinkingBudget() },
      system:
        "You are an expert crypto technical analyst and quantitative trader. When a Kalshi binary target is shown, your primary job is to determine whether price will be above or below that strike — not just to predict general direction. Analyze chart patterns, indicators, and the live order book to produce refined short-term price predictions. Respond with ONLY valid JSON after your thinking — no markdown, no extra text.",
      messages: [{ role: "user", content: userPrompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("") || "";
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
        confidence: calibrateConfidence(coin.symbol, Number(ai.confidence) || pred.confidence),
      };
    });
  } catch {
    return null;
  }
}

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

export { applyAIPredictions };

export async function fetchAIPredictions(symbol: string): Promise<{
  coin: string;
  predictions: AIPrediction[];
  ensembleWeights: ReturnType<typeof ensembleWeights>;
  ensembleRegime: PromptRegime;
  abstainMinConf: number;
  generatedAt: string;
}> {
  const coinDef = CRYPTO_COINS.find((c) => c.symbol === symbol.toUpperCase());
  if (!coinDef) throw new Error(`Unknown symbol: ${symbol}`);

  const now = new Date();
  const [candles, stats, tickerPrice, candles5m, orderBook, kalshiTargetPrice] = await Promise.all([
    getCandles(coinDef.product),
    getStats(coinDef.product),
    getTicker(coinDef.product).catch(() => 0),
    get5mCandles(coinDef.product).catch(() => [] as Candle[]),
    getOrderBook(coinDef.product).catch(() => undefined),
    fetchKalshiTarget(symbol.toUpperCase()).catch(() => null),
  ]);
  const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
  const coin = analyzeCoin(coinDef, candles, stats, now, livePrice);

  updateKalshiWindowPrice(getLastKalshiTicker(symbol.toUpperCase()), coin.price);
  const winCtx = getKalshiWindowContext(symbol.toUpperCase());
  const aiPreds = await callClaudeForPredictions(coin, {
    candles5m,
    orderBook,
    kalshiTarget: kalshiTargetPrice,
    windowOpenPrice: winCtx?.priceAtOpen,
    minutesElapsed: winCtx?.minutesElapsed,
  });
  if (!aiPreds) throw new Error("Claude analysis unavailable");

  const ensembleRegime = regimeFromER(coin.indicators.efficiencyRatio);
  return {
    coin: symbol,
    predictions: aiPreds,
    ensembleWeights: ensembleWeights(symbol.toUpperCase(), ensembleRegime),
    ensembleRegime,
    abstainMinConf: ENSEMBLE_ABSTAIN_MIN_CONF,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tracker snap: refineSnappedPrediction + refineWithSelfConsistency
// ---------------------------------------------------------------------------

export async function refineSnappedPrediction(
  coin: CoinPrediction,
  basePred: Prediction,
  extra?: { candles5m?: Candle[]; orderBook?: OrderBook; kalshiTarget?: number | null; windowOpenPrice?: number | null; minutesElapsed?: number },
): Promise<{ predictedPrice: number; direction: "up" | "down" | "flat"; confidence: number } | null> {
  try {
    const dp = priceDp(coin.price);
    const recent = coin.candles.slice(-60);
    const candleRows = recent
      .map(
        (c) =>
          `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`,
      )
      .join("\n");

    const rsiHint =
      coin.indicators.rsi >= 70
        ? "overbought"
        : coin.indicators.rsi <= 30
          ? "oversold"
          : "neutral";

    const bbPos =
      coin.indicators.bbPctB > 80
        ? "near upper band (overbought zone)"
        : coin.indicators.bbPctB < 20
          ? "near lower band (oversold zone)"
          : `mid-band (${coin.indicators.bbPctB.toFixed(1)}%B)`;

    const sorted = [...recent].sort((a, b) => b.v - a.v).slice(0, 3);
    const volSpikes = sorted
      .map((c) => `  t=${c.t} vol=${c.v.toFixed(2)} close=$${c.c.toFixed(dp)}`)
      .join("\n");

    const recentEvals = (historyStore.get(coin.symbol) ?? [])
      .filter((r) => r.source === "claude" && r.status === "evaluated" && r.errorPct != null)
      .slice(-5);
    const formatEval = (r: PredictionRecord): string => {
      const rdp = priceDp(r.priceAtSnapshot ?? r.predictedPrice);
      const kt = r.kalshiTarget;
      if (kt != null) {
        const predSide = r.predictedPrice >= kt ? "ABOVE" : "BELOW";
        const actSide =
          r.actualPrice != null
            ? r.actualPrice >= kt
              ? "ABOVE"
              : "BELOW"
            : "?";
        return (
          `  ${r.targetLabel}: predicted ${predSide} $${kt.toFixed(rdp)} strike` +
          ` → $${r.predictedPrice?.toFixed(rdp)} | actual ${actSide} at $${r.actualPrice?.toFixed(rdp)}` +
          ` | ${r.correct ? "HIT ✓" : "MISS ✗"}`
        );
      }
      return (
        `  ${r.targetLabel}: predicted $${r.predictedPrice?.toFixed(rdp)}` +
        ` → actual $${r.actualPrice?.toFixed(rdp)}` +
        ` | error ${r.errorPct?.toFixed(2)}%` +
        ` | ${r.correct ? "HIT ✓" : "MISS ✗"}`
      );
    };

    const feedbackStr =
      recentEvals.length > 0
        ? recentEvals.map(formatEval).join("\n")
        : "  No evaluated predictions yet.";

    const worstCalls = (historyStore.get(coin.symbol) ?? [])
      .filter((r) => r.source === "claude" && r.status === "evaluated" && r.correct === false && r.errorPct != null)
      .slice(-15)
      .sort((a, b) => (b.errorPct ?? 0) - (a.errorPct ?? 0))
      .slice(0, 3);
    const worstStr =
      worstCalls.length > 0
        ? worstCalls
            .map((r) => {
              const rdp = priceDp(r.priceAtSnapshot ?? r.predictedPrice);
              const kt = r.kalshiTarget;
              if (kt != null) {
                const predSide = r.predictedPrice >= kt ? "ABOVE" : "BELOW";
                const actSide =
                  r.actualPrice != null
                    ? r.actualPrice >= kt
                      ? "ABOVE"
                      : "BELOW"
                    : "?";
                return (
                  `  ${r.targetLabel}: predicted ${predSide} $${kt.toFixed(rdp)} (conf ${r.confidence}%)` +
                  ` but actual ${actSide} | error ${r.errorPct?.toFixed(2)}% ✗`
                );
              }
              return (
                `  ${r.targetLabel}: called ${r.predictedDirection} → $${r.predictedPrice?.toFixed(rdp)}` +
                ` (conf ${r.confidence}%) but actual $${r.actualPrice?.toFixed(rdp)}` +
                ` | off by ${r.errorPct?.toFixed(2)}% ✗`
              );
            })
            .join("\n")
        : "  No notable recent misses.";

    const currentRegime = regimeFromER(coin.indicators.efficiencyRatio);
    const calibrationStr = computeSignedBias(coin.symbol, { regime: currentRegime });

    const atr15Low  = (coin.indicators.atr14 * 1).toFixed(dp);
    const atr15High = (coin.indicators.atr14 * 3).toFixed(dp);
    const expectedMoveBlock = `Expected 15-min move range: $${atr15Low}–$${atr15High} (1–3× ATR). Your predictedPrice MUST be within this band of the current price and expressed to ${dp} decimal places — do NOT round to the nearest whole dollar or half-dollar.`;

    let multiTfBlock = "";
    if (extra?.candles5m && extra.candles5m.length > 0) {
      const c5m = extra.candles5m.slice(-24);
      const vwapVal = vwap(c5m);
      const rows5m = c5m
        .map((c) => `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`)
        .join("\n");
      const vwapRel = coin.price > vwapVal ? "above VWAP (bullish bias)" : "below VWAP (bearish bias)";
      multiTfBlock = `
VWAP (4-hour, 5-min candles): $${vwapVal.toFixed(dp)} — price is ${vwapRel}

LAST 24 × 5-MIN CANDLES — 2-hour structure (oldest first, unix/open/high/low/close/volume):
${rows5m}`;
    }

    let orderBookBlock = "";
    if (extra?.orderBook) {
      orderBookBlock = `
LIVE ORDER BOOK — $${obBucket(coin.price)} price buckets (use as real support/resistance levels):
${formatOrderBook(extra.orderBook, coin.price, coin.symbol)}`;
    }

    let kalshiBlock = "";
    const kt = extra?.kalshiTarget ?? null;
    if (kt !== null && kt > 0) {
      const gap = ((coin.price - kt) / kt) * 100;
      const side = gap >= 0 ? "ABOVE" : "BELOW";
      let trajectoryLine = "";
      const wop = extra?.windowOpenPrice;
      const wme = extra?.minutesElapsed;
      if (wop && wop > 0 && wme != null) {
        const openGap = ((wop - kt) / kt) * 100;
        const openSide = openGap >= 0 ? "ABOVE" : "BELOW";
        const trend = Math.abs(gap) > Math.abs(openGap) ? "moving away from" : "moving toward";
        trajectoryLine = `\nWindow opened ${wme}min ago at $${wop.toFixed(dp)} (${Math.abs(openGap).toFixed(3)}% ${openSide}) — price is ${trend} the strike.`;
      }
      kalshiBlock = `
══ KALSHI 15-MIN BINARY TARGET ══════════════════════════════════════
Kalshi strike: $${kt.toFixed(dp)}  ← this is ${coin.symbol}'s closing price at the START of this window (previous window's close). The question is whether price ends the window ABOVE or BELOW where it opened.
Current price: $${coin.price.toFixed(dp)} — ${Math.abs(gap).toFixed(3)}% ${side} the strike${trajectoryLine}
PRIMARY QUESTION: Will ${coin.symbol} close ABOVE or BELOW $${kt.toFixed(dp)} at ${basePred.label} ET?
This is the binary you must answer. All indicators below are evidence for or against.
═════════════════════════════════════════════════════════════════════
`;
    }

    const prompt = `${kalshiBlock}Predict the price of ${coin.symbol} (${coin.name}) at ${basePred.label} ET (+${basePred.minutesAhead} minutes from now).

Current price: $${coin.price.toFixed(dp)}

INDICATORS:
RSI(14): ${coin.indicators.rsi} (${rsiHint})
MACD: ${coin.indicators.macd >= 0 ? "Bullish" : "Bearish"} (signal: ${coin.indicators.macd.toFixed(4)})
Trend: ${coin.indicators.trend.toUpperCase()} | Strength: ${Math.round(coin.indicators.trendStrength * 100)}%
Volatility: ${coin.indicators.volatilityPct.toFixed(3)}%/min
SMA(20): $${coin.indicators.sma20.toFixed(dp)}
Bollinger Bands(20,2): upper=$${coin.indicators.bbUpper.toFixed(dp)} / lower=$${coin.indicators.bbLower.toFixed(dp)} | width=${coin.indicators.bbWidth.toFixed(2)}% | price ${bbPos}
ATR(14): $${coin.indicators.atr14.toFixed(dp)} (1-bar expected range)
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}%
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}%
24h range: $${coin.low24h.toFixed(dp)}–$${coin.high24h.toFixed(dp)}
${intraWindowBlock(coin.indicators)}
${multiTfBlock}
TOP-3 VOLUME SPIKES (potential order-flow events):
${volSpikes}
${orderBookBlock}
RECENT 60 1-MIN CANDLES (oldest first, unix/open/high/low/close/volume):
${candleRows}

STATISTICAL MODEL BASELINE: $${basePred.predictedPrice.toFixed(dp)}, ${basePred.direction}, conf ${basePred.confidence}%

YOUR RECENT ACCURACY FOR ${coin.symbol} (your own calls only):
${feedbackStr}

YOUR WORST RECENT CALLS FOR ${coin.symbol} (biggest misses — diagnose and avoid repeating these mistakes):
${worstStr}
CALIBRATION: ${calibrationStr}

PRECISION REQUIREMENT:
${expectedMoveBlock}

Analysis steps:
1. Use the LIVE ORDER BOOK as your primary support/resistance map — walls are real levels, not inferred ones
2. Use the 5-min candles for 2-hour structure before zooming into 1-min detail
3. Use VWAP position: above = bullish continuation bias; below = bearish continuation bias
4. Check volume spikes for order-flow confirmation of directional moves
5. Use Bollinger Band position to assess compression or expansion
6. Use ATR to ground your target — a 15-min move should be within 1–3× ATR (see PRECISION REQUIREMENT)
7. Weigh the INTRA-WINDOW MOMENTUM regime: a CHOPPY / low efficiency-ratio window means price is sawing back and forth with little directional edge — lower confidence. A spike flag means the latest move may be a one-off blip — do not over-extrapolate it
8. Set confidence 0-100; reduce when signals conflict or when the window is choppy

Return ONLY valid JSON (no markdown):
{"predictedPrice": 0.0, "direction": "up", "confidence": 70}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: getAiThinkingBudget() },
      system:
        "You are an expert crypto technical analyst and quantitative trader. When a Kalshi binary target is shown, your primary job is to determine whether price will be above or below that strike at window close. Use multi-timeframe candle data, the live order book, technical indicators, VWAP, and your accuracy record as supporting evidence. Respond with ONLY valid JSON after your thinking — no markdown, no extra text.",
      messages: [{ role: "user", content: prompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("") || "";
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
    return null;
  }
}

export async function refineWithSelfConsistency(
  coin: CoinPrediction,
  basePred: Prediction,
  extra?: { candles5m?: Candle[]; orderBook?: OrderBook; kalshiTarget?: number | null; windowOpenPrice?: number | null; minutesElapsed?: number },
): Promise<{ predictedPrice: number; direction: "up" | "down" | "flat"; confidence: number } | null> {
  const samples = clamp(Math.max(selfConsistencySamples, getAiSelfConsistency()), 1, MAX_SELF_CONSISTENCY);
  if (samples <= 1) return refineSnappedPrediction(coin, basePred, extra);

  const results = (
    await Promise.all(
      Array.from({ length: samples }, () => refineSnappedPrediction(coin, basePred, extra)),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  const counts: Record<"up" | "down" | "flat", number> = { up: 0, down: 0, flat: 0 };
  for (const r of results) counts[r.direction]++;
  const ranked = (Object.keys(counts) as Array<"up" | "down" | "flat">).sort(
    (a, b) => counts[b] - counts[a],
  );
  const direction: "up" | "down" | "flat" =
    counts[ranked[0]] > counts[ranked[1]] ? ranked[0] : basePred.direction;
  const agreeing = results.filter((r) => r.direction === direction);
  if (agreeing.length === 0) {
    return {
      predictedPrice: median(results.map((r) => r.predictedPrice)),
      direction,
      confidence: clamp(Math.round(mean(results.map((r) => r.confidence)) * 0.5), 20, 92),
    };
  }
  const agreement = agreeing.length / results.length;
  const predictedPrice = median(agreeing.map((r) => r.predictedPrice));
  const meanConf = mean(agreeing.map((r) => r.confidence));
  const confidence = clamp(Math.round(meanConf * (0.5 + 0.5 * agreement)), 20, 92);

  return { predictedPrice, direction, confidence };
}

// ---------------------------------------------------------------------------
// Dedicated Kalshi BTC call
// ---------------------------------------------------------------------------

interface KalshiBtcCallResult {
  above: boolean;
  confidence: number;
  predictedPrice: number;
}

const kalshiBtcCallCache = new Map<string, KalshiBtcCallResult>();

export async function fetchKalshiBtcCall(
  kalshiTarget: number,
  eventTicker: string,
): Promise<KalshiBtcCallResult | null> {
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

    let parsed: { side: string; predictedPrice: number; confidence: number } | null = null;
    const jsonMatch = raw.match(/\{[^{}]*"side"[^{}]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }

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
    if (kalshiBtcCallCache.size > 5) {
      kalshiBtcCallCache.delete(kalshiBtcCallCache.keys().next().value!);
    }
    return result;
  } catch (err) {
    logger.error({ err }, "[fetchKalshiBtcCall] error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live direction — lightweight mid-window Claude re-check
// ---------------------------------------------------------------------------

export interface LiveDirectionResult {
  aboveKalshi: boolean | null;
  direction: "up" | "down" | "flat";
  confidence: number;
  at: string;
  cached: boolean;
}

export const liveDirectionCache = new Map<string, { result: LiveDirectionResult; at: number }>();
const LIVE_DIR_TTL = 2 * 60_000;
export const liveDirectionInFlight = new Set<string>();
export const liveDirectionLastAutoTrigger = new Map<string, number>();
export const LIVE_DIR_AUTO_COOLDOWN = 2 * 60_000;

export async function fetchLiveDirection(symbol: string, force = false): Promise<LiveDirectionResult | null> {
  const nowMs = Date.now();
  const entry = liveDirectionCache.get(symbol.toUpperCase());
  if (!force && entry && nowMs - entry.at < LIVE_DIR_TTL) {
    return { ...entry.result, cached: true };
  }

  const coin = CRYPTO_COINS.find((c) => c.symbol === symbol.toUpperCase());
  if (!coin) return null;

  try {
    const [candles, stats, tickerPrice, kalshiTargetFresh] = await Promise.all([
      getCandles(coin.product),
      getStats(coin.product),
      getTicker(coin.product).catch(() => 0),
      KALSHI_SERIES[coin.symbol] ? fetchKalshiTarget(coin.symbol).catch(() => null) : Promise.resolve(null),
    ]);
    let kalshiTargetVal = kalshiTargetFresh;
    if (kalshiTargetVal == null && KALSHI_SERIES[coin.symbol]) {
      const stale = kalshiTargetCache.get(coin.symbol.toUpperCase());
      if (stale?.value != null) {
        const ct = stale.closeTime;
        if (!ct || new Date(ct).getTime() > Date.now()) kalshiTargetVal = stale.value;
      }
    }

    const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
    const analysis = analyzeCoin(coin, candles, stats, new Date(), livePrice);
    const price = livePrice ?? analysis.price;
    const dp = price >= 100 ? 2 : price >= 1 ? 4 : 6;
    const ind = analysis.indicators;

    const recent10 = candles.slice(-10);
    const closesStr = recent10.map((c) => `$${c.c.toFixed(dp)}`).join(" → ");
    const topVol = [...recent10].sort((a, b) => b.v - a.v)[0];
    const regime =
      ind.efficiencyRatio >= 0.4 ? "trending" : ind.efficiencyRatio >= 0.15 ? "drifting" : "choppy";

    const winCtx = getKalshiWindowContext(coin.symbol);
    let trajectoryNote = "";
    if (kalshiTargetVal && winCtx?.priceAtOpen && winCtx.minutesElapsed != null) {
      const openGapPct = ((winCtx.priceAtOpen - kalshiTargetVal) / kalshiTargetVal * 100).toFixed(3);
      const openSide = winCtx.priceAtOpen >= kalshiTargetVal ? "ABOVE" : "BELOW";
      trajectoryNote = `Window opened ${winCtx.minutesElapsed}min ago at $${winCtx.priceAtOpen.toFixed(dp)} (${Math.abs(Number(openGapPct))}% ${openSide} strike).`;
    }

    let prompt: string;
    if (kalshiTargetVal) {
      const side = price >= kalshiTargetVal ? "ABOVE" : "BELOW";
      const gapPct = (Math.abs(price - kalshiTargetVal) / kalshiTargetVal * 100).toFixed(3);
      prompt = `${coin.symbol} live check — Kalshi strike $${kalshiTargetVal.toFixed(dp)} (this window's opening price).
${trajectoryNote}
Now: $${price.toFixed(dp)} — ${gapPct}% ${side} strike.
RSI ${ind.rsi.toFixed(0)} | MACD ${ind.macd >= 0 ? "bull" : "bear"} | BB%B ${ind.bbPctB.toFixed(0)} | trend ${ind.trend} (strength ${Math.round(ind.trendStrength * 100)}%) | ER ${ind.efficiencyRatio.toFixed(2)} (${regime})
Recent 10 closes: ${closesStr}
Largest candle vol: $${topVol?.c.toFixed(dp)} (${topVol?.v.toFixed(0)} volume)
Oscillations last 15 candles: ${ind.oscillationCount} | Net drift: ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%

Will ${coin.symbol} close ABOVE or BELOW $${kalshiTargetVal.toFixed(dp)} at window close?
JSON only: {"above":true,"confidence":70}`;
    } else {
      prompt = `${coin.symbol} at $${price.toFixed(dp)}.
RSI ${ind.rsi.toFixed(0)} | MACD ${ind.macd >= 0 ? "bull" : "bear"} | trend ${ind.trend} | ER ${ind.efficiencyRatio.toFixed(2)} (${regime})
Recent 10 closes: ${closesStr}
Net drift: ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%

Will price be higher (up) or lower (down) in the next 15 min?
JSON only: {"direction":"up","confidence":65}`;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 40,
      system:
        "Return ONLY valid compact JSON. For Kalshi questions: {\"above\":true,\"confidence\":70}. For direction questions: {\"direction\":\"up\",\"confidence\":65}. No markdown, no prose.",
      messages: [{ role: "user", content: prompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    const parsed = JSON.parse(raw) as { above?: boolean; direction?: string; confidence?: number };

    const confidence = Math.min(90, Math.max(20, parsed.confidence ?? 60));
    let aboveKalshi: boolean | null = null;
    let direction: "up" | "down" | "flat" = "flat";

    if (kalshiTargetVal) {
      aboveKalshi = parsed.above ?? null;
      direction = aboveKalshi === null ? "flat" : aboveKalshi ? "up" : "down";
    } else {
      direction = (["up", "down", "flat"].includes(parsed.direction ?? "") ? parsed.direction : "flat") as "up" | "down" | "flat";
    }

    const result: LiveDirectionResult = { aboveKalshi, direction, confidence, at: new Date().toISOString(), cached: false };
    liveDirectionCache.set(symbol.toUpperCase(), { result, at: nowMs });
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trend Stability — bot window-open cross-coin analysis
// ---------------------------------------------------------------------------

export type TrendStability = "clean" | "choppy" | "reversing";

export interface TrendStabilityResult {
  aboveKalshi: boolean | null;
  direction: "up" | "down" | "flat";
  confidence: number;
  trendStability: TrendStability;
  reasoning: string;
  at: string;
  windowKey: string;
}

const trendStabilityCache = new Map<string, TrendStabilityResult>();

export async function fetchTrendStabilityForBot(
  symbol: string,
  windowKey: string,
): Promise<TrendStabilityResult | null> {
  const sym = symbol.toUpperCase();
  const cacheKey = `${sym}:${windowKey}`;
  const cached = trendStabilityCache.get(cacheKey);
  if (cached) return cached;

  const coin = CRYPTO_COINS.find((c) => c.symbol === sym);
  if (!coin) return null;

  try {
    const [candles, stats, tickerPrice, kalshiTargetFresh] = await Promise.all([
      getCandles(coin.product),
      getStats(coin.product),
      getTicker(coin.product).catch(() => 0),
      KALSHI_SERIES[coin.symbol]
        ? fetchKalshiTarget(coin.symbol).catch(() => null)
        : Promise.resolve(null),
    ]);

    let kalshiTargetVal = kalshiTargetFresh;
    if (kalshiTargetVal == null && KALSHI_SERIES[coin.symbol]) {
      const stale = kalshiTargetCache.get(sym);
      if (stale?.value != null) {
        const ct = stale.closeTime;
        if (!ct || new Date(ct).getTime() > Date.now()) kalshiTargetVal = stale.value;
      }
    }

    const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
    const analysis = analyzeCoin(coin, candles, stats, new Date(), livePrice);
    const price = livePrice ?? analysis.price;
    const dp = price >= 100 ? 2 : price >= 1 ? 4 : 6;
    const ind = analysis.indicators;

    const yesPrice = kalshiTargetCache.get(sym)?.yesPrice ?? null;

    const statRecords = historyStore.get(sym) ?? [];
    const statCall = computeStatWindowCall(statRecords, Date.now());
    const statDir = statCall?.aboveKalshi != null
      ? (statCall.aboveKalshi ? "above" : "below")
      : "unknown";

    let mlDir = "unknown";
    let mlConf: number | null = null;
    const mlStatus = getMLStatus(sym);
    if (mlStatus.ready && kalshiTargetVal) {
      try {
        const winCtx = getKalshiWindowContext(sym);
        const priceAtOpen = winCtx?.priceAtOpen ?? null;
        const windowStartMs = new Date(windowKey + ":00Z").getTime();
        const elapsed = Math.min(
          !isNaN(windowStartMs) ? (Date.now() - windowStartMs) / (15 * 60_000) : 0,
          1,
        );
        const mlFeatures = extractMLFeatures(analysis, kalshiTargetVal, elapsed, priceAtOpen);
        const mlResult = getMLPrediction(sym, mlFeatures);
        if (mlResult.prediction?.above != null) {
          mlDir = mlResult.prediction.above ? "above" : "below";
          mlConf = mlResult.prediction.confidence ?? 50;
          lastMLAboveCache.set(sym, mlResult.prediction.above);
        }
      } catch {
        // ML unavailable — proceed without it
      }
    }

    const last15 = candles.slice(-15);
    const closesStr = last15.map((c) => `$${c.c.toFixed(dp)}`).join(" → ");
    const regime =
      ind.efficiencyRatio >= 0.4 ? "trending" : ind.efficiencyRatio >= 0.15 ? "drifting" : "choppy";

    let prompt: string;
    if (kalshiTargetVal) {
      const side = price >= kalshiTargetVal ? "ABOVE" : "BELOW";
      const gapPct = (Math.abs(price - kalshiTargetVal) / kalshiTargetVal * 100).toFixed(3);
      const yesPriceStr = yesPrice != null ? `${Math.round(yesPrice * 100)}¢` : "n/a";
      const mlStr = mlConf != null
        ? `ML: ${mlDir} (${mlConf.toFixed(0)}% conf)`
        : `ML: ${mlDir}`;
      prompt = `${sym} window-open trend analysis — Kalshi strike $${kalshiTargetVal.toFixed(dp)}.
Now: $${price.toFixed(dp)} — ${gapPct}% ${side} strike. Yes price: ${yesPriceStr}.
Stat model: ${statDir} | ${mlStr}
ER ${ind.efficiencyRatio.toFixed(2)} (${regime}) | RSI ${ind.rsi.toFixed(0)} | oscillations ${ind.oscillationCount} | net drift ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%
Last 15 one-minute closes (oldest→newest): ${closesStr}

Classify trend stability from the 15 closes:
  "clean"     = steady directional momentum, low noise
  "choppy"    = oscillating without clear direction
  "reversing" = clear reversal of prior trend in the most recent candles

Will ${sym} close ABOVE or BELOW $${kalshiTargetVal.toFixed(dp)} at window close?
JSON only: {"above":true,"confidence":70,"stability":"clean","reasoning":"momentum up"}`;
    } else {
      const mlStr = mlConf != null
        ? `ML: ${mlDir} (${mlConf.toFixed(0)}% conf)`
        : `ML: ${mlDir}`;
      prompt = `${sym} window-open trend analysis.
Now: $${price.toFixed(dp)}
Stat model: ${statDir} | ${mlStr}
ER ${ind.efficiencyRatio.toFixed(2)} (${regime}) | RSI ${ind.rsi.toFixed(0)} | oscillations ${ind.oscillationCount} | net drift ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%
Last 15 one-minute closes (oldest→newest): ${closesStr}

Classify trend stability from the 15 closes:
  "clean"     = steady directional momentum, low noise
  "choppy"    = oscillating without clear direction
  "reversing" = clear reversal of prior trend in the most recent candles

Will price be higher (up) or lower (down) in 15 min?
JSON only: {"direction":"up","confidence":65,"stability":"choppy","reasoning":"noisy oscillation"}`;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 80,
      system:
        "Return ONLY valid compact JSON. Kalshi format: {\"above\":true,\"confidence\":70,\"stability\":\"clean\",\"reasoning\":\"momentum up\"}. Direction format: {\"direction\":\"up\",\"confidence\":65,\"stability\":\"choppy\",\"reasoning\":\"noisy\"}. stability: clean|choppy|reversing. reasoning: 2-4 words. No markdown, no prose.",
      messages: [{ role: "user", content: prompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    const parsed = JSON.parse(raw) as {
      above?: boolean;
      direction?: string;
      confidence?: number;
      stability?: string;
      reasoning?: string;
    };

    const confidence = Math.min(90, Math.max(20, parsed.confidence ?? 60));
    const validStabilities: TrendStability[] = ["clean", "choppy", "reversing"];
    const trendStability: TrendStability = validStabilities.includes(parsed.stability as TrendStability)
      ? (parsed.stability as TrendStability)
      : "choppy";
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

    let aboveKalshi: boolean | null = null;
    let direction: "up" | "down" | "flat" = "flat";
    if (kalshiTargetVal) {
      aboveKalshi = parsed.above ?? null;
      direction = aboveKalshi === null ? "flat" : aboveKalshi ? "up" : "down";
    } else {
      direction = (["up", "down", "flat"].includes(parsed.direction ?? "")
        ? parsed.direction
        : "flat") as "up" | "down" | "flat";
    }

    const result: TrendStabilityResult = {
      aboveKalshi,
      direction,
      confidence,
      trendStability,
      reasoning,
      at: new Date().toISOString(),
      windowKey,
    };
    trendStabilityCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}
