// ---------------------------------------------------------------------------
// kalshi-scalper-db.ts — Isolated SQL storage for the Kalshi scalper.
// All tables are created idempotently at startup via runScalpMigrations().
// Never touches regular bot tables (kalshi_bot_bets, bot_config, etc.).
// ---------------------------------------------------------------------------

import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import {
  DEFAULT_SCALP_CONFIG,
  normalizeScalpOpenCapDollars,
  type ScalpConfig,
  type ScalpEntryGuardEvidence,
  type ScalpOrder,
  type ScalpOrderStatus,
  type ScalpIncident,
  type ScalpMode,
  type ScalpReservation,
  type ScalpSkipEvidence,
  type ScalpFunnelEventStage,
  type ScalpShadowStudyRecord,
  type ScalpShadowVariantSeconds,
} from "./kalshi-scalper-types.ts";
import type { ScalpWindowFunnelCounters } from "./kalshi-scalper-fast-path.ts";
import {
  evaluateScalpReservationRetry,
  isInFinalWindow,
  resolveTimingPhase,
  SCALP_PREFLIGHT_LEAD_SECONDS,
} from "./kalshi-scalper-policy.ts";

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
    // skip_evidence is a nullable additive JSONB column for structured skip diagnostics.
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
        skip_evidence   JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_scalp_reservation UNIQUE (mode, symbol, window_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_res_mode_window
        ON kalshi_scalp_reservations (mode, window_key)
    `);

    // Funnel events preserve candidate discovery and quote churn even when a
    // later safe retry updates the reservation to a filled state.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_funnel_events (
        mode       TEXT NOT NULL,
        window_key TEXT NOT NULL,
        symbol     TEXT NOT NULL,
        stage      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (mode, window_key, symbol, stage)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_funnel_mode_window
        ON kalshi_scalp_funnel_events (mode, window_key, created_at DESC)
    `);

    // Counterfactual earlier-entry study. This table is intentionally separate
    // from reservations/orders so shadow observations cannot affect caps,
    // execution, reconciliation, or real performance totals.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_shadow_entries (
        mode                       TEXT NOT NULL,
        window_key                 TEXT NOT NULL,
        symbol                     TEXT NOT NULL,
        ticker                     TEXT NOT NULL,
        variant_seconds            INTEGER NOT NULL,
        status                     TEXT NOT NULL,
        first_eligible_at          TIMESTAMPTZ NOT NULL,
        first_safe_entry_at        TIMESTAMPTZ,
        first_safe_seconds_remaining NUMERIC(10,3),
        side                       TEXT,
        yes_ask                    NUMERIC(8,4),
        no_ask                     NUMERIC(8,4),
        winning_ask                NUMERIC(8,4),
        hypothetical_contracts     INTEGER NOT NULL DEFAULT 0,
        hypothetical_budget        NUMERIC(12,4) NOT NULL DEFAULT 0,
        last_blocker               TEXT,
        blocker_counts             JSONB NOT NULL DEFAULT '{}'::jsonb,
        entry_evidence              JSONB,
        later_quote_issue_observed  BOOLEAN NOT NULL DEFAULT FALSE,
        later_quote_issue_reason    TEXT,
        settlement_result           TEXT,
        outcome                     TEXT,
        hypothetical_pnl            NUMERIC(16,8),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at                  TIMESTAMPTZ,
        PRIMARY KEY (mode, window_key, symbol, variant_seconds),
        CONSTRAINT scalp_shadow_variant_seconds
          CHECK (variant_seconds IN (90, 105, 120))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_shadow_mode_updated
        ON kalshi_scalp_shadow_entries (mode, updated_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS scalp_shadow_unsettled
        ON kalshi_scalp_shadow_entries (status, first_eligible_at)
        WHERE first_safe_entry_at IS NOT NULL AND settlement_result IS NULL
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
        budget_spent          NUMERIC(16,8) NOT NULL DEFAULT 0,
        client_order_id       TEXT,
        order_id              TEXT,
        filled_count          NUMERIC(12,2) NOT NULL DEFAULT 0,
        avg_fill_price        NUMERIC(12,8),
        limit_price           NUMERIC(8,4) NOT NULL,
        winning_contract_cost NUMERIC(12,8),
        status                TEXT NOT NULL DEFAULT 'submitting',
        error_message         TEXT,
        exchange_response_reason TEXT,
        settlement_result     TEXT,
        outcome               TEXT,
        pnl                   NUMERIC(16,8),
        incident_id           TEXT,
         entry_guard_evidence  JSONB,
        reconciliation_evidence JSONB,
        reconciled_at         TIMESTAMPTZ,
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

    // Reporting-only performance windows. One independently resettable
    // baseline per mode; no order, fill, incident, or reservation is mutated.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_scalp_performance_baselines (
        mode        TEXT PRIMARY KEY,
        baseline_at TIMESTAMPTZ NOT NULL,
        version     BIGINT NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT scalp_performance_baseline_mode
          CHECK (mode IN ('paper', 'live'))
      )
    `);
    await client.query(`
      ALTER TABLE kalshi_scalp_performance_baselines
      ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0
    `);
    await client.query(`
      INSERT INTO kalshi_scalp_performance_baselines (mode, baseline_at, updated_at)
      SELECT seed.mode,
             COALESCE(
               (SELECT MIN(o.created_at) FROM kalshi_scalp_orders o WHERE o.mode = seed.mode),
               NOW()
             ),
             NOW()
      FROM (VALUES ('paper'), ('live')) AS seed(mode)
      ON CONFLICT (mode) DO NOTHING
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
  // Additive nullable JSONB for structured skip diagnostics (idempotent).
  // Old rows without this column will have NULL here — fully backward compatible.
  await client.query(`ALTER TABLE kalshi_scalp_reservations ADD COLUMN IF NOT EXISTS skip_evidence   JSONB`);
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
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS client_order_id       TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS order_id              TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS filled_count          INTEGER`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS avg_fill_price        NUMERIC(8,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS budget_spent          NUMERIC(10,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS settlement_result     TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS outcome               TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS pnl                   NUMERIC(10,4)`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS incident_id           TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS entry_guard_evidence  JSONB`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS exchange_response_reason TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS reconciliation_evidence JSONB`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS layered_regular_position_id TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS layered_regular_side TEXT`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ADD COLUMN IF NOT EXISTS reconciled_at         TIMESTAMPTZ`);
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
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN filled_count TYPE NUMERIC(12,2) USING filled_count::numeric`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN avg_fill_price TYPE NUMERIC(12,8) USING avg_fill_price::numeric`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN winning_contract_cost TYPE NUMERIC(12,8) USING winning_contract_cost::numeric`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN budget_spent TYPE NUMERIC(16,8) USING budget_spent::numeric`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN pnl TYPE NUMERIC(16,8) USING pnl::numeric`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN budget_spent SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN budget_spent SET DEFAULT 0`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN created_at   SET NOT NULL`);
  await client.query(`ALTER TABLE kalshi_scalp_orders ALTER COLUMN created_at   SET DEFAULT NOW()`);
  await client.query(`CREATE INDEX IF NOT EXISTS scalp_orders_mode_created ON kalshi_scalp_orders (mode, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS scalp_orders_symbol_window ON kalshi_scalp_orders (symbol, window_key)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS scalp_orders_client_order_id_unique ON kalshi_scalp_orders (client_order_id) WHERE client_order_id IS NOT NULL`);

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
    if (res.rows.length === 0) {
      const defaults = { ...DEFAULT_SCALP_CONFIG };
      await client.query(
        `INSERT INTO kalshi_scalp_config (id, config, updated_at)
         VALUES ('singleton', $1, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(defaults)],
      );
      return defaults;
    }
    const raw = res.rows[0].config as Record<string, unknown>;
    const merged = mergeScalpConfig(DEFAULT_SCALP_CONFIG, raw);

    // Legacy production config allowed null ("no cap"). The Scalper now always
    // requires a finite aggregate open-exposure ceiling, so normalize and
    // persist the safe default before the scan loop can start.
    if (raw["openCapDollars"] !== merged.openCapDollars) {
      await client.query(
        `UPDATE kalshi_scalp_config
         SET config = $1, updated_at = NOW()
         WHERE id = 'singleton'`,
        [JSON.stringify(merged)],
      );
      logger.warn(
        {
          priorOpenCapDollars: raw["openCapDollars"] ?? null,
          openCapDollars: merged.openCapDollars,
        },
        "[kalshi-scalper] normalized mandatory open-exposure cap",
      );
    }
    return merged;
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
    // Daily cap remains operator-nullable; open exposure is always finite.
    dailyCapDollars: "dailyCapDollars" in raw
      ? (raw["dailyCapDollars"] === null ? null : typeof raw["dailyCapDollars"] === "number" ? raw["dailyCapDollars"] : defaults.dailyCapDollars)
      : defaults.dailyCapDollars,
    openCapDollars: normalizeScalpOpenCapDollars(raw["openCapDollars"]),
    freefallGuardEnabled: typeof raw["freefallGuardEnabled"] === "boolean" ? raw["freefallGuardEnabled"] : defaults.freefallGuardEnabled,
    freefallConsecutiveSeconds: typeof raw["freefallConsecutiveSeconds"] === "number" ? raw["freefallConsecutiveSeconds"] : defaults.freefallConsecutiveSeconds,
    favorableTrendConfirmationEnabled: typeof raw["favorableTrendConfirmationEnabled"] === "boolean"
      ? raw["favorableTrendConfirmationEnabled"]
      : defaults.favorableTrendConfirmationEnabled,
    coordinatedDirectionClearanceEnabled:
      typeof raw["coordinatedDirectionClearanceEnabled"] === "boolean"
        ? raw["coordinatedDirectionClearanceEnabled"]
        : defaults.coordinatedDirectionClearanceEnabled,
    freefallLookbackSeconds: typeof raw["freefallLookbackSeconds"] === "number" ? raw["freefallLookbackSeconds"] : defaults.freefallLookbackSeconds,
    freefallThresholdPct: typeof raw["freefallThresholdPct"] === "number" ? raw["freefallThresholdPct"] : defaults.freefallThresholdPct,
    rapidMoveGuardEnabled: typeof raw["rapidMoveGuardEnabled"] === "boolean" ? raw["rapidMoveGuardEnabled"] : defaults.rapidMoveGuardEnabled,
    rapidMoveLookbackSeconds: typeof raw["rapidMoveLookbackSeconds"] === "number" ? raw["rapidMoveLookbackSeconds"] : defaults.rapidMoveLookbackSeconds,
    rapidMoveThresholdPct: typeof raw["rapidMoveThresholdPct"] === "number" ? raw["rapidMoveThresholdPct"] : defaults.rapidMoveThresholdPct,
    targetProximityGuardEnabled: typeof raw["targetProximityGuardEnabled"] === "boolean" ? raw["targetProximityGuardEnabled"] : defaults.targetProximityGuardEnabled,
    targetProximityThresholdPct: typeof raw["targetProximityThresholdPct"] === "number" ? raw["targetProximityThresholdPct"] : defaults.targetProximityThresholdPct,
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
 *   0. pg_advisory_xact_lock(hashtext('kalshi-scalper-cap:' || mode))
 *   1. Final-window boundary check (closeTime + finalWindowSeconds).
 *      If the market is outside the effective final window, persist a terminal
 *      skipped reservation with timing evidence and return without reserving.
 *   2. INSERT reservation (reserved_budget=0) ON CONFLICT DO NOTHING RETURNING.
 *      On conflict, lock the existing row and apply the bounded retry policy.
 *      Only confirmed zero-fills and explicit no-exposure transient skips may be
 *      returned to `claimed`; terminal/unknown/in-flight rows stay blocked.
 *   3. Sum actual daily filled/paper spend + current reserved totals (this new
 *      row is still 0, so it never double-counts itself); and open unsettled
 *      spend + reserved totals.
 *   4. Compare each (total + requestedBudget) against the nullable daily cap
 *      and mandatory open cap.
 *      Blocked → UPDATE this reservation status='skipped', reason, reserved_budget=0;
 *      return {claimed:true, allowed:false}.
 *   5. Allowed → UPDATE this reservation reserved_budget=requestedBudget;
 *      return {claimed:true, allowed:true}.
 *
 * Cap denials remain terminal. Retryable outcomes retain the same durable row,
 * so restart safety and the UNIQUE(mode,symbol,window_key) serialization point
 * are preserved while allowing bounded re-attempts.
 *
 * @param closeTime         ISO close time for the market (used for final-window check)
 * @param finalWindowSeconds Effective per-market final window seconds (honors override)
 */
