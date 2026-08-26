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
import { regularCountHundredths } from "./kalshi-regular-fixed-point.ts";

export type RegularIntentStatus =
  | "reserved"    // intent persisted + reserved, POST not yet attempted / in flight
  | "filled"      // confirmed fill — resolved, but blocks another entry in that window
  | "zero_fill"   // confirmed dead / zero fill — reservation released
  | "unknown"     // POST outcome indeterminate — reservation RETAINED (blocks window)
  | "skipped"     // never submitted (pre-POST abort) — reservation released
  | "operator_cleared"; // explicit operator override — audit retained, reservation released

export interface RegularOrderIntentKey {
  clientOrderId: string;
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  requestedCount: number;
  limitPrice: number | null;
  /** Worst-case dollars reserved for this submission at the exact limit. */
  requestedCost?: number;
  /** Shared live-order cap for this mode/window. Enforced atomically under the
   * same advisory lock as the per-symbol duplicate reservation. */
  maxOrdersPerWindow?: number;
  /** Shared live exposure ceiling. Enforced atomically with the order cap. */
  maxTotalExposure?: number;
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
        requested_count  NUMERIC(12,2) NOT NULL,
        limit_price      NUMERIC(12,8),
        reserved_cost    NUMERIC(12,8),
        status           TEXT NOT NULL DEFAULT 'reserved',
        reason           TEXT,
        filled_count     NUMERIC(12,2),
        avg_fill_price   NUMERIC(12,8),
        order_id         TEXT,
        reconciliation_reason TEXT,
        reconciliation_evidence JSONB,
        last_reconciled_at TIMESTAMPTZ,
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
        requested_count  NUMERIC(12,2) NOT NULL,
        status           TEXT NOT NULL DEFAULT 'reserved',
        reason           TEXT,
        filled_count     NUMERIC(12,2),
        avg_fill_price   NUMERIC(12,8),
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
    await client.query(`
      ALTER TABLE kalshi_regular_order_intents
        ALTER COLUMN requested_count TYPE NUMERIC(12,2) USING requested_count::numeric,
        ALTER COLUMN filled_count TYPE NUMERIC(12,2) USING filled_count::numeric,
        ALTER COLUMN limit_price TYPE NUMERIC(12,8) USING limit_price::numeric,
        ALTER COLUMN avg_fill_price TYPE NUMERIC(12,8) USING avg_fill_price::numeric,
        ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT,
        ADD COLUMN IF NOT EXISTS reconciliation_evidence JSONB,
        ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reserved_cost NUMERIC(12,8)
    `);
    await client.query(`
      ALTER TABLE kalshi_regular_exit_intents
        ALTER COLUMN requested_count TYPE NUMERIC(12,2) USING requested_count::numeric,
        ALTER COLUMN filled_count TYPE NUMERIC(12,2) USING filled_count::numeric,
        ALTER COLUMN avg_fill_price TYPE NUMERIC(12,8) USING avg_fill_price::numeric
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

export async function ensureRegularOrderIntentMigrations(): Promise<void> {
  await ensureMigrated();
}

const advisoryKey = (mode: string, windowKey: string): string =>
  `kalshi-regular-order-cap:${mode}:${windowKey}`;

/**
 * ATOMIC claim-and-persist. Runs in one transaction under a per-window advisory
 * lock so no two parallel symbol ticks can oversubscribe the shared cap. The
 * critical section is a single SQL statement after the lock rather than a
 * multi-query count/check/insert sequence. Persists the
 * full intent BEFORE the live POST. Returns claimed=false when an active intent
 * for (mode,symbol,window) already exists (duplicate / in-flight / filled).
 *
 * Live mode ONLY — the caller must not call this for paper entries.
 */
export async function claimRegularOrderIntent(
  key: RegularOrderIntentKey,
): Promise<ClaimIntentResult> {
  const requestedUnits = regularCountHundredths(key.requestedCount);
  if (requestedUnits == null || requestedUnits <= 0n) {
    throw new Error("requestedCount must be a positive FixedPointCount with at most two decimal places");
  }
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      advisoryKey(key.mode, key.windowKey),
    ]);

    const maxOrders =
      Number.isInteger(key.maxOrdersPerWindow) && (key.maxOrdersPerWindow ?? 0) > 0
        ? key.maxOrdersPerWindow!
        : null;
    const requestedCost =
      Number.isFinite(key.requestedCost) && (key.requestedCost ?? 0) > 0
        ? key.requestedCost!
        : null;
    const maxExposure =
      Number.isFinite(key.maxTotalExposure) && (key.maxTotalExposure ?? 0) > 0
        ? key.maxTotalExposure!
        : null;
    const claim = await client.query<{ claimed: boolean; reason: string | null }>(
      `WITH facts AS (
         SELECT
           EXISTS (
             SELECT 1
               FROM kalshi_regular_order_intents
              WHERE mode = $2 AND symbol = $3
                AND (
                  status IN ('reserved','unknown')
                  OR (window_key = $4 AND status = 'filled')
                )
           ) AS symbol_blocked,
           (
             SELECT COUNT(*)::int
               FROM kalshi_regular_order_intents
              WHERE mode = $2 AND window_key = $4
                AND status IN ('reserved','unknown','filled')
           ) AS active_count,
           (
             SELECT COALESCE(SUM(reserved_cost), 0)::numeric
               FROM kalshi_regular_order_intents
              WHERE mode = $2
                AND (
                  status IN ('reserved','unknown')
                  OR (window_key = $4 AND status = 'filled')
                )
           ) AS active_cost
       ),
       inserted AS (
         INSERT INTO kalshi_regular_order_intents
           (client_order_id, mode, symbol, window_key, ticker, side,
            requested_count, limit_price, reserved_cost, status, created_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',NOW()
           FROM facts
          WHERE NOT symbol_blocked
            AND ($10::int IS NULL OR active_count < $10)
            AND (
              $11::numeric IS NULL
              OR $9::numeric IS NULL
              OR active_cost + $9::numeric <= $11::numeric + 0.01
            )
         ON CONFLICT DO NOTHING
         RETURNING 1
       )
       SELECT true AS claimed, NULL::text AS reason FROM inserted
       UNION ALL
       SELECT false AS claimed,
         CASE
           WHEN symbol_blocked THEN 'unresolved_intent_exists'
           WHEN $10::int IS NOT NULL AND active_count >= $10 THEN 'window_order_cap_reached'
           WHEN $11::numeric IS NOT NULL AND $9::numeric IS NOT NULL
             AND active_cost + $9::numeric > $11::numeric + 0.01
             THEN 'exposure_cap_reached'
           ELSE 'reservation_conflict'
         END AS reason
       FROM facts
       WHERE NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      [
        key.clientOrderId,
        key.mode,
        key.symbol.toUpperCase(),
        key.windowKey,
        key.ticker,
        key.side,
        key.requestedCount,
        key.limitPrice,
        requestedCost,
        maxOrders,
        maxExposure,
      ],
    );
    await client.query("COMMIT");
    return claim.rows[0] ?? { claimed: false, reason: "reservation_conflict" };
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
 *
 * The confirmed-fill resolve is the durable proof that a reserved live intent
 * actually filled, so it MUST land: a transient DB failure is retried a small
 * bounded number of times, and a zero-row update (the intent row is missing —
 * never expected on the happy path) is surfaced by throwing so the caller can
 * log it as a fail-closed anomaly rather than silently leaving a stranded
 * reservation.
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
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      const res = await client.query(
        `UPDATE kalshi_regular_order_intents
         SET status = $1, reason = $2, filled_count = $3, avg_fill_price = $4,
             order_id = COALESCE($5, order_id), resolved_at = NOW()
         WHERE client_order_id = $6
           AND (status IN ('reserved', 'unknown') OR status = $1)`,
        [
          params.status, params.reason ?? null, params.filledCount ?? null,
          params.avgFillPrice ?? null, params.orderId ?? null, params.clientOrderId,
        ],
      );
      if ((res.rowCount ?? 0) === 0) {
        // No row matched — the intent row is missing (e.g. never persisted, or
        // already deleted). This is unexpected on the confirmed-fill path; do
        // NOT swallow it — surface a fail-closed anomaly to the caller.
        throw new Error(
          `resolveRegularOrderIntent matched zero rows for client_order_id=${params.clientOrderId} (status=${params.status})`,
        );
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, attempt * 500));
      }
    } finally {
      client.release();
    }
  }
  throw lastErr;
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

