import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  batchProcess,
  isRateLimitError,
} from "@workspace/integrations-anthropic-ai/batch";
import type { Market } from "./markets";
import { isGlobalAIKill } from "./global-ai";

/**
 * AI analysis of a single market. We ask Claude for the TRUE probability that
 * the YES outcome occurs — independent of the current market price — so we can
 * later compute the edge (where the market disagrees with reality).
 *
 * trueProbabilityYes is cached per market id (it reflects real-world reasoning,
 * not live odds), while edge is always recomputed against fresh live odds.
 */
export interface MarketAnalysis {
  marketId: string;
  platform: string;
  trueProbabilityYes: number; // 0..1 — AI estimate that YES happens
  plausible: boolean; // false for nonsensical / unresolvable / joke markets
  confidence: "low" | "medium" | "high";
  reasoning: string; // one or two sentences, user-facing
}

interface CacheEntry {
  analysis: MarketAnalysis;
  fetchedAt: number;
}

const ANALYSIS_TTL_MS = 30 * 60 * 1000; // 30 min — real-world assessment is slow-moving
const cache = new Map<string, CacheEntry>();

const MODEL = "claude-sonnet-4-6";
const CHUNK_SIZE = 12; // markets analyzed per Claude call

function cacheKey(m: { platform: string; id: string }): string {
  return `${m.platform}:${m.id}`;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

interface RawAnalysis {
  index: number;
  trueProbabilityYes: number;
  plausible: boolean;
  confidence: "low" | "medium" | "high";
  reasoning: string;
}

function fallbackAnalyses(markets: Market[]): MarketAnalysis[] {
  return markets.map((m) => ({
    marketId: m.id,
    platform: m.platform,
    trueProbabilityYes: m.yesOdds,
    plausible: false,
    confidence: "low" as const,
    reasoning: "AI analysis unavailable for this market.",
  }));
}

async function analyzeChunk(markets: Market[]): Promise<MarketAnalysis[]> {
  if (isGlobalAIKill()) return fallbackAnalyses(markets);
  const today = new Date().toISOString().slice(0, 10);

  const marketLines = markets
    .map((m, i) => {
      const close = m.closeTime ? m.closeTime.slice(0, 10) : "unknown";
      // Always include yesSubtitle so Claude knows EXACTLY what outcome YES pays on.
      // Without it, Claude guesses from title alone and can confuse e.g. "Iraq" vs
      // "France" in a winner contract — leading to a completely wrong trueProbabilityYes.
      const yesMeaning = m.yesSubtitle ? ` [YES = "${m.yesSubtitle}"]` : "";
      // For same-game prop markets (corners, totals, spreads) the title alone doesn't
      // name the match. Include the gameKey so Claude can correctly assess and describe
      // which game this prop applies to (e.g. "10+ corners? [game: 26JUN27COLPOR]").
      const gameCtx = m.gameKey ? ` [game: ${m.gameKey}]` : "";
      return `${i}. "${m.title}"${yesMeaning}${gameCtx} | YES price: ${(m.yesOdds * 100).toFixed(0)}% | closes: ${close} | category: ${m.category ?? "n/a"}`;
    })
    .join("\n");

  const prompt = `You are a sharp, skeptical prediction-market analyst. Today's date is ${today}.

For each market, estimate the TRUE probability (0.0–1.0) that the YES outcome actually occurs, using real-world knowledge. Do NOT echo the market price — find where the crowd is WRONG.

Critical rules:
- IMPORTANT: Each market line has a "[YES = ...]" label — that is the EXACT outcome YES pays on. Estimate the probability of THAT specific outcome, not the opposite team or any other interpretation. Example: "France vs Iraq Winner?" [YES = "Iraq"] means YES pays only if Iraq wins — estimate Iraq's win probability (~0.04), NOT France's.
- NOVELTY / MEME MARKETS: Set "plausible": false for any market whose resolution is tied to a pop-culture milestone with an unknown or perpetually-delayed date — e.g. "before GTA VI", "before Half-Life 3", "before [any video game release]", "before [album release]", or any market that is clearly a joke or internet meme ("Will Jesus Christ return…", "Will aliens land…", "Will [celebrity] die…"). These may be real markets with real volume but they are unsuitable for serious value analysis. Mark plausible: false so they are excluded from picks.
- If a market is nonsensical, unresolvable, or you cannot reason about it, set "plausible": false.
- Consider the close date — a low-probability event has even less chance in a short window.
- confidence: "high" for well-understood events, "low" for genuinely uncertain ones. For game-specific props (totals, goal spread, both-teams-to-score, corners) — these are concrete events with a clear resolution window. Default to "medium" confidence when you can reason about the game; only use "low" if the match itself is highly unpredictable.
- reasoning: ONE sentence (max ~20 words), plain language, explaining your estimate. User-facing.

Markets:
${marketLines}

Respond with ONLY a JSON array, one object per market, in this exact shape:
[{"index": 0, "trueProbabilityYes": 0.03, "plausible": true, "confidence": "high", "reasoning": "..."}]
No prose, no markdown fences.`;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  const text = block && block.type === "text" ? block.text : "";
  let parsed: RawAnalysis[];
  try {
    parsed = JSON.parse(stripJsonFences(text));
    if (!Array.isArray(parsed)) throw new Error("not an array");
  } catch {
    // If parsing fails, treat the whole chunk as unanalyzable (excluded downstream)
    return fallbackAnalyses(markets);
  }

  const byIndex = new Map(parsed.map((p) => [p.index, p]));
  return markets.map((m, i) => {
    const p = byIndex.get(i);
    if (!p || typeof p.trueProbabilityYes !== "number") {
      return {
        marketId: m.id,
        platform: m.platform,
        trueProbabilityYes: m.yesOdds,
        plausible: false,
        confidence: "low" as const,
        reasoning: "AI analysis unavailable for this market.",
      };
    }
    const trueProb = Math.min(Math.max(p.trueProbabilityYes, 0.005), 0.995);
    return {
      marketId: m.id,
      platform: m.platform,
      trueProbabilityYes: trueProb,
      plausible: p.plausible !== false,
      confidence: p.confidence ?? "medium",
      reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
    };
  });
}

/**
 * Analyze a set of markets, returning a map keyed by `${platform}:${id}`.
 * Cached results (within TTL) are reused; only uncached markets hit Claude.
 */
export async function analyzeMarkets(
  markets: Market[],
): Promise<Map<string, MarketAnalysis>> {
  const result = new Map<string, MarketAnalysis>();
  const now = Date.now();
  const toAnalyze: Market[] = [];

  for (const m of markets) {
    const key = cacheKey(m);
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < ANALYSIS_TTL_MS) {
      result.set(key, cached.analysis);
    } else {
      toAnalyze.push(m);
    }
  }

  if (toAnalyze.length === 0) return result;

  // Chunk the markets, then process chunks with limited concurrency + retries.
  const chunks: Market[][] = [];
  for (let i = 0; i < toAnalyze.length; i += CHUNK_SIZE) {
    chunks.push(toAnalyze.slice(i, i + CHUNK_SIZE));
  }

  const chunkResults = await batchProcess(
    chunks,
    async (chunk) => {
      try {
        return await analyzeChunk(chunk);
      } catch (err) {
        // Let rate-limit errors propagate so batchProcess can retry them.
        // For any other failure, degrade this chunk gracefully (mark its
        // markets unanalyzable) instead of failing the whole request.
        if (isRateLimitError(err)) throw err;
        return fallbackAnalyses(chunk);
      }
    },
    { concurrency: 3, retries: 4 },
  );

  for (const analyses of chunkResults) {
    for (const a of analyses) {
      const key = `${a.platform}:${a.marketId}`;
      cache.set(key, { analysis: a, fetchedAt: now });
      result.set(key, a);
    }
  }

  return result;
}