export async function claimReservationAndCap(
  id: string,
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  ticker: string,
  requestedBudget: number,
  dailyCapDollars: number | null,
  openCapDollars: number,
  closeTime?: string,
  finalWindowSeconds?: number,
): Promise<ClaimAndCapResult> {
  // Runtime callers compiled against the legacy nullable contract may still
  // pass null during a rolling deployment. Normalize at the atomic boundary so
  // malformed input can never restore the old unlimited-exposure behavior.
  const effectiveOpenCapDollars = normalizeScalpOpenCapDollars(openCapDollars);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Per-mode advisory lock — released automatically at COMMIT/ROLLBACK.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-cap:${mode}`],
    );

    // Enforce the effective per-market final-window boundary while holding the
    // same lock as the reservation claim. A denied candidate still gets a
    // durable skipped row so timing mistakes remain auditable after restart.
    if (closeTime != null && finalWindowSeconds != null) {
      const nowMs = Date.now();
      if (!isInFinalWindow(closeTime, nowMs, finalWindowSeconds, windowKey)) {
        const closeMs = new Date(closeTime).getTime();
        const evidence: ScalpSkipEvidence = {
          timingPhase: resolveTimingPhase(
            closeTime,
            nowMs,
            finalWindowSeconds,
            SCALP_PREFLIGHT_LEAD_SECONDS,
          ),
          closeTimeIso: closeTime,
          secondsRemaining: Number.isFinite(closeMs) ? (closeMs - nowMs) / 1_000 : null,
          effectiveWindowSeconds: finalWindowSeconds,
          windowKey,
          reservedTicker: ticker,
          skippedAt: new Date(nowMs).toISOString(),
          elapsedMs: 0,
        };
        const boundaryInsert = await client.query(
          `INSERT INTO kalshi_scalp_reservations
             (id, mode, symbol, window_key, ticker, status, reason, reserved_budget,
              skip_evidence, created_at, attempted_at)
           VALUES ($1, $2, $3, $4, $5, 'skipped', 'outside_window_at_claim', 0,
                   $6::jsonb, NOW(), NOW())
           ON CONFLICT (mode, symbol, window_key) DO NOTHING
           RETURNING id`,
          [id, mode, symbol.toUpperCase(), windowKey, ticker, JSON.stringify(evidence)],
        );
        let reservationId = boundaryInsert.rows[0]?.["id"] != null
          ? String(boundaryInsert.rows[0]["id"])
          : null;
        let submittedOrders = 0;
        if (reservationId == null) {
          const existing = await client.query(
            `SELECT r.id, r.status, r.reason, r.reserved_budget,
                    GREATEST(0, EXTRACT(EPOCH FROM (NOW() - r.attempted_at)) * 1000)::float AS elapsed_ms,
                    (SELECT COUNT(*)::int
                     FROM kalshi_scalp_orders o
                     WHERE o.mode = r.mode
                       AND o.symbol = r.symbol
                       AND o.window_key = r.window_key
                       AND o.status = 'zero_fill') AS submitted_orders
             FROM kalshi_scalp_reservations r
             WHERE r.mode = $1 AND r.symbol = $2 AND r.window_key = $3
             FOR UPDATE`,
            [mode, symbol.toUpperCase(), windowKey],
          );
          const existingRow = existing.rows[0];
          reservationId = existingRow?.["id"] != null
            ? String(existingRow["id"])
            : null;
          submittedOrders = Number(existingRow?.["submitted_orders"] ?? 0);
          if (reservationId != null) {
            const retry = evaluateScalpReservationRetry({
              status: String(existingRow["status"] ?? ""),
              reason: existingRow["reason"] != null ? String(existingRow["reason"]) : null,
              elapsedMs: Number(existingRow["elapsed_ms"] ?? 0),
              submittedOrders,
            });
            const hasNoReservedExposure = Number(existingRow["reserved_budget"] ?? 0) <= 0;
            if (!retry.terminal && hasNoReservedExposure) {
              await client.query(
                `UPDATE kalshi_scalp_reservations
                 SET status = 'skipped', reason = 'outside_window_at_claim',
                     reserved_budget = 0, ticker = $1,
                     skip_evidence = $2::jsonb, attempted_at = NOW()
                 WHERE id = $3`,
                [ticker, JSON.stringify(evidence), reservationId],
              );
            }
          }
        }
        await client.query("COMMIT");
        return {
          claimed: false,
          allowed: false,
          reason: "outside_window_at_claim",
          reservationId,
          submittedOrders,
          retryAfterMs: null,
          dailyCommitted: 0,
          openCommitted: 0,
        };
      }
    }

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
        `SELECT r.id, r.status, r.reason, r.reserved_budget,
                GREATEST(0, EXTRACT(EPOCH FROM (NOW() - r.attempted_at)) * 1000)::float AS elapsed_ms,
                (SELECT COUNT(*)::int
                 FROM kalshi_scalp_orders o
                 WHERE o.mode = r.mode
                   AND o.symbol = r.symbol
                   AND o.window_key = r.window_key
                   AND o.status = 'zero_fill') AS submitted_orders
         FROM kalshi_scalp_reservations r
         WHERE r.mode = $1 AND r.symbol = $2 AND r.window_key = $3
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
      submittedOrders = Number(existing["submitted_orders"] ?? 0);
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
             ticker = $1, skip_evidence = NULL, attempted_at = NOW()
         WHERE id = $2`,
        [ticker, reservationId],
      );
    }

    // Sum actual committed spend + reserved (this row is 0, safe from self-count).
    // A confirmed fill stops being open market exposure once its 15-minute
    // window has rolled over, even if Kalshi delays publishing settlement.
    // Indeterminate submissions and reservations remain fail-closed across
    // windows because we still do not know whether exchange exposure exists.
    const committedRes = await client.query(
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
               AND reserved_budget > 0) AS daily_total,
         (SELECT COALESCE(SUM(budget_spent), 0)::float
            FROM kalshi_scalp_orders
            WHERE mode = $1
              AND settlement_result IS NULL
               AND (
                 (status IN ('filled', 'paper') AND window_key = $2)
                 OR status IN ('submitting', 'unknown')
               ))
       + (SELECT COALESCE(SUM(reserved_budget), 0)::float
            FROM kalshi_scalp_reservations
            WHERE mode = $1
               AND reserved_budget > 0) AS open_total`,
      [mode, windowKey],
    );

    const dailyCommitted = Number(committedRes.rows[0]?.["daily_total"] ?? 0);
    const openCommitted = Number(committedRes.rows[0]?.["open_total"] ?? 0);

    // Daily remains nullable. Open exposure is mandatory and normalized before
    // entering this transaction, including for legacy runtime callers.
    let blockedReason: string | null = null;
    if (dailyCapDollars != null && dailyCommitted + requestedBudget > dailyCapDollars) {
      blockedReason = `daily_cap_exceeded (committed=${dailyCommitted.toFixed(2)} cap=${dailyCapDollars})`;
    } else if (openCommitted + requestedBudget > effectiveOpenCapDollars) {
      blockedReason = `open_cap_exceeded (open=${openCommitted.toFixed(2)} cap=${effectiveOpenCapDollars})`;
    }

    if (blockedReason) {
      // Persist cap denial as a terminal skip with no reserved budget.
      const capEvidence: ScalpSkipEvidence = {
        timingPhase: closeTime != null && finalWindowSeconds != null
          ? resolveTimingPhase(closeTime, Date.now(), finalWindowSeconds, SCALP_PREFLIGHT_LEAD_SECONDS)
          : undefined,
        closeTimeIso: closeTime,
        effectiveWindowSeconds: finalWindowSeconds,
        windowKey,
        reservedTicker: ticker,
        requestedBudget,
        dailyCapDollars,
        openCapDollars: effectiveOpenCapDollars,
        dailyCommittedDollars: dailyCommitted,
        openCommittedDollars: openCommitted,
        skippedAt: new Date().toISOString(),
      };
      await client.query(
        `UPDATE kalshi_scalp_reservations
         SET status = 'skipped', reason = $1, reserved_budget = 0,
             skip_evidence = $2::jsonb, attempted_at = NOW()
         WHERE id = $3`,
        [blockedReason, JSON.stringify(capEvidence), reservationId],
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
  skipEvidence?: ScalpSkipEvidence | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = $1, reason = $2, attempted_at = NOW(),
           skip_evidence = $3::jsonb
           ${releaseBudget ? ", reserved_budget = 0" : ""}
       WHERE mode = $4 AND symbol = $5 AND window_key = $6`,
      [
        status,
        reason ?? null,
        skipEvidence == null ? null : JSON.stringify(skipEvidence),
        mode,
        symbol.toUpperCase(),
        windowKey,
      ],
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
export async function getScalpCommittedTotals(
  mode: ScalpMode,
  activeWindowKey: string,
): Promise<{
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
               AND (
                 (status IN ('filled', 'paper') AND window_key = $2)
                 OR status IN ('submitting', 'unknown')
               ))
       + (SELECT COALESCE(SUM(reserved_budget), 0)::float
            FROM kalshi_scalp_reservations
            WHERE mode = $1
              AND reserved_budget > 0) AS open_committed`,
      [mode, activeWindowKey],
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
               r.reserved_budget, r.created_at, r.attempted_at, r.skip_evidence,
               latest_order.side AS latest_side,
               latest_order.entry_yes_price AS latest_entry_yes_price,
               latest_order.limit_price AS latest_limit_price,
                latest_order.layered_regular_position_id,
                latest_order.layered_regular_side,
               (SELECT COUNT(*)::int
                  FROM kalshi_scalp_orders o
                  WHERE o.mode = r.mode
                    AND o.symbol = r.symbol
                    AND o.window_key = r.window_key
                    AND o.status IN ('filled', 'zero_fill', 'submitting', 'unknown')) AS submission_count
       FROM kalshi_scalp_reservations r
       LEFT JOIN LATERAL (
          SELECT o.side, o.entry_yes_price, o.limit_price,
                 o.layered_regular_position_id, o.layered_regular_side
         FROM kalshi_scalp_orders o
         WHERE o.mode = r.mode
           AND o.symbol = r.symbol
           AND o.window_key = r.window_key
           AND (
             (r.mode = 'live' AND o.status IN ('filled', 'zero_fill'))
             OR (r.mode = 'paper' AND o.status = 'paper')
           )
         ORDER BY o.created_at DESC
         LIMIT 1
       ) latest_order ON TRUE
       ${where}
       ORDER BY r.attempted_at DESC
       LIMIT $${idx}`,
      params,
    );
    return res.rows.map((row) => {
      const latestSide = row["latest_side"] === "yes" || row["latest_side"] === "no"
        ? row["latest_side"] as "yes" | "no"
        : undefined;
      const entryYesPrice = row["latest_entry_yes_price"] != null
        ? Number(row["latest_entry_yes_price"])
        : null;
      const submittedLimitPrice = row["latest_limit_price"] != null
        ? Number(row["latest_limit_price"])
        : null;
      const observedWinningAsk = latestSide && entryYesPrice != null && Number.isFinite(entryYesPrice)
        ? (latestSide === "yes" ? entryYesPrice : 1 - entryYesPrice)
        : undefined;
      const executionWinningLimit = latestSide && submittedLimitPrice != null && Number.isFinite(submittedLimitPrice)
        ? (latestSide === "yes" ? submittedLimitPrice : 1 - submittedLimitPrice)
        : undefined;
      const mode = String(row["mode"]) as ScalpMode;
      const layeredRegularSide =
        row["layered_regular_side"] === "yes" || row["layered_regular_side"] === "no"
          ? row["layered_regular_side"] as "yes" | "no"
          : undefined;
      const rawSkipEvidence = row["skip_evidence"];
      const skipEvidence: ScalpSkipEvidence | null =
        rawSkipEvidence != null && typeof rawSkipEvidence === "object"
          ? rawSkipEvidence as ScalpSkipEvidence
          : null;
      return {
        id: String(row["id"]),
        mode,
        symbol: String(row["symbol"]),
        windowKey: String(row["window_key"]),
        ticker: String(row["ticker"]),
        status: String(row["status"]) as ScalpReservation["status"],
        reason: row["reason"] != null ? String(row["reason"]) : undefined,
        reservedBudget: Number(row["reserved_budget"] ?? 0),
        submissionCount: Number(row["submission_count"] ?? 0),
        latestSide,
        observedWinningAsk,
        executionWinningLimit,
        submittedLimitPrice: mode === "live" ? submittedLimitPrice ?? undefined : undefined,
        layeredRegularPositionId: row["layered_regular_position_id"] != null
          ? String(row["layered_regular_position_id"])
          : undefined,
        layeredRegularSide,
        skipEvidence,
        createdAt: row["created_at"] instanceof Date
          ? row["created_at"]
          : new Date(String(row["created_at"])),
        attemptedAt: row["attempted_at"] instanceof Date
          ? row["attempted_at"]
          : new Date(String(row["attempted_at"])),
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Record a funnel stage at most once per symbol/window. This is strictly
 * observability data: an insert failure must never change a trading outcome.
 */
export async function recordScalpFunnelEvent(
  mode: ScalpMode,
  windowKey: string,
  symbol: string,
  stage: ScalpFunnelEventStage,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO kalshi_scalp_funnel_events (mode, window_key, symbol, stage)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (mode, window_key, symbol, stage) DO NOTHING`,
      [mode, windowKey, symbol.toUpperCase(), stage],
    );
  } finally {
    client.release();
  }
}