export type ClearRegularOrderIntentResult =
  | { outcome: "cleared"; clientOrderId: string; symbol: string; windowKey: string }
  | { outcome: "not_found" }
  | { outcome: "not_unresolved"; status: RegularIntentStatus };

/**
 * Explicit operator escape hatch for an indeterminate live entry intent.
 *
 * This NEVER claims the order was dead or filled. It preserves the intent row
 * and immutable context, adds structured override evidence, and only removes
 * the reservation after locking an intent that is already UNKNOWN. Reserved
 * intents may still be pre-POST or in flight and can never be operator-cleared.
 */
export async function clearRegularOrderIntent(params: {
  clientOrderId: string;
  actorId: string;
}): Promise<ClearRegularOrderIntentResult> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      status: RegularIntentStatus;
      symbol: string;
      window_key: string;
    }>(
      `SELECT status, symbol, window_key
         FROM kalshi_regular_order_intents
        WHERE client_order_id = $1 AND mode = 'live'
        FOR UPDATE`,
      [params.clientOrderId],
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return { outcome: "not_found" };
    }
    if (row.status !== "unknown") {
      await client.query("COMMIT");
      return { outcome: "not_unresolved", status: row.status };
    }

    const update = await client.query(
      `UPDATE kalshi_regular_order_intents
          SET status = 'operator_cleared',
              reason = 'operator cleared unresolved intent after explicit confirmation',
              reconciliation_reason = 'operator_cleared',
              reconciliation_evidence = jsonb_set(
                CASE
                  WHEN jsonb_typeof(reconciliation_evidence) = 'object'
                    THEN reconciliation_evidence
                  ELSE '{}'::jsonb
                END,
                '{operator_clear}',
                jsonb_build_object(
                  'actor_id', $2::text,
                  'cleared_at', NOW(),
                  'previous_status', status,
                  'previous_reason', reason,
                  'note', 'Operator cleared unresolved intent after explicit confirmation'
                ),
                true
              ),
              last_reconciled_at = NOW(),
              resolved_at = NOW()
        WHERE client_order_id = $1
          AND mode = 'live'
          AND status = 'unknown'`,
      [params.clientOrderId, params.actorId],
    );
    if ((update.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return { outcome: "not_unresolved", status: row.status };
    }
    await client.query("COMMIT");
    logger.warn(
      {
        clientOrderId: params.clientOrderId,
        symbol: row.symbol,
        windowKey: row.window_key,
      },
      "[kalshi-regular-intent] unresolved live intent cleared by operator override",
    );
    return {
      outcome: "cleared",
      clientOrderId: params.clientOrderId,
      symbol: row.symbol,
      windowKey: row.window_key,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
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
  const requestedUnits = regularCountHundredths(key.requestedCount);
  if (requestedUnits == null || requestedUnits <= 0n) {
    throw new Error("requestedCount must be a positive FixedPointCount with at most two decimal places");
  }
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `kalshi_regular_exit:${key.mode}`,
    ]);
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

