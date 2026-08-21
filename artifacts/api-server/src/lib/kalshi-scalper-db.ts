// ---------------------------------------------------------------------------
// kalshi-scalper-db.ts — Isolated SQL storage for the Kalshi scalper.
// All tables are created idempotently at startup via runScalpMigrations().
// Never touches regular bot tables (kalshi_bot_bets, bot_config, etc.).
// ---------------------------------------------------------------------------

import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import {
  DEFAULT_SCALP_CONFIG,
  type ScalpConfig,
  type ScalpOrder,
  type ScalpOrderStatus,
  type ScalpIncident,
  type ScalpMode,
  type ScalpReservation,
} from "./kalshi-scalper-types.ts";
import { evaluateScalpReservationRetry } from "./kalshi-scalper-policy.ts";

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

export async function runScalpMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Config table (single row)
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_config (
        id         TEXT PRIMARY KEY DEFAULT 'singleton',
        config     JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Durable reservations: UNIQUE(mode, symbol, window_key) prevents duplicate attempts.
    // reserved_budget is held for cap accounting until the attempt resolves.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_reservations (
        id              TEXT PRIMARY KEY,
        mode            TEXT NOT NULL,
        symbol          TEXT NOT NULL,
        window_key      TEXT NOT NULL,
        ticker          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'claimed',
        reason          TEXT,
        reserved_budget NUMERIC(10,4) NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_scalp_reservation UNIQUE (mode, symbol, window_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_res_mode_window
        ON kalshi_scalp_reservations (mode, window_key)
    `);

    // Orders/history — includes status/error fields and submitting lifecycle
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_orders (
        id                    TEXT PRIMARY KEY,
        mode                  TEXT NOT NULL,
        symbol                TEXT NOT NULL,
        window_key            TEXT NOT NULL,
        ticker                TEXT NOT NULL,
        side                  TEXT NOT NULL,
        entry_yes_price       NUMERIC(8,4) NOT NULL,
        contract_count        INTEGER NOT NULL,
        budget_spent          NUMERIC(10,4) NOT NULL DEFAULT 0,
        order_id              TEXT,
        filled_count          INTEGER NOT NULL DEFAULT 0,
        avg_fill_price        NUMERIC(8,4),
        limit_price           NUMERIC(8,4) NOT NULL,
        winning_contract_cost NUMERIC(8,4),
        status                TEXT NOT NULL DEFAULT 'submitting',
        error_message         TEXT,
        settlement_result     TEXT,
        outcome               TEXT,
        pnl                   NUMERIC(10,4),
        incident_id           TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at            TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_orders_mode_created
        ON kalshi_scalp_orders (mode, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_orders_symbol_window
        ON kalshi_scalp_orders (symbol, window_key)
    `);

    // Incidents
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_incidents (
        id                    TEXT PRIMARY KEY,
        order_id              TEXT,
        mode                  TEXT NOT NULL,
        symbol                TEXT NOT NULL,
        window_key            TEXT NOT NULL,
        ticker                TEXT NOT NULL,
        severity              TEXT NOT NULL DEFAULT 'high',
        description           TEXT NOT NULL,
        expected_band_min     NUMERIC(8,4) NOT NULL,
        expected_band_max     NUMERIC(8,4) NOT NULL,
        actual_winning_cost   NUMERIC(8,4) NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_incidents_created
        ON kalshi_scalp_incidents (created_at DESC)
    `);

    // ── Backward-compatible schema upgrades ────────────────────────────────
    // Earlier iterations of the scalper may have created these tables WITHOUT
    // some lifecycle columns. Bring any older schema up to date idempotently.
    // Every statement is safe to run repeatedly. If an ALTER fails we throw so
    // startup fails LOUDLY rather than succeeding and then failing on queries.
    await _upgradeScalpSchema(client);

    logger.info("[kalshi-scalper] DB migrations complete");
  } finally {
    client.release();
  }
}

/**
 * Idempotent, backward-compatible column/index upgrades for pre-existing scalper
 * schemas created by earlier iterations. Uses ADD COLUMN IF NOT EXISTS, backfills
 * NULLs to safe defaults, then enforces NOT NULL where the current code relies on
 * it. Never drops or renames columns (an older incidents.actual_fill_price, if
 * present, is left intact).
 */
async function _upgradeScalpSchema(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> {
  // ── reservations ──────────────────────────────────────────────────────────
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS status          TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS reason          TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS reserved_budget NUMERIC(10,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS ticker          TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS attempted_at    TIMESTAMPTZ`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ`);
  // Backfill safe defaults before enforcing NOT NULL.
  await client.query(`UPDATE kalshi_scalp_reservations SET status = 'claimed' WHERE status IS NULL`);
  await client.query(`UPDATE kalshi_scalp_reservations SET reserved_budget = 0 WHERE reserved_budget IS NULL`);
  await client.query(`UPDATE kalshi_scalp_reservations SET ticker = '' WHERE ticker IS NULL`);
  await client.query(`UPDATE kalshi_scalp_reservations SET attempted_at = NOW() WHERE attempted_at IS NULL`);
  await client.query(`UPDATE kalshi_scalp_reservations SET created_at = NOW() WHERE created_at IS NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN status          SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN status          SET DEFAULT 'claimed'`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN reserved_budget SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN reserved_budget SET DEFAULT 0`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN ticker          SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN attempted_at    SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN attempted_at    SET DEFAULT NOW()`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN created_at      SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_reservations ALTER COLUMN created_at      SET DEFAULT NOW()`);
  // Ensure the uniqueness constraint the atomic claim depends on exists.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_scalp_reservation'
      ) THEN
        ALTER TABLE kalshi_scalp_reservations
          ADD CONSTRAINT uq_scalp_reservation UNIQUE (mode, symbol, window_key);
      END IF;
    END $$;
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS scalp_res_mode_window ON kalshi_scalp_reservations (mode, window_key)`);

  // ── orders ────────────────────────────────────────────────────────────────
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS winning_contract_cost NUMERIC(8,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS status                TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS error_message         TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS order_id              TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS filled_count          INTEGER`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS avg_fill_price        NUMERIC(8,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS budget_spent          NUMERIC(10,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS settlement_result     TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS outcome               TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS pnl                   NUMERIC(10,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS incident_id           TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS settled_at            TIMESTAMPTZ`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ`);
  // Backfill safe defaults before enforcing NOT NULL.
  await client.query(`UPDATE kalshi_scalp_orders SET status = 'unknown' WHERE status IS NULL`);
  await client.query(`UPDATE kalshi_scalp_orders SET filled_count = 0 WHERE filled_count IS NULL`);
  await client.query(`UPDATE kalshi_scalp_orders SET budget_spent = 0 WHERE budget_spent IS NULL`);
  await client.query(`UPDATE kalshi_scalp_orders SET created_at = NOW() WHERE created_at IS NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN status       SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN status       SET DEFAULT 'submitting'`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN filled_count SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN filled_count SET DEFAULT 0`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN budget_spent SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN budget_spent SET DEFAULT 0`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN created_at   SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN created_at   SET DEFAULT NOW()`);
  await client.query(`CREATE INDEX IF NOT EXISTS scalp_orders_mode_created ON kalshi_scalp_orders (mode, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS scalp_orders_symbol_window ON kalshi_scalp_orders (symbol, window_key)`);

  // ── incidents ───────────────────────────────────────────────────────────
  // Current code inserts/queries actual_winning_cost + expected_band_min/max.
  // Older schemas may have had actual_fill_price instead; add the current
  // columns (leave any legacy actual_fill_price untouched).
  await client.query(`ALTER TABLE kalshi_scalp_incidents ADD COLUMN IF NOT EXISTS actual_winning_cost NUMERIC(8,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ADD COLUMN IF NOT EXISTS expected_band_min   NUMERIC(8,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ADD COLUMN IF NOT EXISTS expected_band_max   NUMERIC(8,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ADD COLUMN IF NOT EXISTS order_id            TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ADD COLUMN IF NOT EXISTS severity            TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ`);
  // Backfill safe defaults before enforcing NOT NULL.
  await client.query(`UPDATE kalshi_scalp_incidents SET actual_winning_cost = 0 WHERE actual_winning_cost IS NULL`);
  await client.query(`UPDATE kalshi_scalp_incidents SET expected_band_min = 0 WHERE expected_band_min IS NULL`);
  await client.query(`UPDATE kalshi_scalp_incidents SET expected_band_max = 1 WHERE expected_band_max IS NULL`);
  await client.query(`UPDATE kalshi_scalp_incidents SET severity = 'high' WHERE severity IS NULL`);
  await client.query(`UPDATE kalshi_scalp_incidents SET created_at = NOW() WHERE created_at IS NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN actual_winning_cost SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN expected_band_min   SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN expected_band_max   SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN severity            SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN severity            SET DEFAULT 'high'`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN created_at          SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_incidents ALTER COLUMN created_at          SET DEFAULT NOW()`);
  await client.query(`CREATE INDEX IF NOT EXISTS scalp_incidents_created ON kalshi_scalp_incidents (created_at DESC)`);
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export async function loadScalpConfigFromDB(): Promise<ScalpConfig> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT config FROM kalshi_scalp_config WHERE id = 'singleton'",
    );
    if (res.rows.length === 0) return { ...DEFAULT_SCALP_CONFIG };
    const raw = res.rows[0].config as Record<string, unknown>;
    return mergeScalpConfig(DEFAULT_SCALP_CONFIG, raw);
  } finally {
    client.release();
  }
}

export async function saveScalpConfigToDB(config: ScalpConfig): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO kalshi_scalp_config (id, config, updated_at)
       VALUES ('singleton', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = NOW()`,
      [JSON.stringify(config)],
    );
  } finally {
    client.release();
  }
}

function mergeScalpConfig(defaults: ScalpConfig, raw: Record<string, unknown>): ScalpConfig {
  return {
    enabled: typeof raw["enabled"] === "boolean" ? raw["enabled"] : defaults.enabled,
    mode: (raw["mode"] === "live" || raw["mode"] === "paper") ? raw["mode"] : defaults.mode,
    globalBandMin: typeof raw["globalBandMin"] === "number" ? raw["globalBandMin"] : defaults.globalBandMin,
    globalBandMax: typeof raw["globalBandMax"] === "number" ? raw["globalBandMax"] : defaults.globalBandMax,
    finalWindowSeconds: typeof raw["finalWindowSeconds"] === "number" ? raw["finalWindowSeconds"] : defaults.finalWindowSeconds,
    budgetDollars: typeof raw["budgetDollars"] === "number" ? raw["budgetDollars"] : defaults.budgetDollars,
    // Preserve explicit null (null = no cap)
    dailyCapDollars: "dailyCapDollars" in raw
      ? (raw["dailyCapDollars"] === null ? null : typeof raw["dailyCapDollars"] === "number" ? raw["dailyCapDollars"] : defaults.dailyCapDollars)
      : defaults.dailyCapDollars,
    openCapDollars: "openCapDollars" in raw
      ? (raw["openCapDollars"] === null ? null : typeof raw["openCapDollars"] === "number" ? raw["openCapDollars"] : defaults.openCapDollars)
      : defaults.openCapDollars,
    freefallGuardEnabled: typeof raw["freefallGuardEnabled"] === "boolean" ? raw["freefallGuardEnabled"] : defaults.freefallGuardEnabled,
    freefallLookbackSeconds: typeof raw["freefallLookbackSeconds"] === "number" ? raw["freefallLookbackSeconds"] : defaults.freefallLookbackSeconds,
    freefallThresholdPct: typeof raw["freefallThresholdPct"] === "number" ? raw["freefallThresholdPct"] : defaults.freefallThresholdPct,
    circuitBreakerEnabled: typeof raw["circuitBreakerEnabled"] === "boolean" ? raw["circuitBreakerEnabled"] : defaults.circuitBreakerEnabled,
    circuitBreaker: typeof raw["circuitBreaker"] === "boolean" ? raw["circuitBreaker"] : defaults.circuitBreaker,
    circuitBreakerReason: typeof raw["circuitBreakerReason"] === "string" ? raw["circuitBreakerReason"] : (raw["circuitBreakerReason"] === null ? null : defaults.circuitBreakerReason),
    perMarketOverrides: Array.isArray(raw["perMarketOverrides"])
      ? raw["perMarketOverrides"] as ScalpConfig["perMarketOverrides"]
      : defaults.perMarketOverrides,
  };
}

// ---------------------------------------------------------------------------
// Reservation management — atomic claim-and-cap
// ---------------------------------------------------------------------------

export interface ClaimAndCapResult {
  claimed: boolean;   // false when an existing row is still cooling down or terminal
  allowed: boolean;   // true only when budget passed all caps and was reserved
  reason: string | null;
  reservationId: string | null;
  submittedOrders: number;
  retryAfterMs: number | null;
  dailyCommitted: number; // pre-existing daily committed (spend + reserved), excludes this claim
  openCommitted: number;  // pre-existing open committed (spend + reserved), excludes this claim
}

/**
 * ATOMIC claim-and-cap. Runs a single pg transaction holding a per-mode
 * advisory transaction lock so no two processes/ticks can race the cap.
 *
 * Steps inside ONE transaction:
 *   1. pg_advisory_xact_lock(hashtext('kalshi-scalper-cap:' || mode))
 *   2. INSERT reservation (reserved_budget=0) ON CONFLICT DO NOTHING RETURNING.
 *      On conflict, lock the existing row and apply the bounded retry policy.
 *      Only confirmed zero-fills and explicit no-exposure transient skips may be
 *      returned to `claimed`; terminal/unknown/in-flight rows stay blocked.
 *   3. Sum actual daily filled/paper spend + current reserved totals (this new
 *      row is still 0, so it never double-counts itself); and open unsettled
 *      spend + reserved totals.
 *   4. Compare each (total + requestedBudget) against nullable caps.
 *      Blocked → UPDATE this reservation status='skipped', reason, reserved_budget=0;
 *      return {claimed:true, allowed:false}.
 *   5. Allowed → UPDATE this reservation reserved_budget=requestedBudget;
 *      return {claimed:true, allowed:true}.
 *
 * Cap denials remain terminal. Retryable outcomes retain the same durable row,
 * so restart safety and the UNIQUE(mode,symbol,window_key) serialization point
 * are preserved while allowing bounded re-attempts.
 */
export async function claimReservationAndCap(
  id: string,
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  ticker: string,
  requestedBudget: number,
  dailyCapDollars: number | null,
  openCapDollars: number | null,
): Promise<ClaimAndCapResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Per-mode advisory lock — released automatically at COMMIT/ROLLBACK.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-cap:${mode}`],
    );

    // Attempt to insert this reservation with reserved_budget=0.
    const insertRes = await client.query(
      `INSERT INTO kalshi_scalp_reservations
         (id, mode, symbol, window_key, ticker, status, reserved_budget, created_at, attempted_at)
       VALUES ($1, $2, $3, $4, $5, 'claimed', 0, NOW(), NOW())
       ON CONFLICT (mode, symbol, window_key) DO NOTHING
       RETURNING id`,
      [id, mode, symbol.toUpperCase(), windowKey, ticker],
    );

    let reservationId = id;
    let submittedOrders = 0;

    if (insertRes.rows.length === 0) {
      // The unique row is the durable per-symbol/window mutex. Lock it before
      // deciding whether a proven no-exposure outcome may retry.
      const existingRes = await client.query(
        `SELECT id, status, reason, reserved_budget,
                GREATEST(0, EXTRACT(EPOCH FROM (NOW() - attempted_at)) * 1000)::float AS elapsed_ms
         FROM kalshi_scalp_reservations
         WHERE mode = $1 AND symbol = $2 AND window_key = $3
         FOR UPDATE`,
        [mode, symbol.toUpperCase(), windowKey],
      );
      const existing = existingRes.rows[0];
      if (!existing) {
        await client.query("COMMIT");
        return {
          claimed: false,
          allowed: false,
          reason: "duplicate_missing",
          reservationId: null,
          submittedOrders: 0,
          retryAfterMs: null,
          dailyCommitted: 0,
          openCommitted: 0,
        };
      }

      reservationId = String(existing["id"]);
      const submittedRes = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM kalshi_scalp_orders
         WHERE mode = $1 AND symbol = $2 AND window_key = $3
           AND status = 'zero_fill'`,
        [mode, symbol.toUpperCase(), windowKey],
      );
      submittedOrders = Number(submittedRes.rows[0]?.["count"] ?? 0);
      const retry = evaluateScalpReservationRetry({
        status: String(existing["status"] ?? ""),
        reason: existing["reason"] != null ? String(existing["reason"]) : null,
        elapsedMs: Number(existing["elapsed_ms"] ?? 0),
        submittedOrders,
      });

      if (!retry.retryableNow) {
        await client.query("COMMIT");
        return {
          claimed: false,
          allowed: false,
          reason: retry.reason,
          reservationId,
          submittedOrders,
          retryAfterMs: retry.retryAfterMs,
          dailyCommitted: 0,
          openCommitted: 0,
        };
      }

      await client.query(
        `UPDATE kalshi_scalp_reservations
         SET status = 'claimed', reason = NULL, reserved_budget = 0,
             ticker = $1, attempted_at = NOW()
         WHERE id = $2`,
        [ticker, reservationId],
      );
    }

    // Sum actual committed spend + reserved (this row is 0, safe from self-count).
    const dailyRes = await client.query(
      `SELECT
         (SELECT COALESCE(SUM(budget_spent), 0)::float
            FROM kalshi_scalp_orders
            WHERE mode = $1
              AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
              AND status IN ('filled', 'paper', 'submitting', 'unknown'))
       + (SELECT COALESCE(SUM(reserved_budget), 0)::float
            FROM kalshi_scalp_reservations
            WHERE mode = $1
              AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
              AND reserved_budget > 0) AS total`,
      [mode],
    );
    const openRes = await client.query(
      `SELECT
         (SELECT COALESCE(SUM(budget_spent), 0)::float
            FROM kalshi_scalp_orders
            WHERE mode = $1
              AND settlement_result IS NULL
              AND status IN ('filled', 'paper', 'submitting', 'unknown'))
       + (SELECT COALESCE(SUM(reserved_budget), 0)::float
            FROM kalshi_scalp_reservations
            WHERE mode = $1
              AND reserved_budget > 0) AS total`,
      [mode],
    );

    const dailyCommitted = Number(dailyRes.rows[0]?.total ?? 0);
    const openCommitted = Number(openRes.rows[0]?.total ?? 0);

    // Cap comparisons (nullable caps → no limit)
    let blockedReason: string | null = null;
    if (dailyCapDollars != null && dailyCommitted + requestedBudget > dailyCapDollars) {
      blockedReason = `daily_cap_exceeded (committed=${dailyCommitted.toFixed(2)} cap=${dailyCapDollars})`;
    } else if (openCapDollars != null && openCommitted + requestedBudget > openCapDollars) {
      blockedReason = `open_cap_exceeded (open=${openCommitted.toFixed(2)} cap=${openCapDollars})`;
    }

    if (blockedReason) {
      // Persist cap denial as a terminal skip with no reserved budget.
      await client.query(
        `UPDATE kalshi_scalp_reservations
         SET status = 'skipped', reason = $1, reserved_budget = 0, attempted_at = NOW()
         WHERE id = $2`,
        [blockedReason, reservationId],
      );
      await client.query("COMMIT");
      return {
        claimed: true,
        allowed: false,
        reason: blockedReason,
        reservationId,
        submittedOrders,
        retryAfterMs: null,
        dailyCommitted,
        openCommitted,
      };
    }

    // Allowed: reserve the requested budget on this row.
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET reserved_budget = $1, attempted_at = NOW()
       WHERE id = $2`,
      [requestedBudget, reservationId],
    );
    await client.query("COMMIT");
    return {
      claimed: true,
      allowed: true,
      reason: null,
      reservationId,
      submittedOrders,
      retryAfterMs: null,
      dailyCommitted,
      openCommitted,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updateReservationStatus(
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  status: "claimed" | "filled" | "zero_fill" | "error" | "skipped" | "unknown",
  reason?: string,
  releaseBudget = false,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = $1, reason = $2, attempted_at = NOW()
           ${releaseBudget ? ", reserved_budget = 0" : ""}
       WHERE mode = $3 AND symbol = $4 AND window_key = $5`,
      [status, reason ?? null, mode, symbol.toUpperCase(), windowKey],
    );
  } finally {
    client.release();
  }
}

export async function countTodayReservations(mode: ScalpMode): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM kalshi_scalp_reservations
       WHERE mode = $1
         AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')`,
      [mode],
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } finally {
    client.release();
  }
}

/** Read-only preflight snapshot using the same committed-spend semantics as the
 * atomic claim transaction. It is informational/warm-up only; every actual
 * attempt still repeats the authoritative calculation under the advisory lock. */
export async function getScalpCommittedTotals(mode: ScalpMode): Promise<{
  dailyCommitted: number;
  openCommitted: number;
}> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT
         (SELECT COALESCE(SUM(budget_spent), 0)::float
            FROM kalshi_scalp_orders
            WHERE mode = $1
              AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
              AND status IN ('filled', 'paper', 'submitting', 'unknown'))
       + (SELECT COALESCE(SUM(reserved_budget), 0)::float
            FROM kalshi_scalp_reservations
            WHERE mode = $1
              AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
              AND reserved_budget > 0) AS daily_committed,
         (SELECT COALESCE(SUM(budget_spent), 0)::float
            FROM kalshi_scalp_orders
            WHERE mode = $1
              AND settlement_result IS NULL
              AND status IN ('filled', 'paper', 'submitting', 'unknown'))
       + (SELECT COALESCE(SUM(reserved_budget), 0)::float
            FROM kalshi_scalp_reservations
            WHERE mode = $1
              AND reserved_budget > 0) AS open_committed`,
      [mode],
    );
    return {
      dailyCommitted: Number(res.rows[0]?.["daily_committed"] ?? 0),
      openCommitted: Number(res.rows[0]?.["open_committed"] ?? 0),
    };
  } finally {
    client.release();
  }
}

export async function getRecentScalpReservations(opts: {
  mode?: ScalpMode;
  limit?: number;
}): Promise<ScalpReservation[]> {
  const client = await pool.connect();
  try {
    const params: unknown[] = [];
    const conditions: string[] = [];
    let idx = 1;
    if (opts.mode) {
      conditions.push(`r.mode = $${idx++}`);
      params.push(opts.mode);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    params.push(limit);
    const res = await client.query(
      `SELECT r.id, r.mode, r.symbol, r.window_key, r.ticker, r.status, r.reason,
               r.reserved_budget, r.created_at, r.attempted_at,
               (SELECT COUNT(*)::int
                  FROM kalshi_scalp_orders o
                  WHERE o.mode = r.mode
                    AND o.symbol = r.symbol
                    AND o.window_key = r.window_key
                    AND o.status IN ('filled', 'zero_fill', 'submitting', 'unknown')) AS submission_count
       FROM kalshi_scalp_reservations r
       ${where}
       ORDER BY r.attempted_at DESC
       LIMIT $${idx}`,
      params,
    );
    return res.rows.map((row) => ({
      id: String(row["id"]),
      mode: String(row["mode"]) as ScalpMode,
      symbol: String(row["symbol"]),
      windowKey: String(row["window_key"]),
      ticker: String(row["ticker"]),
      status: String(row["status"]) as ScalpReservation["status"],
      reason: row["reason"] != null ? String(row["reason"]) : undefined,
      reservedBudget: Number(row["reserved_budget"] ?? 0),
      submissionCount: Number(row["submission_count"] ?? 0),
      createdAt: row["created_at"] instanceof Date
        ? row["created_at"]
        : new Date(String(row["created_at"])),
      attemptedAt: row["attempted_at"] instanceof Date
        ? row["attempted_at"]
        : new Date(String(row["attempted_at"])),
    }));
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Atomic finalize-and-release (confirmed fill / definite zero-fill)
// ---------------------------------------------------------------------------

/**
 * ATOMIC: finalize a persisted order intent AND release its reservation in ONE
 * transaction under the same per-mode advisory lock. Used only for definite
 * outcomes (confirmed fill or confirmed zero-fill). For live UNKNOWN outcomes,
 * the reserved budget MUST remain (never released) — do not use this.
 */
export async function finalizeOrderAndReleaseReservation(params: {
  orderId: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  status: ScalpOrderStatus;               // 'filled' | 'zero_fill' | 'paper'
  reservationStatus: "filled" | "zero_fill";
  filledCount: number;
  avgFillPrice: number | null;
  winningContractCost: number | null;
  budgetSpent: number;
  exchangeOrderId: string | null;
  reason: string | null;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-cap:${params.mode}`],
    );
    await client.query(
      `UPDATE kalshi_scalp_orders
       SET status = $1, filled_count = $2, avg_fill_price = $3,
           winning_contract_cost = $4, budget_spent = $5,
           order_id = COALESCE($6, order_id), error_message = NULL
       WHERE id = $7`,
      [
        params.status, params.filledCount, params.avgFillPrice ?? null,
        params.winningContractCost ?? null, params.budgetSpent,
        params.exchangeOrderId ?? null, params.orderId,
      ],
    );
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = $1, reason = $2, reserved_budget = 0, attempted_at = NOW()
       WHERE mode = $3 AND symbol = $4 AND window_key = $5`,
      [params.reservationStatus, params.reason ?? null, params.mode, params.symbol.toUpperCase(), params.windowKey],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * ATOMIC: abort a persisted-but-NEVER-SUBMITTED order intent AND release its
 * reservation in ONE transaction under the per-mode advisory lock.
 *
 * Used ONLY when a live 'submitting' intent row was created but the final
 * pre-submit validation failed BEFORE any broker call. Because no exchange
 * order was ever placed, there is NO indeterminate exposure: this is a RESOLVED
 * outcome (skipped), safe to release the reserved budget. Never use this after a
 * placeOrder call has been made.
 */
export async function abortIntentAndReleaseReservation(params: {
  orderId: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  reason: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-cap:${params.mode}`],
    );
    // Mark the never-submitted intent as skipped with an explanatory message.
    await client.query(
      `UPDATE kalshi_scalp_orders
       SET status = 'skipped', error_message = $1
       WHERE id = $2`,
      [params.reason, params.orderId],
    );
    // Release the reservation — no broker exposure exists.
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = 'skipped', reason = $1, reserved_budget = 0, attempted_at = NOW()
       WHERE mode = $2 AND symbol = $3 AND window_key = $4`,
      [params.reason, params.mode, params.symbol.toUpperCase(), params.windowKey],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Unresolved live attempts — block circuit-breaker reset until reconciled
// ---------------------------------------------------------------------------

export interface UnresolvedLiveRow {
  kind: "order" | "reservation";
  id: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  status: string;
  reservedBudget: number;
  createdAt: Date;
}

/**
 * Count LIVE attempts whose fill state is indeterminate. Includes:
 *   - orders with status IN ('submitting','unknown')
 *   - reservations with status='unknown' OR (reserved_budget > 0 AND status NOT in resolved set)
 * These represent capital/positions that require authoritative manual
 * reconciliation before the breaker may be reset.
 */
export async function countUnresolvedLiveAttempts(): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT
        (SELECT COUNT(*) FROM kalshi_scalp_orders
           WHERE mode = 'live' AND status IN ('submitting','unknown'))
      + (SELECT COUNT(*) FROM kalshi_scalp_reservations
           WHERE mode = 'live'
             AND (status = 'unknown' OR (reserved_budget > 0 AND status = 'claimed'))) AS cnt`,
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } finally {
    client.release();
  }
}

