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
  eco: new Set(),
  balanced: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_btc_call",
    "stock_signal",
    "stock_sentiment",
  ]),
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
    .catch((e: unknown) => console.error("[ai-spend] persist error:", e));
}

/** Returns true when the given Claude feature should run at the current spend level. */
export function isAiFeatureEnabled(feature: AiFeature): boolean {
  return ENABLED[currentLevel].has(feature);
}

/** Human-readable description of each level's cost impact. */
export const AI_SPEND_LABELS: Record<AiSpendLevel, { name: string; description: string; costTag: string }> = {
  off:      { name: "Off",      description: "Emergency kill switch — all AI disabled", costTag: "Free" },
  eco:      { name: "Eco",      description: "Stat + ML only, no Claude calls",         costTag: "Free" },
  balanced: { name: "Balanced", description: "Claude for bot signals + stock picks, no research or market summaries", costTag: "Low cost" },
  max:      { name: "Max",      description: "Full AI — all Claude features active",    costTag: "Full cost" },
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
        console.info(`[ai-spend] restored spend level: ${lvl}`);
      }
    }
  } catch (e) {
    console.error("[ai-spend] failed to load from DB:", e);
  }
}