/**
 * Read a bounded rolling window funnel. Reservation and order state remains
 * authoritative for safety blocks/submissions/fills; append-only events retain
 * candidate and quote-loss stages across safe retries.
 */
export async function getScalpWindowFunnelCounters(
  mode: ScalpMode,
  limit = 12,
): Promise<ScalpWindowFunnelCounters[]> {
  const client = await pool.connect();
  try {
    const cappedLimit = Math.max(1, Math.min(48, Math.floor(limit)));
    const res = await client.query(
      `WITH windows AS (
         SELECT window_key FROM kalshi_scalp_reservations WHERE mode = $1
         UNION
         SELECT window_key FROM kalshi_scalp_funnel_events WHERE mode = $1
       ),
       reservation_totals AS (
         SELECT window_key,
                COUNT(DISTINCT symbol)::int AS reservation_symbols,
                COUNT(*) FILTER (
                  WHERE status = 'skipped'
                    AND COALESCE(reason, '') NOT IN (
                      'final_quote_invalid', 'final_quote_outside_band',
                      'side_flipped_final_quote',
                      'final_requote_invalid', 'final_requote_outside_band',
                      'side_flipped_final_requote'
                    )
                )::int AS safety_blocks,
                MAX(attempted_at) AS last_activity_at
           FROM kalshi_scalp_reservations
          WHERE mode = $1
          GROUP BY window_key
       ),
       event_totals AS (
         SELECT window_key,
                COUNT(DISTINCT symbol) FILTER (WHERE stage = 'candidate')::int AS candidate_symbols,
                 COUNT(DISTINCT symbol) FILTER (WHERE stage = 'authenticated_eligible')::int AS eligible_quotes,
                COUNT(DISTINCT symbol) FILTER (WHERE stage = 'final_quote_loss')::int AS final_quote_loss,
                MAX(created_at) AS last_activity_at
           FROM kalshi_scalp_funnel_events
          WHERE mode = $1
          GROUP BY window_key
       ),
       order_totals AS (
         SELECT window_key,
                COUNT(*) FILTER (
                  WHERE status IN ('filled', 'paper', 'zero_fill', 'submitting', 'unknown')
                )::int AS submissions,
                COUNT(*) FILTER (WHERE status = 'zero_fill')::int AS zero_fills,
                COUNT(*) FILTER (
                  WHERE status IN ('filled', 'paper') AND filled_count > 0
                )::int AS confirmed_fills,
                MAX(created_at) AS last_activity_at
           FROM kalshi_scalp_orders
          WHERE mode = $1
          GROUP BY window_key
       )
       SELECT w.window_key,
              GREATEST(COALESCE(e.candidate_symbols, 0), COALESCE(r.reservation_symbols, 0))::int AS candidate_symbols,
               COALESCE(e.eligible_quotes, 0)::int AS eligible_quotes,
              COALESCE(e.final_quote_loss, 0)::int AS final_quote_loss,
              COALESCE(r.safety_blocks, 0)::int AS safety_blocks,
              COALESCE(o.submissions, 0)::int AS submissions,
              COALESCE(o.zero_fills, 0)::int AS zero_fills,
              COALESCE(o.confirmed_fills, 0)::int AS confirmed_fills,
              GREATEST(
                COALESCE(r.last_activity_at, '-infinity'::timestamptz),
                COALESCE(e.last_activity_at, '-infinity'::timestamptz),
                COALESCE(o.last_activity_at, '-infinity'::timestamptz)
              ) AS last_activity_at
         FROM windows w
         LEFT JOIN reservation_totals r ON r.window_key = w.window_key
         LEFT JOIN event_totals e ON e.window_key = w.window_key
         LEFT JOIN order_totals o ON o.window_key = w.window_key
        ORDER BY last_activity_at DESC
        LIMIT $2`,
      [mode, cappedLimit],
    );
    return res.rows.map((row) => ({
      windowKey: String(row["window_key"]),
      candidateSymbols: Number(row["candidate_symbols"] ?? 0),
      eligibleQuotes: Number(row["eligible_quotes"] ?? 0),
      finalQuoteLoss: Number(row["final_quote_loss"] ?? 0),
      safetyBlocks: Number(row["safety_blocks"] ?? 0),
      submissions: Number(row["submissions"] ?? 0),
      zeroFills: Number(row["zero_fills"] ?? 0),
      confirmedFills: Number(row["confirmed_fills"] ?? 0),
      lastActivityAt: row["last_activity_at"] instanceof Date
        ? row["last_activity_at"]
        : new Date(String(row["last_activity_at"])),
    }));
  } finally {
    client.release();
  }
}

function shadowDateIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function mapScalpShadowRow(row: Record<string, unknown>): ScalpShadowStudyRecord {
  const blockerCounts = row["blocker_counts"];
  const entryEvidence = row["entry_evidence"];
  return {
    mode: row["mode"] === "live" ? "live" : "paper",
    windowKey: String(row["window_key"]),
    symbol: String(row["symbol"]),
    ticker: String(row["ticker"]),
    variantSeconds: Number(row["variant_seconds"]) as ScalpShadowVariantSeconds,
    status: String(row["status"]) as ScalpShadowStudyRecord["status"],
    firstEligibleAt: shadowDateIso(row["first_eligible_at"]),
    firstSafeEntryAt: row["first_safe_entry_at"] == null
      ? null
      : shadowDateIso(row["first_safe_entry_at"]),
    firstSafeSecondsRemaining: row["first_safe_seconds_remaining"] == null
      ? null
      : Number(row["first_safe_seconds_remaining"]),
    side: row["side"] === "yes" || row["side"] === "no"
      ? row["side"]
      : null,
    yesAsk: row["yes_ask"] == null ? null : Number(row["yes_ask"]),
    noAsk: row["no_ask"] == null ? null : Number(row["no_ask"]),
    winningAsk: row["winning_ask"] == null
      ? null
      : Number(row["winning_ask"]),
    hypotheticalContracts: Number(row["hypothetical_contracts"] ?? 0),
    hypotheticalBudget: Number(row["hypothetical_budget"] ?? 0),
    lastBlocker: row["last_blocker"] == null
      ? null
      : String(row["last_blocker"]),
    blockerCounts: blockerCounts && typeof blockerCounts === "object"
      ? blockerCounts as Record<string, number>
      : {},
    entryEvidence: entryEvidence && typeof entryEvidence === "object"
      ? entryEvidence as Record<string, unknown>
      : null,
    laterQuoteIssueObserved: row["later_quote_issue_observed"] === true,
    laterQuoteIssueReason:
      row["later_quote_issue_reason"] === "invalid"
      || row["later_quote_issue_reason"] === "outside_band"
        ? row["later_quote_issue_reason"]
        : null,
    settlementResult:
      row["settlement_result"] === "yes"
      || row["settlement_result"] === "no"
        ? row["settlement_result"]
        : null,
    outcome: row["outcome"] === "win" || row["outcome"] === "loss"
      ? row["outcome"]
      : null,
    hypotheticalPnl: row["hypothetical_pnl"] == null
      ? null
      : Number(row["hypothetical_pnl"]),
    createdAt: shadowDateIso(row["created_at"]),
    updatedAt: shadowDateIso(row["updated_at"]),
    settledAt: row["settled_at"] == null
      ? null
      : shadowDateIso(row["settled_at"]),
  };
}