export async function getUnresolvedLiveAttempts(): Promise<UnresolvedLiveRow[]> {
  const client = await pool.connect();
  try {
    const [ordersRes, resRes] = await Promise.all([
      client.query(
        `SELECT id, symbol, window_key, ticker, status, created_at
         FROM kalshi_scalp_orders
         WHERE mode = 'live' AND status IN ('submitting','unknown')
         ORDER BY created_at ASC`,
      ),
      client.query(
        `SELECT id, symbol, window_key, ticker, status, reserved_budget, created_at
         FROM kalshi_scalp_reservations
         WHERE mode = 'live'
           AND (status = 'unknown' OR (reserved_budget > 0 AND status = 'claimed'))
         ORDER BY created_at ASC`,
      ),
    ]);
    const rows: UnresolvedLiveRow[] = [];
    for (const r of ordersRes.rows) {
      rows.push({
        kind: "order",
        id: String(r["id"]),
        symbol: String(r["symbol"]),
        windowKey: String(r["window_key"]),
        ticker: String(r["ticker"]),
        status: String(r["status"]),
        reservedBudget: 0,
        createdAt: r["created_at"] instanceof Date ? r["created_at"] : new Date(String(r["created_at"])),
      });
    }
    for (const r of resRes.rows) {
      rows.push({
        kind: "reservation",
        id: String(r["id"]),
        symbol: String(r["symbol"]),
        windowKey: String(r["window_key"]),
        ticker: String(r["ticker"]),
        status: String(r["status"]),
        reservedBudget: Number(r["reserved_budget"] ?? 0),
        createdAt: r["created_at"] instanceof Date ? r["created_at"] : new Date(String(r["created_at"])),
      });
    }
    return rows;
  } finally {
    client.release();
  }
}

