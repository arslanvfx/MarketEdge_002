// Global emergency AI kill-switch. When true, EVERY anthropic.messages.create
// call across the entire app returns a graceful fallback without hitting the
// Anthropic API. Persisted to bot_config under id='global-ai-kill' so it
// survives server restarts.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

let kill = false;

export function isGlobalAIKill(): boolean {
  return kill;
}

export function setGlobalAIKillSync(v: boolean): void {
  kill = v;
}

export async function saveGlobalAIKill(v: boolean): Promise<void> {
  kill = v;
  try {
    await db.execute(sql`
      INSERT INTO bot_config (id, config, updated_at)
      VALUES (
        'global-ai-kill',
        ${JSON.stringify({ kill: v })}::jsonb,
        NOW()
      )
      ON CONFLICT (id) DO UPDATE
        SET config     = EXCLUDED.config,
            updated_at = NOW()
    `);
  } catch (err) {
    logger.warn({ err }, "[global-ai] failed to persist kill switch (non-fatal)");
  }
}

export async function loadGlobalAIKillFromDB(): Promise<void> {
  try {
    const res = (await db.execute(sql`
      SELECT config FROM bot_config WHERE id = 'global-ai-kill'
    `)) as unknown as { rows: { config: unknown }[] };
    const row = res.rows?.[0];
    if (row?.config) {
      const parsed =
        typeof row.config === "string"
          ? (JSON.parse(row.config) as { kill?: boolean })
          : (row.config as { kill?: boolean });
      kill = parsed.kill === true;
      logger.info({ kill }, "[global-ai] kill switch loaded from DB");
    }
  } catch (err) {
    logger.warn({ err }, "[global-ai] failed to load kill switch from DB (non-fatal)");
  }
}
