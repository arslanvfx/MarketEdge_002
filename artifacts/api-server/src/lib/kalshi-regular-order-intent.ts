// ---------------------------------------------------------------------------
// kalshi-regular-order-intent.ts — Durable intent + atomic reservation for the
// REGULAR Kalshi bot's live entry path.
//
// Purpose (Task #667, requirements #3 and #4):
//   • Persist a durable order intent BEFORE the live POST, keyed by
//     client_order_id plus symbol/ticker/window/side/mode/requested-count/limit.
//   • Atomically CLAIM a per-(mode,symbol,window) reservation before the live
//     POST so parallel symbol ticks cannot double-enter or exceed a shared cap.
//   • If the POST times out or returns an invalid/uncertain body, RETAIN the
//     unresolved reservation and BLOCK another entry for that symbol across later
//     windows until reconciliation confirms the intent filled or dead.
//   • Release the reservation ONLY on a confirmed dead / zero-fill outcome.
//     A confirmed fill remains blocking for that symbol/window across restarts.
//
// ISOLATION: this module owns its OWN table (kalshi_regular_order_intents) and
// NEVER touches scalp tables (kalshi_scalp_*) or the regular bot's bet tables
// (kalshi_bot_bets, bot_config). It does not import the scalper execution
// lifecycle. Paper mode never creates rows here — paper behavior stays isolated.
// ---------------------------------------------------------------------------

import { pool } from "@workspace/db";
import { logger } from "./logger.ts";

export type RegularIntentStatus =
  | "reserved"    // intent persisted + reserved, POST not yet attempted / in flight
  | "filled"      // confirmed fill — resolved, but blocks another entry in that window
  | "zero_fill"   // confirmed dead / zero fill — reservation released
  | "unknown"     // POST outcome indeterminate — reservation RETAINED (blocks window)
  | "skipped";    // never submitted (pre-POST abort) — reservation released

export interface RegularOrderIntentKey {
  clientOrderId: string;
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  requestedCount: number;
  limitPrice: number | null;
  /** Shared live-order cap for this mode/window. Enforced atomically under the
   * same advisory lock as the per-symbol duplicate reservation. */
  maxOrdersPerWindow?: number;
}

export interface ClaimIntentResult {
  claimed: boolean;   // false only when a live intent for (mode,symbol,window) already exists
  reason: string | null;
}

export interface RegularExitIntentKey {
  clientOrderId: string;
  mode: "live";
  positionId: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  requestedCount: number;
}

let _migrated = false;
let _migrationPromise: Promise<void> | null = null;

/**
 * Idempotently create the isolated intent table. Safe to call repeatedly.
 * UNIQUE(mode, symbol, window_key) enforces the atomic one-attempt claim: an
 * active (reserved/unknown/filled) row blocks a second entry for that key.
 */