// For status display only (actual spend, not including reserved)
export async function getTodayScalpSpend(mode: ScalpMode): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COALESCE(SUM(budget_spent), 0)::float AS total
       FROM kalshi_scalp_orders
       WHERE mode = $1
         AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
         AND status IN ('filled', 'paper')`,
      [mode],
    );
    return Number(res.rows[0]?.total ?? 0);
  } finally {
    client.release();
  }
}

export async function getOpenScalpSpend(mode: ScalpMode): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COALESCE(SUM(budget_spent), 0)::float AS total
       FROM kalshi_scalp_orders
       WHERE mode = $1
         AND settlement_result IS NULL
         AND status IN ('filled', 'paper')`,
      [mode],
    );
    return Number(res.rows[0]?.total ?? 0);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Order persistence
// ---------------------------------------------------------------------------

/** Persist a "submitting" intent record BEFORE the live placeOrder call. */
export async function insertScalpOrderIntent(order: ScalpOrder): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO kalshi_scalp_orders
         (id, mode, symbol, window_key, ticker, side, entry_yes_price,
          contract_count, budget_spent, order_id, filled_count, avg_fill_price,
          limit_price, winning_contract_cost, status, error_message,
          settlement_result, outcome, pnl, incident_id, created_at, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (id) DO NOTHING`,
      [
        order.id, order.mode, order.symbol.toUpperCase(), order.windowKey,
        order.ticker, order.side, order.entryYesPrice, order.contractCount,
        order.budgetSpent, order.orderId, order.filledCount,
        order.avgFillPrice ?? null, order.limitPrice,
        order.winningContractCost ?? null,
        order.status, order.errorMessage ?? null,
        order.settlementResult ?? null, order.outcome ?? null,
        order.pnl ?? null, order.incidentId ?? null,
        order.createdAt, order.settledAt ?? null,
      ],
    );
  } finally {
    client.release();
  }
}

/** Update order after exchange response (fill or zero-fill or error). */
export async function finalizeScalpOrder(
  id: string,
  status: ScalpOrderStatus,
  filledCount: number,
  avgFillPrice: number | null,
  winningContractCost: number | null,
  budgetSpent: number,
  orderId: string | null,
  errorMessage: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_scalp_orders
       SET status = $1, filled_count = $2, avg_fill_price = $3,
           winning_contract_cost = $4, budget_spent = $5,
           order_id = $6, error_message = $7
       WHERE id = $8`,
      [status, filledCount, avgFillPrice ?? null, winningContractCost ?? null,
       budgetSpent, orderId ?? null, errorMessage ?? null, id],
    );
  } finally {
    client.release();
  }
}