// ---------------------------------------------------------------------------
// RECONCILIATION
//
// A confirmed live fill is proved durable ONLY once its intent row moves to
// status='filled'. The scoping bug in kalshi-bot-tick.ts left every confirmed
// live fill stranded at status='reserved', which keeps its window blocked and
// eventually blocks the symbol across later windows.
//
// This restart/periodic-safe repair changes ONLY status='reserved' intents to
// filled when an AUTHORITATIVE matching kalshi_bot_bets row exists for the same
// live mode / symbol / window / ticker / side and was persisted within 30
// seconds after the intent. It copies contract_count and entry_price onto the
// intent as fill metadata. Filled bet rows later transition from action='bet'
// to action='expired' or an exit action, so all confirmed position lifecycle
// states are accepted.
//
// FAIL-CLOSED GUARANTEES (unchanged from the durable design):
//   • status='unknown' rows are NEVER touched — indeterminate exposure stays
//     blocked pending manual/authoritative reconciliation.
//   • Only 'reserved' rows with a proven matching bet are repaired. A reserved
//     row with no matching bet is left blocked (its POST outcome is unproven).
//   • Paper is never involved — this only inspects mode='live' rows.
// ---------------------------------------------------------------------------

export interface RegularIntentReconcileResult {
  scanned: number;      // reserved live intents inspected
  reconciled: number;   // reserved → filled repairs applied
  unmatched: number;    // reserved intents with no authoritative bet (left blocked)
}

/**
 * Repair reserved live intents that a confirmed local fill left stranded.
 *
 * Matches each reserved live intent to the earliest authoritative filled-bet
 * lifecycle row. The match requires source='bot', live mode, same
 * symbol/window/ticker/side, a valid positive contract count no greater than
 * the requested count, a valid entry price, and persistence within 30 seconds
 * after the intent. Source matching plus the narrow time window distinguishes
 * the bot fill from manual or unrelated same-window activity.
 * When a match exists, flips the intent to status='filled', copying
 * contract_count and entry_price as fill metadata and validating that exactly
 * the expected row was affected. Rows with no matching bet are left untouched
 * (still blocked). status='unknown' rows are excluded.
 */