export async function runRegularOrderIntentMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_regular_order_intents (
        client_order_id  TEXT PRIMARY KEY,
        mode             TEXT NOT NULL,
        symbol           TEXT NOT NULL,
        window_key       TEXT NOT NULL,
        ticker           TEXT NOT NULL,
        side             TEXT NOT NULL,
        requested_count  INTEGER NOT NULL,
        limit_price      NUMERIC(8,4),
        status           TEXT NOT NULL DEFAULT 'reserved',
        reason           TEXT,
        filled_count     INTEGER,
        avg_fill_price   NUMERIC(8,4),
        order_id         TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at      TIMESTAMPTZ
      )
    `);
    // Upgrade the old predicate once. Avoid dropping/recreating this index on
    // every restart because another running instance may still be claiming.
    const activeIndex = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'uq_regular_intent_active'`,
    );
    const activeIndexDef = String(activeIndex.rows[0]?.indexdef ?? "");
    if (!activeIndexDef.includes("filled")) {
      await client.query(`DROP INDEX IF EXISTS uq_regular_intent_active`);
      await client.query(`
        CREATE UNIQUE INDEX uq_regular_intent_active
          ON kalshi_regular_order_intents (mode, symbol, window_key)
          WHERE status IN ('reserved', 'unknown', 'filled')
      `);
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS regular_intent_mode_window
        ON kalshi_regular_order_intents (mode, window_key)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_regular_exit_intents (
        client_order_id  TEXT PRIMARY KEY,
        mode             TEXT NOT NULL,
        position_id      TEXT NOT NULL,
        symbol           TEXT NOT NULL,
        window_key       TEXT NOT NULL,
        ticker           TEXT NOT NULL,
        side             TEXT NOT NULL,
        requested_count  INTEGER NOT NULL,
        status           TEXT NOT NULL DEFAULT 'reserved',
        reason           TEXT,
        filled_count     INTEGER,
        avg_fill_price   NUMERIC(8,4),
        order_id         TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at      TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_regular_exit_intent_active
        ON kalshi_regular_exit_intents (mode, position_id)
        WHERE status IN ('reserved', 'unknown', 'filled')
    `);
    _migrated = true;
    logger.info("[kalshi-regular-intent] DB migration complete");
  } finally {
    client.release();
  }
}

async function ensureMigrated(): Promise<void> {
  if (_migrated) return;
  if (!_migrationPromise) {
    _migrationPromise = runRegularOrderIntentMigrations().catch((err) => {
      _migrationPromise = null;
      throw err;
    });
  }
  await _migrationPromise;
}

const advisoryKey = (mode: string): string => `kalshi-regular-order-cap:${mode}`;

/**
 * ATOMIC claim-and-persist. Runs in one transaction under a per-mode advisory
 * lock so no two parallel symbol ticks can race the reservation. Persists the
 * full intent BEFORE the live POST. Returns claimed=false when an active intent
 * for (mode,symbol,window) already exists (duplicate / in-flight / filled).
 *
 * Live mode ONLY — the caller must not call this for paper entries.
 */
export async function claimRegularOrderIntent(
  key: RegularOrderIntentKey,
): Promise<ClaimIntentResult> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [advisoryKey(key.mode)]);

    const maxOrders = key.maxOrdersPerWindow;
    if (Number.isInteger(maxOrders) && (maxOrders ?? 0) > 0) {
      const activeCount = await client.query(
        `SELECT COUNT(*)::int AS cnt
         FROM kalshi_regular_order_intents
         WHERE mode = $1 AND window_key = $2
           AND status IN ('reserved','unknown','filled')`,
        [key.mode, key.windowKey],
      );
      if (Number(activeCount.rows[0]?.cnt ?? 0) >= (maxOrders as number)) {
        await client.query("COMMIT");
        return { claimed: false, reason: "window_order_cap_reached" };
      }
    }

    // Unknown/reserved exposure blocks this symbol across later windows. A
    // confirmed fill blocks only its own window.
    const existing = await client.query(
      `SELECT client_order_id FROM kalshi_regular_order_intents
       WHERE mode = $1 AND symbol = $2
         AND (
           status IN ('reserved','unknown')
           OR (window_key = $3 AND status = 'filled')
         )
       LIMIT 1`,
      [key.mode, key.symbol.toUpperCase(), key.windowKey],
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return { claimed: false, reason: "unresolved_intent_exists" };
    }

    await client.query(
      `INSERT INTO kalshi_regular_order_intents
         (client_order_id, mode, symbol, window_key, ticker, side,
          requested_count, limit_price, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',NOW())`,
      [
        key.clientOrderId, key.mode, key.symbol.toUpperCase(), key.windowKey,
        key.ticker, key.side, key.requestedCount, key.limitPrice,
      ],
    );
    await client.query("COMMIT");
    return { claimed: true, reason: null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve an intent to a DEFINITE outcome (filled / zero_fill / skipped) and
 * release its reservation. NEVER use this for an indeterminate outcome.
 */
export async function resolveRegularOrderIntent(params: {
  clientOrderId: string;
  status: "filled" | "zero_fill" | "skipped";
  reason?: string | null;
  filledCount?: number | null;
  avgFillPrice?: number | null;
  orderId?: string | null;
}): Promise<void> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_regular_order_intents
       SET status = $1, reason = $2, filled_count = $3, avg_fill_price = $4,
           order_id = COALESCE($5, order_id), resolved_at = NOW()
       WHERE client_order_id = $6`,
      [
        params.status, params.reason ?? null, params.filledCount ?? null,
        params.avgFillPrice ?? null, params.orderId ?? null, params.clientOrderId,
      ],
    );
  } finally {
    client.release();
  }
}

/**
 * Mark an intent UNKNOWN (indeterminate live exposure). The reservation is
 * RETAINED (status='unknown' still matches the active unique index), so another
 * entry for that (mode,symbol,window) is blocked until manual/automatic
 * reconciliation confirms filled or dead. Never releases budget/reservation.
 */
export async function markRegularOrderIntentUnknown(params: {
  clientOrderId: string;
  reason: string;
}): Promise<void> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_regular_order_intents
       SET status = 'unknown', reason = $1
       WHERE client_order_id = $2`,
      [params.reason, params.clientOrderId],
    );
  } finally {
    client.release();
  }
}