export async function updateScalpOrderSettlement(
  id: string,
  settlementResult: "yes" | "no",
  outcome: "win" | "loss",
  pnl: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_scalp_orders
       SET settlement_result = $1, outcome = $2, pnl = $3, settled_at = NOW()
       WHERE id = $4`,
      [settlementResult, outcome, pnl, id],
    );
  } finally {
    client.release();
  }
}

export async function setScalpOrderIncident(
  orderId: string,
  incidentId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_scalp_orders SET incident_id = $1 WHERE id = $2`,
      [incidentId, orderId],
    );
  } finally {
    client.release();
  }
}

/** Find any orders stuck in 'submitting' status (server restart during in-flight order). */
export async function getSubmittingScalpOrders(): Promise<ScalpOrder[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM kalshi_scalp_orders WHERE status = 'submitting' ORDER BY created_at ASC`,
    );
    return res.rows.map(rowToScalpOrder);
  } finally {
    client.release();
  }
}

export async function getUnsettledScalpOrders(): Promise<ScalpOrder[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM kalshi_scalp_orders
       WHERE settlement_result IS NULL
         AND status IN ('filled', 'paper')
         AND filled_count > 0
       ORDER BY created_at ASC`,
    );
    return res.rows.map(rowToScalpOrder);
  } finally {
    client.release();
  }
}