/**
 * Best-effort counterfactual upsert. It never joins or writes execution tables.
 * First-safe evidence is immutable once observed and settled rows never regress.
 */
export async function upsertScalpShadowStudy(
  record: ScalpShadowStudyRecord,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO kalshi_scalp_shadow_entries (
         mode, window_key, symbol, ticker, variant_seconds, status,
         first_eligible_at, first_safe_entry_at, first_safe_seconds_remaining,
         side, yes_ask, no_ask, winning_ask, hypothetical_contracts,
         hypothetical_budget, last_blocker, blocker_counts, entry_evidence,
         later_quote_issue_observed, later_quote_issue_reason,
         settlement_result, outcome, hypothetical_pnl,
         created_at, updated_at, settled_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,$26
       )
       ON CONFLICT (mode, window_key, symbol, variant_seconds) DO UPDATE SET
         ticker = EXCLUDED.ticker,
         status = CASE
           WHEN kalshi_scalp_shadow_entries.status = 'settled'
             THEN kalshi_scalp_shadow_entries.status
           ELSE EXCLUDED.status
         END,
         first_safe_entry_at = COALESCE(
           kalshi_scalp_shadow_entries.first_safe_entry_at,
           EXCLUDED.first_safe_entry_at
         ),
         first_safe_seconds_remaining = COALESCE(
           kalshi_scalp_shadow_entries.first_safe_seconds_remaining,
           EXCLUDED.first_safe_seconds_remaining
         ),
         side = COALESCE(kalshi_scalp_shadow_entries.side, EXCLUDED.side),
         yes_ask = COALESCE(kalshi_scalp_shadow_entries.yes_ask, EXCLUDED.yes_ask),
         no_ask = COALESCE(kalshi_scalp_shadow_entries.no_ask, EXCLUDED.no_ask),
         winning_ask = COALESCE(
           kalshi_scalp_shadow_entries.winning_ask,
           EXCLUDED.winning_ask
         ),
         hypothetical_contracts = GREATEST(
           kalshi_scalp_shadow_entries.hypothetical_contracts,
           EXCLUDED.hypothetical_contracts
         ),
         hypothetical_budget = GREATEST(
           kalshi_scalp_shadow_entries.hypothetical_budget,
           EXCLUDED.hypothetical_budget
         ),
         last_blocker = EXCLUDED.last_blocker,
         blocker_counts = EXCLUDED.blocker_counts,
         entry_evidence = COALESCE(
           kalshi_scalp_shadow_entries.entry_evidence,
           EXCLUDED.entry_evidence
         ),
         later_quote_issue_observed = (
           kalshi_scalp_shadow_entries.later_quote_issue_observed
           OR EXCLUDED.later_quote_issue_observed
         ),
         later_quote_issue_reason = COALESCE(
           kalshi_scalp_shadow_entries.later_quote_issue_reason,
           EXCLUDED.later_quote_issue_reason
         ),
         settlement_result = COALESCE(
           kalshi_scalp_shadow_entries.settlement_result,
           EXCLUDED.settlement_result
         ),
         outcome = COALESCE(
           kalshi_scalp_shadow_entries.outcome,
           EXCLUDED.outcome
         ),
         hypothetical_pnl = COALESCE(
           kalshi_scalp_shadow_entries.hypothetical_pnl,
           EXCLUDED.hypothetical_pnl
         ),
         updated_at = GREATEST(
           kalshi_scalp_shadow_entries.updated_at,
           EXCLUDED.updated_at
         ),
         settled_at = COALESCE(
           kalshi_scalp_shadow_entries.settled_at,
           EXCLUDED.settled_at
         )`,
      [
        record.mode,
        record.windowKey,
        record.symbol.toUpperCase(),
        record.ticker,
        record.variantSeconds,
        record.status,
        record.firstEligibleAt,
        record.firstSafeEntryAt,
        record.firstSafeSecondsRemaining,
        record.side,
        record.yesAsk,
        record.noAsk,
        record.winningAsk,
        record.hypotheticalContracts,
        record.hypotheticalBudget,
        record.lastBlocker,
        JSON.stringify(record.blockerCounts),
        record.entryEvidence == null
          ? null
          : JSON.stringify(record.entryEvidence),
        record.laterQuoteIssueObserved,
        record.laterQuoteIssueReason,
        record.settlementResult,
        record.outcome,
        record.hypotheticalPnl,
        record.createdAt,
        record.updatedAt,
        record.settledAt,
      ],
    );
  } finally {
    client.release();
  }
}

export async function getRecentScalpShadowStudies(
  mode: ScalpMode,
  limit = 72,
): Promise<ScalpShadowStudyRecord[]> {
  const client = await pool.connect();
  try {
    const capped = Math.max(1, Math.min(240, Math.floor(limit)));
    const result = await client.query(
      `SELECT *
         FROM kalshi_scalp_shadow_entries
        WHERE mode = $1
        ORDER BY first_eligible_at DESC, symbol, variant_seconds DESC
        LIMIT $2`,
      [mode, capped],
    );
    return result.rows.map((row) =>
      mapScalpShadowRow(row as Record<string, unknown>)
    );
  } finally {
    client.release();
  }
}

export async function getUnsettledScalpShadowStudies(
  limit = 36,
): Promise<ScalpShadowStudyRecord[]> {
  const client = await pool.connect();
  try {
    const capped = Math.max(1, Math.min(120, Math.floor(limit)));
    const result = await client.query(
      `SELECT *
         FROM kalshi_scalp_shadow_entries
        WHERE first_safe_entry_at IS NOT NULL
          AND settlement_result IS NULL
          AND first_eligible_at
              + variant_seconds * INTERVAL '1 second'
              < NOW() - INTERVAL '45 seconds'
        ORDER BY first_eligible_at ASC
        LIMIT $1`,
      [capped],
    );
    return result.rows.map((row) =>
      mapScalpShadowRow(row as Record<string, unknown>)
    );
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
  layeredRegularPositionId?: string | null;
  layeredRegularSide?: "yes" | "no" | null;
  entryGuardEvidence?: ScalpEntryGuardEvidence | null;
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
            order_id = COALESCE($6, order_id), error_message = NULL,
            layered_regular_position_id = $7,
            layered_regular_side = $8,
            entry_guard_evidence = COALESCE($9::jsonb, entry_guard_evidence)
        WHERE id = $10`,
      [
        params.status, params.filledCount, params.avgFillPrice ?? null,
        params.winningContractCost ?? null, params.budgetSpent,
        params.exchangeOrderId ?? null,
        params.layeredRegularPositionId ?? null,
        params.layeredRegularSide ?? null,
        params.entryGuardEvidence == null
          ? null
          : JSON.stringify(params.entryGuardEvidence),
        params.orderId,
      ],
    );
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = $1, reason = $2, reserved_budget = 0,
           skip_evidence = NULL, attempted_at = NOW()
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
  skipEvidence?: ScalpSkipEvidence | null;
  entryGuardEvidence?: ScalpEntryGuardEvidence | null;
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
       SET status = 'skipped', error_message = $1,
           entry_guard_evidence = COALESCE($2::jsonb, entry_guard_evidence)
       WHERE id = $3`,
      [
        params.reason,
        params.entryGuardEvidence == null
          ? null
          : JSON.stringify(params.entryGuardEvidence),
        params.orderId,
      ],
    );
    // Release the reservation — no broker exposure exists.
    await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = 'skipped', reason = $1, reserved_budget = 0,
           skip_evidence = $2::jsonb, attempted_at = NOW()
       WHERE mode = $3 AND symbol = $4 AND window_key = $5`,
      [
        params.reason,
        params.skipEvidence == null ? null : JSON.stringify(params.skipEvidence),
        params.mode,
        params.symbol.toUpperCase(),
        params.windowKey,
      ],
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
  attemptId: string;
  orderRecordId: string | null;
  reservationId: string | null;
  mode: "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  status: string;
  side: "yes" | "no" | null;
  contractCount: number | null;
  limitPrice: number | null;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  reason: string | null;
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
      `SELECT COUNT(*)::int AS cnt
       FROM (
         SELECT mode, symbol, window_key
           FROM kalshi_scalp_orders
          WHERE mode = 'live' AND status IN ('submitting','unknown')
         UNION
         SELECT mode, symbol, window_key
           FROM kalshi_scalp_reservations
          WHERE mode = 'live'
            AND (status = 'unknown' OR (reserved_budget > 0 AND status = 'claimed'))
       ) unresolved_attempts`,
    );
    return Number(res.rows[0]?.cnt ?? 0);
  } finally {
    client.release();
  }
}