/**
 * True when an unresolved (reserved/unknown) LIVE intent already exists for this
 * (symbol,window). Used as a fast pre-check to block a fresh entry attempt.
 */
export async function hasUnresolvedRegularIntent(
  mode: "paper" | "live",
  symbol: string,
  windowKey: string,
): Promise<boolean> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM kalshi_regular_order_intents
       WHERE mode = $1 AND symbol = $2 AND window_key = $3
         AND status IN ('reserved','unknown')
       LIMIT 1`,
      [mode, symbol.toUpperCase(), windowKey],
    );
    return res.rows.length > 0;
  } finally {
    client.release();
  }
}

/** Count live intents that are still indeterminate (require reconciliation). */
export async function countUnresolvedRegularIntents(): Promise<number> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM kalshi_regular_order_intents
       WHERE mode = 'live' AND status = 'unknown'`,
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } finally {
    client.release();
  }
}

/** Persist and atomically claim one live close submission for a position. */
export async function claimRegularExitIntent(
  key: RegularExitIntentKey,
): Promise<ClaimIntentResult> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [advisoryKey(key.mode)]);
    const existing = await client.query(
      `SELECT client_order_id
       FROM kalshi_regular_exit_intents
       WHERE mode = $1 AND position_id = $2
         AND status IN ('reserved','unknown','filled')
       LIMIT 1`,
      [key.mode, key.positionId],
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return { claimed: false, reason: "active_exit_intent_exists" };
    }
    await client.query(
      `INSERT INTO kalshi_regular_exit_intents
         (client_order_id, mode, position_id, symbol, window_key, ticker, side,
          requested_count, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',NOW())`,
      [
        key.clientOrderId,
        key.mode,
        key.positionId,
        key.symbol.toUpperCase(),
        key.windowKey,
        key.ticker,
        key.side,
        key.requestedCount,
      ],
    );
    await client.query("COMMIT");
    return { claimed: true, reason: null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function resolveRegularExitIntent(params: {
  clientOrderId: string;
  status: "filled" | "zero_fill" | "skipped";
  reason?: string | null;
  filledCount?: number | null;
  avgFillPrice?: number | null;
  orderId?: string | null;
}): Promise<void> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_regular_exit_intents
       SET status = $1, reason = $2, filled_count = $3, avg_fill_price = $4,
           order_id = COALESCE($5, order_id), resolved_at = NOW()
       WHERE client_order_id = $6`,
      [
        params.status,
        params.reason ?? null,
        params.filledCount ?? null,
        params.avgFillPrice ?? null,
        params.orderId ?? null,
        params.clientOrderId,
      ],
    );
  } finally {
    client.release();
  }
}

export async function markRegularExitIntentUnknown(params: {
  clientOrderId: string;
  reason: string;
}): Promise<void> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_regular_exit_intents
       SET status = 'unknown', reason = $1, resolved_at = NULL
       WHERE client_order_id = $2`,
      [params.reason, params.clientOrderId],
    );
  } finally {
    client.release();
  }
}