export async function reconcileReservedRegularIntents(): Promise<RegularIntentReconcileResult> {
  await ensureMigrated();
  const client = await pool.connect();
  const result: RegularIntentReconcileResult = { scanned: 0, reconciled: 0, unmatched: 0 };
  try {
    // Only reserved LIVE intents are candidates. 'unknown' is deliberately
    // excluded so indeterminate exposure stays fail-closed.
    const candidates = await client.query(
      `SELECT client_order_id, symbol, window_key, ticker, side,
              requested_count, created_at
       FROM kalshi_regular_order_intents
       WHERE mode = 'live' AND status = 'reserved'
       ORDER BY created_at ASC`,
    );
    result.scanned = candidates.rows.length;

    for (const row of candidates.rows as Array<{
      client_order_id: string;
      symbol: string;
      window_key: string;
      ticker: string;
      side: string;
      requested_count: string | number;
      created_at: Date;
    }>) {
      // Authoritative match: the earliest confirmed position lifecycle row this
      // fill persisted locally. The action changes after exit/settlement, so
      // match stable fill evidence rather than requiring action='bet'.
      const bet = await client.query(
        `SELECT id, contract_count, entry_price
         FROM kalshi_bot_bets
         WHERE mode = 'live'
           AND source = 'bot'
           AND action IN ('bet', 'expired', 'exit', 'late_recovery_exit')
           AND symbol = $1 AND window_key = $2
           AND ticker = $3 AND direction = $4
           AND contract_count > 0 AND contract_count <= $5
           AND entry_price > 0 AND entry_price < 1
           AND created_at >= $6
           AND created_at <= $6 + INTERVAL '30 seconds'
         ORDER BY created_at ASC
         LIMIT 1`,
        [
          row.symbol,
          row.window_key,
          row.ticker,
          row.side,
          Number(row.requested_count),
          row.created_at,
        ],
      );
      if (bet.rows.length === 0) {
        // No authoritative fill row — the POST outcome is unproven. Leave the
        // reservation blocked; a genuinely dead/unknown attempt must not be
        // silently released here.
        result.unmatched += 1;
        continue;
      }

      const betRow = bet.rows[0] as {
        id: string;
        contract_count: string | number | null;
        entry_price: string | number | null;
      };
      // Only touch this exact reserved row — the WHERE status='reserved' guard
      // means a concurrent resolve that already flipped it cannot be clobbered.
      const upd = await client.query(
        `UPDATE kalshi_regular_order_intents
         SET status = 'filled',
             reason = COALESCE(reason, 'reconciled: authoritative bet row present'),
             filled_count = COALESCE($2, filled_count),
             avg_fill_price = COALESCE($3, avg_fill_price),
             resolved_at = NOW()
         WHERE client_order_id = $1 AND status = 'reserved'`,
        [
          row.client_order_id,
          betRow.contract_count != null ? Number(betRow.contract_count) : null,
          betRow.entry_price != null ? Number(betRow.entry_price) : null,
        ],
      );
      if ((upd.rowCount ?? 0) === 1) {
        result.reconciled += 1;
        logger.info(
          {
            clientOrderId: row.client_order_id,
            symbol: row.symbol,
            windowKey: row.window_key,
            side: row.side,
            betId: betRow.id,
            filledCount: betRow.contract_count != null ? Number(betRow.contract_count) : null,
          },
          "[kalshi-regular-intent] reconciled stranded reserved intent → filled (authoritative bet present)",
        );
      } else {
        // The row was flipped concurrently (e.g. resolveRegularOrderIntent ran
        // between the SELECT and this UPDATE). Not an error — nothing stranded.
        logger.debug(
          { clientOrderId: row.client_order_id, symbol: row.symbol, windowKey: row.window_key },
          "[kalshi-regular-intent] reconcile skipped — reserved intent no longer reserved (concurrent resolve)",
        );
      }
    }

    if (result.reconciled > 0 || result.unmatched > 0) {
      logger.info(
        { scanned: result.scanned, reconciled: result.reconciled, unmatched: result.unmatched },
        "[kalshi-regular-intent] reserved-intent reconciliation pass complete",
      );
    }
    return result;
  } finally {
    client.release();
  }
}
