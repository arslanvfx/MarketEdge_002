/**
 * AI Spend Level controller.
 *
 * Controls which Claude/AI features are active globally.
 * Persists to the DB so the level survives server restarts.
 *
 * Crypto levels (eco/balanced/max) control ONLY crypto features.
 * Stock AI is a separate boolean flag controlled independently.
 *
 * Levels (crypto only):
 *   off      — Emergency kill switch: ALL crypto Claude calls disabled
 *   eco      — Snap + live direction + BTC call only (bot accuracy, minimum cost)
 *   balanced — All crypto features at standard thinking depth
 *   max      — All crypto features at max thinking depth + self-consistency
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

// Crypto-only features per spend level. Stock features are gated separately.
const CRYPTO_ENABLED: Record<AiSpendLevel, Set<AiFeature>> = {
  off: new Set(),
  // Eco: snap + live-dir + BTC call (bot accuracy, minimum thinking depth)
  eco: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_btc_call",
  ]),
  // Balanced: all crypto features at standard thinking depth
  balanced: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_stability",
    "crypto_btc_call",
    "market_summary",
  ]),
  // Max: all crypto features at maximum thinking depth
  max: new Set<AiFeature>([
    "crypto_snap",
    "crypto_live_dir",
    "crypto_stability",
    "crypto_btc_call",
    "market_summary",
  ]),
};

const STOCK_FEATURES = new Set<AiFeature>([
  "stock_signal",
  "stock_research",
  "stock_sentiment",
]);

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
let stockAiEnabled = true; // Stock AI on by default; persisted independently

export function getAiSpendLevel(): AiSpendLevel {
  return currentLevel;
}

export function getStockAiEnabled(): boolean {
  return stockAiEnabled;
}

export function setAiSpendLevel(level: AiSpendLevel): void {
  currentLevel = level;
  void persistAiSpend();
}

export function setStockAiEnabled(enabled: boolean): void {
  stockAiEnabled = enabled;
  void persistAiSpend();
}

async function persistAiSpend(): Promise<void> {
  await db
    .insert(botConfigTable)
    .values({ id: "ai_spend", config: { level: currentLevel, stockAiEnabled } as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botConfigTable.id,
      set: { config: { level: currentLevel, stockAiEnabled } as Record<string, unknown>, updatedAt: new Date() },
    })
    .catch((e: unknown) => { logger.error({ err: e }, "[ai-spend] persist error"); });
}

// Crypto features that are disabled in development to avoid unnecessary API costs.
const CRYPTO_FEATURES = new Set<AiFeature>([
  "crypto_snap",
  "crypto_live_dir",
  "crypto_stability",
  "crypto_btc_call",
  "market_summary",
]);

/** Returns true when the given Claude feature should run.
 *  - Stock features: gated by stockAiEnabled (independent of crypto level)
 *  - Crypto features: gated by spend level; always OFF in development */
export function isAiFeatureEnabled(feature: AiFeature): boolean {
  if (STOCK_FEATURES.has(feature)) {
    return stockAiEnabled;
  }
  if (process.env.NODE_ENV !== "production" && CRYPTO_FEATURES.has(feature)) {
    return false;
  }
  return CRYPTO_ENABLED[currentLevel].has(feature);
}

/** Human-readable description of each crypto level. */
export const AI_SPEND_LABELS: Record<AiSpendLevel, { name: string; description: string; costTag: string }> = {
  off:      { name: "Off",      description: "Emergency kill switch — all crypto Claude calls disabled",                         costTag: "Free"      },
  eco:      { name: "Eco",      description: "Snap + live direction + BTC call only (bot accuracy, 3K thinking depth)",          costTag: "~30% cost" },
  balanced: { name: "Balanced", description: "All crypto features at standard thinking depth (5K tokens)",                       costTag: "~60% cost" },
  max:      { name: "Max",      description: "All crypto features at max thinking depth (8K tokens) + 2× self-consistency",      costTag: "Full cost" },
};

/** Load persisted spend level and stock AI flag from DB (call once at server startup). */
export async function initAiSpend(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, "ai_spend"))
      .limit(1);
    if (rows.length > 0) {
      const cfg = rows[0].config as { level?: string; stockAiEnabled?: boolean } | null;
      const lvl = cfg?.level;
      if (lvl === "off" || lvl === "eco" || lvl === "balanced" || lvl === "max") {
        currentLevel = lvl;
        logger.info("[ai-spend] restored crypto spend level: %s", lvl);
      }
      if (typeof cfg?.stockAiEnabled === "boolean") {
        stockAiEnabled = cfg.stockAiEnabled;
        logger.info("[ai-spend] restored stock AI enabled: %s", stockAiEnabled);
      }
    }
  } catch (e) {
    logger.error({ err: e }, "[ai-spend] failed to load from DB");
  }
}