export async function getUnresolvedLiveAttempts(): Promise<UnresolvedLiveRow[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `WITH unresolved_orders AS (
         SELECT o.*
           FROM kalshi_scalp_orders o
          WHERE o.mode = 'live' AND o.status IN ('submitting','unknown')
       ),
       reservation_only AS (
         SELECT r.*
           FROM kalshi_scalp_reservations r
          WHERE r.mode = 'live'
            AND (r.status = 'unknown' OR (r.reserved_budget > 0 AND r.status = 'claimed'))
            AND NOT EXISTS (
              SELECT 1 FROM unresolved_orders o
               WHERE o.mode = r.mode AND o.symbol = r.symbol AND o.window_key = r.window_key
            )
       )
       SELECT
         o.mode, o.symbol, o.window_key,
         COALESCE(o.ticker, r.ticker, '') AS ticker,
         COALESCE(o.status, r.status, 'unknown') AS status,
         o.id AS order_record_id,
         r.id AS reservation_id,
         o.side, o.contract_count, o.limit_price, o.client_order_id,
         o.order_id AS exchange_order_id,
         COALESCE(o.exchange_response_reason, o.error_message, r.reason) AS reason,
         COALESCE(r.reserved_budget, 0) AS reserved_budget,
         COALESCE(o.created_at, r.created_at) AS created_at
       FROM unresolved_orders o
       LEFT JOIN kalshi_scalp_reservations r
         ON r.mode = o.mode AND r.symbol = o.symbol AND r.window_key = o.window_key
       UNION ALL
       SELECT
         r.mode, r.symbol, r.window_key, r.ticker, r.status,
         NULL AS order_record_id, r.id AS reservation_id,
         NULL AS side, NULL AS contract_count, NULL AS limit_price, NULL AS client_order_id,
         NULL AS exchange_order_id, r.reason, r.reserved_budget, r.created_at
       FROM reservation_only r
       ORDER BY created_at ASC`,
    );
    return res.rows.map((r) => ({
      attemptId: `live:${String(r["symbol"])}:${String(r["window_key"])}`,
      orderRecordId: r["order_record_id"] != null ? String(r["order_record_id"]) : null,
      reservationId: r["reservation_id"] != null ? String(r["reservation_id"]) : null,
      mode: "live",
      symbol: String(r["symbol"]),
      windowKey: String(r["window_key"]),
      ticker: String(r["ticker"]),
      status: String(r["status"]),
      side: r["side"] === "yes" || r["side"] === "no" ? r["side"] : null,
      contractCount: r["contract_count"] != null ? Number(r["contract_count"]) : null,
      limitPrice: r["limit_price"] != null ? Number(r["limit_price"]) : null,
      clientOrderId: r["client_order_id"] != null ? String(r["client_order_id"]) : null,
      exchangeOrderId: r["exchange_order_id"] != null ? String(r["exchange_order_id"]) : null,
      reason: r["reason"] != null ? String(r["reason"]) : null,
      reservedBudget: Number(r["reserved_budget"] ?? 0),
      createdAt: r["created_at"] instanceof Date ? r["created_at"] : new Date(String(r["created_at"])),
    }));
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

