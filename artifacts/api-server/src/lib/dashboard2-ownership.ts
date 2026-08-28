import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import {
  isDashboard2ExecutionOwner,
  type Dashboard2ExecutionOwner,
} from "./dashboard2-ownership-contract.ts";
export {
  DASHBOARD2_OWNERS,
  isDashboard2ExecutionOwner,
  type Dashboard2ExecutionOwner,
} from "./dashboard2-ownership-contract.ts";

const ROW_ID = "dashboard2_execution_ownership";

export async function readDashboard2ExecutionOwner(): Promise<{
  owner: Dashboard2ExecutionOwner;
  updatedAt: string;
}> {
  const result = await pool.query<{ owner: string; updated_at: Date }>(
    `WITH inserted AS (
       INSERT INTO bot_config (id, config, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING config, updated_at
     )
     SELECT config->>'owner' AS owner, updated_at
       FROM inserted
     UNION ALL
     SELECT config->>'owner' AS owner, updated_at
       FROM bot_config
      WHERE id = $1
     LIMIT 1`,
    [ROW_ID, JSON.stringify({ owner: "current_bot" })],
  );
  const owner = result.rows[0]?.owner;
  if (!isDashboard2ExecutionOwner(owner)) {
    throw new Error("Dashboard 2.0 execution ownership is missing or invalid");
  }
  const updatedAt = result.rows[0]?.updated_at;
  if (!(updatedAt instanceof Date)) {
    throw new Error("Dashboard 2.0 execution ownership timestamp is unavailable");
  }
  return { owner, updatedAt: updatedAt.toISOString() };
}

export async function changeDashboard2ExecutionOwner(
  requestedOwner: Dashboard2ExecutionOwner,
  actorId: string,
): Promise<{ owner: Dashboard2ExecutionOwner; changed: boolean; updatedAt: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ROW_ID]);
    await client.query(
      `INSERT INTO bot_config (id, config, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [ROW_ID, JSON.stringify({ owner: "current_bot" })],
    );
    const currentResult = await client.query<{ owner: string }>(
      `SELECT config->>'owner' AS owner FROM bot_config WHERE id = $1 FOR UPDATE`,
      [ROW_ID],
    );
    const rawCurrent = currentResult.rows[0]?.owner ?? "current_bot";
    if (!isDashboard2ExecutionOwner(rawCurrent)) {
      throw new Error("Dashboard 2.0 execution ownership is invalid; refusing switch");
    }
    if (rawCurrent !== requestedOwner) {
      // Deliberately fail closed if either intent table/readiness is unavailable.
      const unresolved = await client.query<{ count: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM kalshi_regular_order_intents
             WHERE mode = 'live' AND status IN ('reserved','unknown')) +
           (SELECT COUNT(*) FROM kalshi_regular_exit_intents
             WHERE mode = 'live' AND status IN ('reserved','unknown'))
         )::text AS count`,
      );
      if (Number(unresolved.rows[0]?.count ?? 0) > 0) {
        await client.query("ROLLBACK");
        const error = new Error("Unresolved live intents make execution ownership switch unsafe");
        Object.assign(error, { code: "UNRESOLVED_LIVE_INTENTS" });
        throw error;
      }
      const write = await client.query<{ updated_at: Date }>(
        `INSERT INTO bot_config (id, config, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
         RETURNING updated_at`,
        [ROW_ID, JSON.stringify({ owner: requestedOwner, changedBy: actorId })],
      );
      const updatedAt = write.rows[0]?.updated_at;
      if (!(updatedAt instanceof Date)) throw new Error("Dashboard 2.0 ownership write was not confirmed");
      await client.query("COMMIT");
      logger.info(
        { previousOwner: rawCurrent, owner: requestedOwner, actorId },
        "[dashboard2] execution ownership updated",
      );
      return { owner: requestedOwner, changed: true, updatedAt: updatedAt.toISOString() };
    }
    await client.query("COMMIT");
    logger.info(
      { previousOwner: rawCurrent, owner: requestedOwner, actorId },
      "[dashboard2] execution ownership updated",
    );
    // An unchanged owner has no write; return the durable row timestamp.
    const existing = await client.query<{ updated_at: Date }>(
      `SELECT updated_at FROM bot_config WHERE id = $1`,
      [ROW_ID],
    );
    const updatedAt = existing.rows[0]?.updated_at;
    if (!(updatedAt instanceof Date)) throw new Error("Dashboard 2.0 ownership timestamp is unavailable");
    return { owner: requestedOwner, changed: false, updatedAt: updatedAt.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}