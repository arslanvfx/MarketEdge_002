/**
 * AI Spend Level controller.
 *
 * Controls which Claude/AI features are active globally.
 * Persists to the DB so the level survives server restarts.
 *
 * Levels:
 *   off      — Emergency kill switch: ALL Claude calls disabled immediately
 *   eco      — Stat + ML only; no Claude anywhere (zero AI cost)
 *   balanced — Claude for bot-critical signals (snap + live direction) +
 *              stock signals/sentiment; skips trend stability, market
 *              summaries, and stock research
 *   max      — All features active (default)
 *
 * GUARANTEE: ML training, stat model, and ML inference are NEVER gated here.
 * Only external Claude/Anthropic API calls are controlled by this module.
 */

import { db, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export type AiSpendLevel = "off" | "eco" | "balanced" | "max";

export type AiFeature =
  | "crypto_snap"       // refineWithSelfConsistency in tracker snap loop
  | "crypto_live_dir"   // fetchLiveDirection periodic/initial trigger
  | "crypto_stability"  // fetchTrendStabilityForBot at window-open
  | "crypto_btc_call"   // fetchKalshiBtcCall API endpoint
  | "market_summary"    // analyzeChunk in ai-analysis.ts (Smart Picks market analysis)
  | "stock_signal"      // claudeSignal in stock/ai.ts
  | "stock_research"    // runResearchPass in stock/scanner.ts
  | "stock_sentiment";  // scoreSentiment in stock/news.ts

const ENABLED: Record<AiSpendLevel, Set<AiFeature>> = {
  off: new Set(),
  // Eco: core bot signals only at minimum thinking depth.
  // Skips: trend stability (overlaps with momentum filter), market summaries,
  // research briefs. Keeps snap + live-dir (bot accuracy) and stock signals.
  eco: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_btc_call",
    "stock_signal",
    "stock_sentiment",
  ]),
  // Balanced: all features ON at standard thinking depth.
  balanced: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_stability",
    "crypto_btc_call",
    "market_summary",
    "stock_signal",
    "stock_research",
    "stock_sentiment",
  ]),
  // Max: all features ON at maximum thinking depth with self-consistency sampling.
  max: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_stability",
    "crypto_btc_call",
    "market_summary",
    "stock_signal",
    "stock_research",
    "stock_sentiment",
  ]),
};

/** Extended thinking token budget per spend level. */
const THINKING_BUDGET: Record<AiSpendLevel, number> = {
  off:      0,
  eco:      3000,
  balanced: 5000,
  max:      8000,
};

/** Self-consistency samples for the refinement pass per spend level. */
const SELF_CONSISTENCY: Record<AiSpendLevel, number> = {
  off:      1,
  eco:      1,
  balanced: 1,
  max:      2,
};

/** Returns the extended thinking token budget for the current spend level. */
export function getAiThinkingBudget(): number {
  return THINKING_BUDGET[currentLevel];
}

/** Returns the self-consistency sample count for the current spend level. */
export function getAiSelfConsistency(): number {
  return SELF_CONSISTENCY[currentLevel];
}

let currentLevel: AiSpendLevel = "max";

export function getAiSpendLevel(): AiSpendLevel {
  return currentLevel;
}

export function setAiSpendLevel(level: AiSpendLevel): void {
  currentLevel = level;
  void db
    .insert(botConfigTable)
    .values({ id: "ai_spend", config: { level } as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botConfigTable.id,
      set: { config: { level } as Record<string, unknown>, updatedAt: new Date() },
    })
    .catch((e: unknown) => logger.error({ err: e }, "[ai-spend] persist error"));
}

// Crypto features that are disabled in development to avoid unnecessary API costs.
// Production (NODE_ENV=production) respects the configured spend level normally.
const CRYPTO_FEATURES = new Set<AiFeature>([
  "crypto_snap",
  "crypto_live_dir",
  "crypto_stability",
  "crypto_btc_call",
  "market_summary",
]);

/** Returns true when the given Claude feature should run at the current spend level.
 *  In development all crypto AI calls are always OFF — only stock features are
 *  available for local testing. Production respects the configured spend level. */
export function isAiFeatureEnabled(feature: AiFeature): boolean {
  if (process.env.NODE_ENV !== "production" && CRYPTO_FEATURES.has(feature)) {
    return false;
  }
  return ENABLED[currentLevel].has(feature);
}

/** Human-readable description of each level's cost impact. */
export const AI_SPEND_LABELS: Record<AiSpendLevel, { name: string; description: string; costTag: string }> = {
  off:      { name: "Off",      description: "Emergency kill switch — all AI disabled",                                    costTag: "Free"      },
  eco:      { name: "Eco",      description: "All accuracy-critical features, minimum thinking depth (3K tokens)",         costTag: "~50% cost" },
  balanced: { name: "Balanced", description: "All features, standard thinking depth (5K tokens) + research & summaries",  costTag: "~70% cost" },
  max:      { name: "Max",      description: "All features, deep thinking (8K tokens) + 2× self-consistency on each snap", costTag: "Full cost" },
};

/** Load persisted spend level from DB (call once at server startup). */
export async function initAiSpend(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, "ai_spend"))
      .limit(1);
    if (rows.length > 0) {
      const cfg = rows[0].config as { level?: string } | null;
      const lvl = cfg?.level;
      if (lvl === "off" || lvl === "eco" || lvl === "balanced" || lvl === "max") {
        currentLevel = lvl;
        logger.info("[ai-spend] restored spend level: %s", lvl);
      }
    }
  } catch (e) {
    logger.error({ err: e }, "[ai-spend] failed to load from DB");
  }
}