export async function getScalpOrders(opts: {
  mode?: ScalpMode;
  limit?: number;
  symbol?: string;
}): Promise<ScalpOrder[]> {
  const client = await pool.connect();
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts.mode) { conditions.push(`mode = $${idx++}`); params.push(opts.mode); }
    if (opts.symbol) { conditions.push(`symbol = $${idx++}`); params.push(opts.symbol.toUpperCase()); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    params.push(limit);
    const res = await client.query(
      `SELECT * FROM kalshi_scalp_orders ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      params,
    );
    return res.rows.map(rowToScalpOrder);
  } finally {
    client.release();
  }
}

function rowToScalpOrder(row: Record<string, unknown>): ScalpOrder {
  return {
    id: String(row["id"]),
    mode: String(row["mode"]) as ScalpMode,
    symbol: String(row["symbol"]),
    windowKey: String(row["window_key"]),
    ticker: String(row["ticker"]),
    side: String(row["side"]) as "yes" | "no",
    entryYesPrice: Number(row["entry_yes_price"]),
    contractCount: Number(row["contract_count"]),
    budgetSpent: Number(row["budget_spent"]),
    orderId: row["order_id"] != null ? String(row["order_id"]) : null,
    filledCount: Number(row["filled_count"]),
    avgFillPrice: row["avg_fill_price"] != null ? Number(row["avg_fill_price"]) : null,
    limitPrice: Number(row["limit_price"]),
    winningContractCost: row["winning_contract_cost"] != null ? Number(row["winning_contract_cost"]) : null,
    status: String(row["status"]) as ScalpOrderStatus,
    errorMessage: row["error_message"] != null ? String(row["error_message"]) : null,
    settlementResult: (row["settlement_result"] === "yes" || row["settlement_result"] === "no") ? row["settlement_result"] : null,
    outcome: (row["outcome"] === "win" || row["outcome"] === "loss") ? row["outcome"] : null,
    pnl: row["pnl"] != null ? Number(row["pnl"]) : null,
    incidentId: row["incident_id"] != null ? String(row["incident_id"]) : null,
    createdAt: row["created_at"] instanceof Date ? row["created_at"] : new Date(String(row["created_at"])),
    settledAt: row["settled_at"] != null ? (row["settled_at"] instanceof Date ? row["settled_at"] : new Date(String(row["settled_at"]))) : null,
  };
}

// ---------------------------------------------------------------------------
// Incident persistence
// ---------------------------------------------------------------------------

export async function insertScalpIncident(incident: ScalpIncident): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO kalshi_scalp_incidents
         (id, order_id, mode, symbol, window_key, ticker, severity,
          description, expected_band_min, expected_band_max, actual_winning_cost, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        incident.id, incident.orderId ?? null, incident.mode,
        incident.symbol.toUpperCase(), incident.windowKey, incident.ticker,
        incident.severity, incident.description,
        incident.expectedBandMin, incident.expectedBandMax,
        incident.actualWinningCost, incident.createdAt,
      ],
    );
  } finally {
    client.release();
  }
}

export async function getScalpIncidents(limit = 20): Promise<ScalpIncident[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM kalshi_scalp_incidents ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      id: String(row["id"]),
      orderId: row["order_id"] != null ? String(row["order_id"]) : null,
      mode: String(row["mode"]) as ScalpMode,
      symbol: String(row["symbol"]),
      windowKey: String(row["window_key"]),
      ticker: String(row["ticker"]),
      severity: "high" as const,
      description: String(row["description"]),
      expectedBandMin: Number(row["expected_band_min"]),
      expectedBandMax: Number(row["expected_band_max"]),
      actualWinningCost: Number(row["actual_winning_cost"]),
      createdAt: row["created_at"] instanceof Date ? row["created_at"] : new Date(String(row["created_at"])),
    }));
  } finally {
    client.release();
  }
}