export async function getOpenScalpSpend(
  mode: ScalpMode,
  activeWindowKey: string,
): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT COALESCE(SUM(budget_spent), 0)::float AS total
       FROM kalshi_scalp_orders
       WHERE mode = $1
         AND settlement_result IS NULL
          AND window_key = $2
         AND status IN ('filled', 'paper')`,
      [mode, activeWindowKey],
    );
    return Number(res.rows[0]?.total ?? 0);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Order persistence
// ---------------------------------------------------------------------------

type ScalpDbClient = Awaited<ReturnType<typeof pool.connect>>;

async function _insertScalpOrder(client: ScalpDbClient, order: ScalpOrder): Promise<void> {
  await client.query(
      `INSERT INTO kalshi_scalp_orders
          (id, mode, symbol, window_key, ticker, side, entry_yes_price,
           contract_count, budget_spent, client_order_id, order_id, filled_count,
           avg_fill_price, limit_price, winning_contract_cost, status, error_message,
           exchange_response_reason, settlement_result, outcome, pnl, incident_id,
            entry_guard_evidence, reconciliation_evidence, reconciled_at,
            layered_regular_position_id, layered_regular_side, created_at, settled_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       ON CONFLICT (id) DO NOTHING`,
      [
        order.id, order.mode, order.symbol.toUpperCase(), order.windowKey,
        order.ticker, order.side, order.entryYesPrice, order.contractCount,
        order.budgetSpent, order.clientOrderId ?? null, order.orderId, order.filledCount,
        order.avgFillPrice ?? null, order.limitPrice,
        order.winningContractCost ?? null,
        order.status, order.errorMessage ?? null,
        order.exchangeResponseReason ?? null, order.settlementResult ?? null,
        order.outcome ?? null, order.pnl ?? null, order.incidentId ?? null,
        order.entryGuardEvidence == null ? null : JSON.stringify(order.entryGuardEvidence),
        order.reconciliationEvidence ?? null, order.reconciledAt ?? null,
        order.layeredRegularPositionId ?? null, order.layeredRegularSide ?? null,
        order.createdAt, order.settledAt ?? null,
      ],
  );
}

/** Persist a "submitting" intent record BEFORE the live placeOrder call. */
export async function insertScalpOrderIntent(order: ScalpOrder): Promise<void> {
  const client = await pool.connect();
  try {
    await _insertScalpOrder(client, order);
  } finally {
    client.release();
  }
}

/**
 * ATOMIC paper outcome persistence. Paper has no broker call or pre-existing
 * intent row, so its finalized order and reservation release must commit
 * together or fail together.
 */
export async function finalizePaperOrderAndReleaseReservation(
  order: ScalpOrder,
  reservationStatus: "filled" | "zero_fill",
  reason: string | null,
): Promise<void> {
  if (order.mode !== "paper" || !["paper", "zero_fill"].includes(order.status)) {
    throw new Error("Invalid paper Scalper finalization");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-cap:${order.mode}`],
    );
    await _insertScalpOrder(client, order);
    const updated = await client.query(
      `UPDATE kalshi_scalp_reservations
       SET status = $1, reason = $2, reserved_budget = 0,
           skip_evidence = NULL, attempted_at = NOW()
       WHERE mode = $3 AND symbol = $4 AND window_key = $5`,
      [
        reservationStatus,
        reason,
        order.mode,
        order.symbol.toUpperCase(),
        order.windowKey,
      ],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new Error("Paper Scalper reservation was not found during finalization");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
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
  exchangeResponseReason: string | null = null,
  entryGuardEvidence: ScalpEntryGuardEvidence | null = null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE kalshi_scalp_orders
       SET status = $1, filled_count = $2, avg_fill_price = $3,
           winning_contract_cost = $4, budget_spent = $5,
            order_id = COALESCE($6, order_id), error_message = $7,
            exchange_response_reason = COALESCE($8, exchange_response_reason),
            entry_guard_evidence = COALESCE($9::jsonb, entry_guard_evidence)
        WHERE id = $10`,
      [status, filledCount, avgFillPrice ?? null, winningContractCost ?? null,
       budgetSpent, orderId ?? null, errorMessage ?? null,
       exchangeResponseReason ?? null,
       entryGuardEvidence == null ? null : JSON.stringify(entryGuardEvidence),
       id],
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

/** All orders whose entry intent was created inside the active reporting
 * window. This intentionally filters on created_at, never settled_at, so an
 * order opened before a reset cannot re-enter the metrics when it settles. */
export async function getScalpOrdersForPerformance(
  mode: ScalpMode,
  trackingSince: Date,
): Promise<ScalpOrder[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT * FROM kalshi_scalp_orders
       WHERE mode = $1 AND created_at >= $2
       ORDER BY created_at DESC`,
      [mode, trackingSince],
    );
    return res.rows.map(rowToScalpOrder);
  } finally {
    client.release();
  }
}

/** Read the durable reporting baseline for one execution mode. Migrations seed
 * both rows while preserving existing all-time metrics. */
