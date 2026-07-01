// AI signal layer: combines a self-contained statistical model, a Claude
// analysis (price action + news + earnings context), and the stock ML instance
// into one directional call per ticker. Isolated from the crypto predictor.

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../logger";
import {
  rsi,
  bollinger,
  atrPct,
  efficiencyRatio,
  netDriftPct,
  volumeDirectionBias,
  candleReversal,
} from "./indicators";
import { buildFeatures, predictStock } from "./ml";
import { aggregateSentiment } from "./news";
import type {
  Candle,
  ClaudeSignal,
  Direction,
  EarningsInfo,
  MlSignal,
  NewsItem,
  StatSignal,
  StockSignals,
} from "./types";

const MODEL = "claude-sonnet-4-6";
const CLAUDE_TTL_MS = 5 * 60 * 1000;
const claudeCache = new Map<string, { sig: ClaudeSignal; at: number }>();

/** Pure statistical directional call from candles. */
export function statSignal(candles: Candle[]): StatSignal {
  const closes = candles.map((c) => c.c);
  const rsiVal = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const atr = atrPct(candles, 14);
  const er = efficiencyRatio(closes, 14);
  const drift = netDriftPct(closes, 14);
  const volBias = volumeDirectionBias(candles, 8);
  const pattern = candleReversal(candles);

  // Weighted vote: drift + volume + RSI extremes + BB position + pattern.
  let score = 0;
  score += Math.max(-1.5, Math.min(1.5, drift / 2)) * 1.2; // momentum
  score += volBias * 0.8;
  if (rsiVal > 70) score -= 0.6;
  else if (rsiVal < 30) score += 0.6;
  else score += ((rsiVal - 50) / 50) * 0.4;
  score += (bb.position - 0.5) * 0.6;
  if (pattern === "hammer" || pattern === "bullish_engulfing") score += 0.7;
  if (pattern === "shooting_star" || pattern === "bearish_engulfing") score -= 0.7;

  const direction: Direction = score >= 0 ? "up" : "down";
  // Efficiency ratio scales conviction — clean trends earn higher confidence.
  const magnitude = Math.min(1, Math.abs(score) / 2.5);
  const rawConf = 50 + magnitude * 40 * (0.5 + 0.5 * er);
  const confidence = Math.round(Math.max(50, Math.min(90, rawConf)));

  const reasoning =
    `Drift ${drift.toFixed(2)}%, RSI ${rsiVal.toFixed(0)}, ` +
    `vol bias ${(volBias * 100).toFixed(0)}%, ER ${er.toFixed(2)}` +
    (pattern !== "none" ? `, ${pattern.replace("_", " ")}` : "");

  return {
    direction,
    confidence,
    rsi: rsiVal,
    atrPct: atr,
    efficiencyRatio: er,
    netDriftPct: drift,
    volumeBias: volBias,
    bbPosition: bb.position,
    reasoning,
  };
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Claude directional call incorporating price action, news, and earnings. */
export async function claudeSignal(
  ticker: string,
  candles: Candle[],
  news: NewsItem[],
  earnings: EarningsInfo | undefined,
  stat: StatSignal,
): Promise<ClaudeSignal> {
  const T = ticker.toUpperCase();
  const cached = claudeCache.get(T);
  if (cached && Date.now() - cached.at < CLAUDE_TTL_MS) {
    return { ...cached.sig, cached: true };
  }

  const last = candles[candles.length - 1]?.c ?? 0;
  const recent = candles.slice(-12).map((c) => c.c.toFixed(2)).join(", ");
  const newsLines = news
    .slice(0, 3)
    .map((n) => `- "${n.headline}" (${n.sentiment ?? "neutral"}, mag ${n.magnitude ?? 1})`)
    .join("\n") || "- (no recent news)";
  const earningsLine = earnings
    ? `Next earnings: ${earnings.date} (${earnings.hoursUntil.toFixed(0)}h away)${earnings.soon ? " — WITHIN BLACKOUT" : ""}`
    : "Next earnings: unknown";

  const prompt = `You are a disciplined intraday/swing equity trader. Judge the most likely SHORT-TERM price direction for ${T}.

Current price: $${last.toFixed(2)}
Recent closes (oldest→newest): ${recent}
Statistical read: ${stat.direction.toUpperCase()} @ ${stat.confidence}% — ${stat.reasoning}
${earningsLine}
Recent news:
${newsLines}

Weigh momentum, mean-reversion risk (RSI ${stat.rsi.toFixed(0)}), and news. Be skeptical; avoid overconfidence in choppy tape.

Respond with ONLY JSON:
{"direction":"up"|"down","confidence":50-95,"reasoning":"one short sentence"}
No prose, no markdown fences.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(stripJsonFences(text)) as {
      direction: Direction;
      confidence: number;
      reasoning: string;
    };
    const sig: ClaudeSignal = {
      direction: parsed.direction === "down" ? "down" : "up",
      confidence: Math.max(50, Math.min(95, Math.round(parsed.confidence ?? 50))),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      cached: false,
    };
    claudeCache.set(T, { sig, at: Date.now() });
    return sig;
  } catch (err) {
    logger.warn({ err, ticker: T }, "[stock-ai] claude signal failed (non-fatal)");
    return { direction: stat.direction, confidence: 50, reasoning: "Claude unavailable — using statistical read.", cached: false };
  }
}

/**
 * Full signal bundle for a ticker: stat + optional Claude + ML, combined into a
 * single directional call with a blended confidence.
 */
export async function buildSignals(
  ticker: string,
  candles: Candle[],
  news: NewsItem[],
  earnings: EarningsInfo | undefined,
  sectorMomentum: number,
  opts: { useClaude: boolean } = { useClaude: true },
): Promise<StockSignals> {
  const last = candles[candles.length - 1]?.c ?? 0;
  const prevClose = candles.length > 1 ? candles[candles.length - 2].c : last;
  const changePct = prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : 0;

  const stat = statSignal(candles);

  const features = buildFeatures(candles, news, earnings, sectorMomentum);
  const ml: MlSignal = predictStock(ticker, features);

  let claude: ClaudeSignal | undefined;
  if (opts.useClaude) {
    claude = await claudeSignal(ticker, candles, news, earnings, stat);
  }

  // Blend: stat is the base; Claude and (ready) ML shift the vote.
  const votes: { dir: Direction; weight: number }[] = [
    { dir: stat.direction, weight: stat.confidence / 100 },
  ];
  if (claude) votes.push({ dir: claude.direction, weight: (claude.confidence / 100) * 1.1 });
  if (ml.ready) votes.push({ dir: ml.direction, weight: (ml.confidence / 100) * 1.0 });

  let up = 0;
  let down = 0;
  for (const v of votes) {
    if (v.dir === "up") up += v.weight;
    else down += v.weight;
  }
  const combinedDirection: Direction = up >= down ? "up" : "down";
  const total = up + down;
  const agreement = total > 0 ? Math.max(up, down) / total : 0.5;
  let combinedConfidence = Math.round(50 + agreement * 45);

  // News tilt: strong sentiment against the call trims confidence.
  const agg = aggregateSentiment(news);
  if (agg.sentiment !== "neutral") {
    const newsDir: Direction = agg.score > 0 ? "up" : "down";
    if (newsDir === combinedDirection) combinedConfidence = Math.min(95, combinedConfidence + 3);
    else combinedConfidence = Math.max(50, combinedConfidence - 4);
  }

  return {
    ticker: ticker.toUpperCase(),
    price: last,
    changePct,
    stat,
    claude,
    ml,
    news,
    earnings,
    combinedDirection,
    combinedConfidence,
  };
}
