// Global AI intensity setting. Controls how much compute (budget_tokens,
// live-direction TTL, stock AI TTL) Claude calls consume across the whole app.
// Three tiers:
//   eco      — current default after cost-cutting (~$20/day)
//   balanced — middle ground (~$30/day)
//   max      — original pre-cost-cut settings (~$45/day)
// Persisted to bot_config under id='ai-intensity' so it survives restarts.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export type AIIntensityTier = "eco" | "balanced" | "max";

let tier: AIIntensityTier = "eco";

const CONFIGS: Record<
  AIIntensityTier,
  {
    snapBudgetTokens: number;
    displayBudgetTokens: number;
    liveDirTTLMs: number;
    liveDirPeriodicMs: number;
    stockAITTLMs: number;
    label: string;
    estDailyCost: string;
  }
> = {
  eco: {
    snapBudgetTokens: 3_000,
    displayBudgetTokens: 3_000,
    liveDirTTLMs: 10 * 60_000,
    liveDirPeriodicMs: 10 * 60_000,
    stockAITTLMs: 5 * 60_000,
    label: "Eco",
    estDailyCost: "~$20/day",
  },
  balanced: {
    snapBudgetTokens: 6_000,
    displayBudgetTokens: 6_000,
    liveDirTTLMs: 7 * 60_000,
    liveDirPeriodicMs: 7 * 60_000,
    stockAITTLMs: 5 * 60_000,
    label: "Balanced",
    estDailyCost: "~$30/day",
  },
  max: {
    snapBudgetTokens: 10_000,
    displayBudgetTokens: 6_000,
    liveDirTTLMs: 5 * 60_000,
    liveDirPeriodicMs: 5 * 60_000,
    stockAITTLMs: 3 * 60_000,
    label: "Max",
    estDailyCost: "~$45/day",
  },
};

export function getAIIntensity(): AIIntensityTier {
  return tier;
}

export function getSnapBudgetTokens(): number {
  return CONFIGS[tier].snapBudgetTokens;
}

export function getDisplayBudgetTokens(): number {
  return CONFIGS[tier].displayBudgetTokens;
}

export function getLiveDirTTLMs(): number {
  return CONFIGS[tier].liveDirTTLMs;
}

export function getLiveDirPeriodicMs(): number {
  return CONFIGS[tier].liveDirPeriodicMs;
}

export function getStockAITTLMs(): number {
  return CONFIGS[tier].stockAITTLMs;
}

export function getAIIntensityConfig() {
  return { tier, ...CONFIGS[tier] };
}

export async function saveAIIntensity(t: AIIntensityTier): Promise<void> {
  tier = t;
  try {
    await db.execute(sql`
      INSERT INTO bot_config (id, config, updated_at)
      VALUES (
        'ai-intensity',
        ${JSON.stringify({ tier: t })}::jsonb,
        NOW()
      )
      ON CONFLICT (id) DO UPDATE
        SET config     = EXCLUDED.config,
            updated_at = NOW()
    `);
  } catch (err) {
    logger.warn({ err }, "[ai-intensity] failed to persist tier (non-fatal)");
  }
}

export async function loadAIIntensityFromDB(): Promise<void> {
  try {
    const res = (await db.execute(sql`
      SELECT config FROM bot_config WHERE id = 'ai-intensity'
    `)) as unknown as { rows: { config: unknown }[] };
    const row = res.rows?.[0];
    if (row?.config) {
      const parsed =
        typeof row.config === "string"
          ? (JSON.parse(row.config) as { tier?: AIIntensityTier })
          : (row.config as { tier?: AIIntensityTier });
      if (parsed.tier && parsed.tier in CONFIGS) {
        tier = parsed.tier;
      }
      logger.info({ tier }, "[ai-intensity] tier loaded from DB");
    }
  } catch (err) {
    logger.warn({ err }, "[ai-intensity] failed to load tier from DB (non-fatal)");
  }
}