export async function getScalpPerformanceBaseline(mode: ScalpMode): Promise<{
  trackingSince: Date;
  trackingVersion: number;
}> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT baseline_at, version
       FROM kalshi_scalp_performance_baselines
       WHERE mode = $1`,
      [mode],
    );
    const value = res.rows[0]?.["baseline_at"];
    if (value == null) {
      throw new Error(`Missing Scalper performance baseline for ${mode} mode`);
    }
    return {
      trackingSince: value instanceof Date ? value : new Date(String(value)),
      trackingVersion: Number(res.rows[0]?.["version"] ?? 0),
    };
  } finally {
    client.release();
  }
}

/** Atomically start and read a fresh reporting window for exactly one mode.
 * The transaction-scoped advisory lock serializes concurrent resets through
 * the order read, while version lets clients reject out-of-order responses. */
export async function resetScalpPerformanceWindow(mode: ScalpMode): Promise<{
  trackingSince: Date;
  trackingVersion: number;
  orders: ScalpOrder[];
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-performance-reset:${mode}`],
    );
    const res = await client.query(
      `INSERT INTO kalshi_scalp_performance_baselines
         (mode, baseline_at, version, updated_at)
       VALUES ($1, clock_timestamp(), 1, clock_timestamp())
       ON CONFLICT (mode) DO UPDATE
         SET baseline_at = EXCLUDED.baseline_at,
             version = kalshi_scalp_performance_baselines.version + 1,
             updated_at = EXCLUDED.updated_at
       RETURNING baseline_at, version`,
      [mode],
    );
    const value = res.rows[0]?.["baseline_at"];
    if (value == null) {
      throw new Error(`Failed to reset Scalper performance baseline for ${mode} mode`);
    }
    const trackingSince = value instanceof Date ? value : new Date(String(value));
    const trackingVersion = Number(res.rows[0]?.["version"] ?? 0);
    const orders = await client.query(
      `SELECT * FROM kalshi_scalp_orders
       WHERE mode = $1 AND created_at >= $2
       ORDER BY created_at DESC`,
      [mode, trackingSince],
    );
    await client.query("COMMIT");
    return {
      trackingSince,
      trackingVersion,
      orders: orders.rows.map(rowToScalpOrder),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getScalpOrderById(id: string): Promise<ScalpOrder | null> {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT * FROM kalshi_scalp_orders WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] ? rowToScalpOrder(res.rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function getSiblingScalpExchangeOrderIds(
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  excludeRecordId: string,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT order_id FROM kalshi_scalp_orders
        WHERE mode = $1 AND symbol = $2 AND window_key = $3
          AND id <> $4 AND order_id IS NOT NULL`,
      [mode, symbol.toUpperCase(), windowKey, excludeRecordId],
    );
    return res.rows.map((r) => String(r["order_id"]));
  } finally {
    client.release();
  }
}

export async function reconcileScalpOrderAndReleaseReservation(params: {
  orderRecordId: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  status: "filled" | "zero_fill";
  filledCount: number;
  avgFillPrice: number | null;
  winningContractCost: number | null;
  budgetSpent: number;
  exchangeOrderId: string | null;
  exchangeResponseReason: string;
  evidence: Record<string, unknown>;
  entryGuardEvidence?: ScalpEntryGuardEvidence | null;
  layeredRegularPositionId?: string | null;
  layeredRegularSide?: "yes" | "no" | null;
  incident?: ScalpIncident | null;
}): Promise<"resolved" | "resolved_held" | "already_resolved"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`kalshi-scalper-cap:${params.mode}`],
    );
    const updated = await client.query(
      `UPDATE kalshi_scalp_orders
          SET status = $1, filled_count = $2, avg_fill_price = $3,
              winning_contract_cost = $4, budget_spent = $5,
              order_id = COALESCE($6, order_id),
              error_message = NULL, exchange_response_reason = $7,
              reconciliation_evidence = $8::jsonb,
              incident_id = COALESCE($9, incident_id),
               layered_regular_position_id = $10,
               layered_regular_side = $11,
               entry_guard_evidence = COALESCE($12::jsonb, entry_guard_evidence),
              reconciled_at = NOW()
        WHERE id = $13 AND status IN ('submitting','unknown')`,
      [
        params.status, params.filledCount, params.avgFillPrice,
        params.winningContractCost, params.budgetSpent,
        params.exchangeOrderId, params.exchangeResponseReason,
        JSON.stringify(params.evidence), params.incident?.id ?? null,
        params.layeredRegularPositionId ?? null,
        params.layeredRegularSide ?? null,
        params.entryGuardEvidence == null
          ? null
          : JSON.stringify(params.entryGuardEvidence),
        params.orderRecordId,
      ],
    ) as { rowCount?: number };
    if ((updated.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return "already_resolved";
    }
    if (params.incident) {
      const incident = params.incident;
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
    }
    const remaining = await client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM kalshi_scalp_orders
        WHERE mode = $1 AND symbol = $2 AND window_key = $3
          AND status IN ('submitting','unknown')`,
      [params.mode, params.symbol.toUpperCase(), params.windowKey],
    );
    const remainingCount = Number(remaining.rows[0]?.cnt ?? 0);
    if (remainingCount === 0) {
      const aggregate = await client.query(
        `SELECT COALESCE(BOOL_OR(status = 'filled'), false) AS has_fill
           FROM kalshi_scalp_orders
          WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [params.mode, params.symbol.toUpperCase(), params.windowKey],
      );
      const hasFill = aggregate.rows[0]?.has_fill === true;
      const reservationStatus = hasFill ? "filled" : "zero_fill";
      const reservationReason = hasFill
        ? "reconciled_attempt_contains_fill"
        : params.exchangeResponseReason;
      await client.query(
        `UPDATE kalshi_scalp_reservations
            SET status = $1, reason = $2, reserved_budget = 0, attempted_at = NOW()
          WHERE mode = $3 AND symbol = $4 AND window_key = $5`,
        [
          reservationStatus, reservationReason,
          params.mode, params.symbol.toUpperCase(), params.windowKey,
        ],
      );
    } else {
      await client.query(
        `UPDATE kalshi_scalp_reservations
            SET status = 'unknown',
                reason = 'other_unresolved_order_records_remain',
                attempted_at = NOW()
          WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [params.mode, params.symbol.toUpperCase(), params.windowKey],
      );
    }
    await client.query("COMMIT");
    return remainingCount === 0 ? "resolved" : "resolved_held";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
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
    clientOrderId: row["client_order_id"] != null ? String(row["client_order_id"]) : null,
    orderId: row["order_id"] != null ? String(row["order_id"]) : null,
    exchangeResponseReason: row["exchange_response_reason"] != null ? String(row["exchange_response_reason"]) : null,
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
    entryGuardEvidence:
      row["entry_guard_evidence"] != null
      && typeof row["entry_guard_evidence"] === "object"
        ? row["entry_guard_evidence"] as ScalpOrder["entryGuardEvidence"]
        : null,
    reconciledAt: row["reconciled_at"] != null
      ? (row["reconciled_at"] instanceof Date ? row["reconciled_at"] : new Date(String(row["reconciled_at"])))
      : null,
    reconciliationEvidence: row["reconciliation_evidence"] != null && typeof row["reconciliation_evidence"] === "object"
      ? row["reconciliation_evidence"] as Record<string, unknown>
      : null,
    layeredRegularPositionId: row["layered_regular_position_id"] != null
      ? String(row["layered_regular_position_id"])
      : null,
    layeredRegularSide: row["layered_regular_side"] === "yes" || row["layered_regular_side"] === "no"
      ? row["layered_regular_side"]
      : null,
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
      severity: row["severity"] === "info" ? "info" as const : "high" as const,
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
