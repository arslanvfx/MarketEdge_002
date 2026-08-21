// ---------------------------------------------------------------------------
// kalshi-scalper-db.test.ts — DB-level concurrency tests for the atomic
// claim-and-cap transaction. Guarded by DATABASE_URL: when it's not set (e.g.
// pure unit CI), the whole suite is skipped so `node --test` still passes.
//
// Run with a live Postgres:  DATABASE_URL=postgres://... node --experimental-strip-types --test
// ---------------------------------------------------------------------------

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// Requires BOTH a DATABASE_URL and an explicit opt-in, because the
// @workspace/db package uses directory ESM imports that the bare
// `node --experimental-strip-types --test` runner cannot resolve. Run this
// suite through the app's bundler/tsx tooling with SCALPER_DB_TEST=1 set.
const RUN_DB_TESTS = !!process.env["DATABASE_URL"] && process.env["SCALPER_DB_TEST"] === "1";

// Top-level, guarded pool teardown. This runs AFTER both describes below (node
// runs same-file top-level `after` hooks last), so the shared @workspace/db pool
// singleton is ended exactly once — never between the two describes. Guarded by
// RUN_DB_TESTS so the standard unit run (no DATABASE_URL) never imports the pool.
// If the bundler/runner still holds a handle open, force-exit remains acceptable
// for the one-shot validation run.
if (RUN_DB_TESTS) {
  after(async () => {
    try {
      const dbmod = await import("@workspace/db");
      const p = dbmod.pool as { end?: () => Promise<void> } | undefined;
      if (p && typeof p.end === "function") await p.end();
    } catch {
      // best-effort teardown; force-exit is acceptable for the validation run.
    }
  });
}

// node:test honors `skip` on the describe options.
describe("claimReservationAndCap (DB concurrency)", { skip: !RUN_DB_TESTS ? "set SCALPER_DB_TEST=1 with DATABASE_URL" : false }, () => {
  let db: typeof import("./kalshi-scalper-db.ts");
  let pool: {
    connect: () => Promise<{
      query: (
        sql: string,
        params?: readonly unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
      release: () => void;
    }>;
  };
  const MODE = "paper" as const; // paper keeps it isolated from any live rows

  // Remove EVERY DBTEST-* row this suite could have created, scoped to paper mode
  // so it can never touch live/production rows. Orders (child) are deleted before
  // reservations (parent) in case of FK ordering; incidents are cleared too. This
  // runs before each test to prevent cross-test contamination (a leaked $2 paper
  // reservation would otherwise consume cap/open-cap headroom in later tests).
  async function cleanupDbTestRows(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(
        `DELETE FROM kalshi_scalp_orders WHERE mode = '${MODE}' AND window_key LIKE 'DBTEST-%'`,
      );
      await c.query(
        `DELETE FROM kalshi_scalp_incidents WHERE mode = '${MODE}' AND window_key LIKE 'DBTEST-%'`,
      );
      await c.query(
        `DELETE FROM kalshi_scalp_reservations WHERE mode = '${MODE}' AND window_key LIKE 'DBTEST-%'`,
      );
    } finally {
      c.release();
    }
  }

  before(async () => {
    db = await import("./kalshi-scalper-db.ts");
    const dbmod = await import("@workspace/db");
    pool = dbmod.pool as typeof pool;
    await db.runScalpMigrations();
  });

  // Isolate every test: clear any leaked paper DBTEST-* rows beforehand.
  beforeEach(async () => {
    await cleanupDbTestRows();
  });

  // Retain the after cleanup so the suite leaves no DBTEST-* rows behind.
  after(async () => {
    await cleanupDbTestRows();
  });

  it("duplicate (mode,symbol,windowKey) is claimed only once", async () => {
    const wk = `DBTEST-dup-${Date.now()}`;
    const r1 = await db.claimReservationAndCap("id-a-" + wk, MODE, "BTC", wk, "T", 2, null, null);
    const r2 = await db.claimReservationAndCap("id-b-" + wk, MODE, "BTC", wk, "T", 2, null, null);
    assert.equal(r1.claimed, true);
    assert.equal(r1.allowed, true);
    assert.equal(r2.claimed, false);
    assert.equal(r2.reason, "terminal");
  });

  it("concurrent distinct claims respect the daily cap exactly (no double-add, no over-admit)", async () => {
    const base = `DBTEST-cap-${Date.now()}`;
    const budget = 2;
    const dailyCap = 6; // only 3 attempts of $2 should be allowed
    const N = 8;

    // Fire N distinct-window claims concurrently.
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        db.claimReservationAndCap(
          `id-${base}-${i}`, MODE, "ETH", `${base}-${i}`, "T", budget, dailyCap, null,
        ),
      ),
    );

    const allowed = results.filter((r) => r.claimed && r.allowed).length;
    const denied = results.filter((r) => r.claimed && !r.allowed).length;

    // Exactly floor(cap / budget) = 3 admitted; the rest cap-denied.
    assert.equal(allowed, Math.floor(dailyCap / budget), `expected 3 allowed, got ${allowed}`);
    assert.equal(allowed + denied, N, "every distinct claim must persist a durable outcome");

    // Denied rows persist as 'skipped' with reserved_budget=0 → re-claim still duplicate.
    const reAttempt = await db.claimReservationAndCap(
      `id-re-${base}`, MODE, "ETH", `${base}-0`, "T", budget, dailyCap, null,
    );
    assert.equal(reAttempt.claimed, false, "re-claiming an existing window must be duplicate");
  });

  it("open cap includes outstanding reserved budget", async () => {
    const base = `DBTEST-open-${Date.now()}`;
    const budget = 3;
    const openCap = 5; // only one $3 attempt fits; second (3+3=6>5) blocked
    const r1 = await db.claimReservationAndCap(`id-${base}-1`, MODE, "SOL", `${base}-1`, "T", budget, null, openCap);
    const r2 = await db.claimReservationAndCap(`id-${base}-2`, MODE, "SOL", `${base}-2`, "T", budget, null, openCap);
    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, false);
    assert.ok(r2.reason?.includes("open_cap_exceeded"));
  });

  it("releasing reserved budget frees open-cap headroom", async () => {
    const base = `DBTEST-release-${Date.now()}`;
    const budget = 3;
    const openCap = 5;
    const r1 = await db.claimReservationAndCap(`id-${base}-1`, MODE, "XRP", `${base}-1`, "T", budget, null, openCap);
    assert.equal(r1.allowed, true);
    // Release r1's budget (definite skip/zero-fill path).
    await db.updateReservationStatus(MODE, "XRP", `${base}-1`, "skipped", "test_release", true);
    // Now a new window should fit again.
    const r2 = await db.claimReservationAndCap(`id-${base}-2`, MODE, "XRP", `${base}-2`, "T", budget, null, openCap);
    assert.equal(r2.allowed, true, "headroom must be freed after release");
  });

  it("atomically re-claims a transient no-order skip after its cooldown", async () => {
    const wk = `DBTEST-rearm-${Date.now()}`;
    const first = await db.claimReservationAndCap(`id-${wk}`, MODE, "BTC", wk, "T", 2, null, null);
    assert.equal(first.allowed, true);
    await db.updateReservationStatus(MODE, "BTC", wk, "skipped", "final_quote_outside_band", true);

    const cooling = await db.claimReservationAndCap(`id-cooling-${wk}`, MODE, "BTC", wk, "T", 2, null, null);
    assert.equal(cooling.claimed, false);
    assert.equal(cooling.reason, "retry_cooldown");
    assert.ok((cooling.retryAfterMs ?? 0) > 0);

    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE kalshi_scalp_reservations
         SET attempted_at = NOW() - INTERVAL '2 seconds'
         WHERE mode = '${MODE}' AND window_key = '${wk}'`,
      );
    } finally {
      c.release();
    }

    const retried = await db.claimReservationAndCap(`id-retry-${wk}`, MODE, "BTC", wk, "T", 2, null, null);
    assert.equal(retried.claimed, true);
    assert.equal(retried.allowed, true);
    assert.equal(retried.reservationId, first.reservationId);
  });

  it("persists cap denial on the existing durable row during a re-claim", async () => {
    const wk = `DBTEST-rearm-cap-${Date.now()}`;
    const first = await db.claimReservationAndCap(
      `id-${wk}`, MODE, "BTC", wk, "T", 2, null, null,
    );
    assert.equal(first.allowed, true);
    await db.updateReservationStatus(
      MODE, "BTC", wk, "skipped", "final_quote_outside_band", true,
    );

    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE kalshi_scalp_reservations
         SET attempted_at = NOW() - INTERVAL '2 seconds'
         WHERE mode = $1 AND window_key = $2`,
        [MODE, wk],
      );
    } finally {
      c.release();
    }

    const denied = await db.claimReservationAndCap(
      `new-id-${wk}`, MODE, "BTC", wk, "T", 2, 1, null,
    );
    assert.equal(denied.claimed, true);
    assert.equal(denied.allowed, false);
    assert.equal(denied.reservationId, first.reservationId);
    assert.match(denied.reason ?? "", /daily_cap_exceeded/);

    const verify = await pool.connect();
    try {
      const row = await verify.query(
        `SELECT id, status, reason, reserved_budget
         FROM kalshi_scalp_reservations
         WHERE mode = $1 AND window_key = $2`,
        [MODE, wk],
      );
      assert.equal(row.rows[0]?.id, first.reservationId);
      assert.equal(row.rows[0]?.status, "skipped");
      assert.match(String(row.rows[0]?.reason ?? ""), /daily_cap_exceeded/);
      assert.equal(Number(row.rows[0]?.reserved_budget), 0);
    } finally {
      verify.release();
    }
  });

  it("persists a restart-safe maximum of three zero-fill IOC submissions", async () => {
    const wk = `DBTEST-zero-${Date.now()}`;
    let claim = await db.claimReservationAndCap(`id-${wk}`, MODE, "ETH", wk, "T", 2, null, null);
    assert.equal(claim.allowed, true);

    for (let submission = 1; submission <= 3; submission++) {
      const orderId = `order-${submission}-${wk}`;
      await db.insertScalpOrderIntent({
        id: orderId,
        mode: MODE,
        symbol: "ETH",
        windowKey: wk,
        ticker: "T",
        side: "yes",
        entryYesPrice: 0.95,
        contractCount: 2,
        budgetSpent: 0,
        orderId: `exchange-${submission}`,
        filledCount: 0,
        avgFillPrice: null,
        limitPrice: 0.95,
        winningContractCost: null,
        status: "submitting",
        errorMessage: null,
        settlementResult: null,
        outcome: null,
        pnl: null,
        incidentId: null,
        createdAt: new Date(),
        settledAt: null,
      });
      await db.finalizeOrderAndReleaseReservation({
        orderId,
        mode: MODE,
        symbol: "ETH",
        windowKey: wk,
        status: "zero_fill",
        reservationStatus: "zero_fill",
        filledCount: 0,
        avgFillPrice: null,
        winningContractCost: null,
        budgetSpent: 0,
        exchangeOrderId: `exchange-${submission}`,
        reason: "zero_fill",
      });

      const c = await pool.connect();
      try {
        await c.query(
          `UPDATE kalshi_scalp_reservations
           SET attempted_at = NOW() - INTERVAL '2 seconds'
           WHERE mode = '${MODE}' AND window_key = '${wk}'`,
        );
      } finally {
        c.release();
      }

      const next = await db.claimReservationAndCap(
        `id-next-${submission}-${wk}`, MODE, "ETH", wk, "T", 2, null, null,
      );
      if (submission < 3) {
        assert.equal(next.claimed, true);
        assert.equal(next.allowed, true);
        assert.equal(next.submittedOrders, submission);
        claim = next;
      } else {
        assert.equal(next.claimed, false);
        assert.equal(next.reason, "retry_limit_reached");
        assert.equal(next.submittedOrders, 3);
        assert.equal(next.retryAfterMs, null);
      }
    }

    assert.ok(claim.reservationId);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible migrations: simulate an OLDER schema (missing lifecycle
// columns) then run runScalpMigrations() and confirm it upgrades cleanly and
// subsequent queries work.
// ---------------------------------------------------------------------------

describe("runScalpMigrations backward compatibility", { skip: !RUN_DB_TESTS ? "set SCALPER_DB_TEST=1 with DATABASE_URL" : false }, () => {
  let db: typeof import("./kalshi-scalper-db.ts");
  let pool: { connect: () => Promise<{ query: (sql: string) => Promise<unknown>; release: () => void }> };

  before(async () => {
    db = await import("./kalshi-scalper-db.ts");
    const dbmod = await import("@workspace/db");
    pool = dbmod.pool as typeof pool;
  });

  it("upgrades an older schema missing lifecycle columns", async () => {
    const c = await pool.connect();
    try {
      // Drop and recreate a deliberately OLD-shaped schema.
      await c.query(`DROP TABLE IF EXISTS kalshi_scalp_orders`);
      await c.query(`DROP TABLE IF EXISTS kalshi_scalp_reservations`);
      await c.query(`DROP TABLE IF EXISTS kalshi_scalp_incidents`);

      // Old reservations: no status/reason/reserved_budget/ticker/attempted_at.
      await c.query(`
        CREATE TABLE kalshi_scalp_reservations (
          id         TEXT PRIMARY KEY,
          mode       TEXT NOT NULL,
          symbol     TEXT NOT NULL,
          window_key TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Old orders: no winning_contract_cost/error_message; has an old-style status.
      await c.query(`
        CREATE TABLE kalshi_scalp_orders (
          id              TEXT PRIMARY KEY,
          mode            TEXT NOT NULL,
          symbol          TEXT NOT NULL,
          window_key      TEXT NOT NULL,
          ticker          TEXT NOT NULL,
          side            TEXT NOT NULL,
          entry_yes_price NUMERIC(8,4) NOT NULL,
          contract_count  INTEGER NOT NULL,
          limit_price     NUMERIC(8,4) NOT NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Old incidents: legacy actual_fill_price instead of actual_winning_cost.
      await c.query(`
        CREATE TABLE kalshi_scalp_incidents (
          id                TEXT PRIMARY KEY,
          mode              TEXT NOT NULL,
          symbol            TEXT NOT NULL,
          window_key        TEXT NOT NULL,
          ticker            TEXT NOT NULL,
          description       TEXT NOT NULL,
          actual_fill_price NUMERIC(8,4),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Seed a row in each old table so backfill paths execute.
      await c.query(`
        INSERT INTO kalshi_scalp_reservations (id, mode, symbol, window_key)
        VALUES ('DBTEST-old-res', 'paper', 'BTC', 'DBTEST-old-wk')
      `);
      await c.query(`
        INSERT INTO kalshi_scalp_orders
          (id, mode, symbol, window_key, ticker, side, entry_yes_price, contract_count, limit_price)
        VALUES ('DBTEST-old-ord', 'paper', 'BTC', 'DBTEST-old-wk', 'T', 'yes', 0.9, 1, 0.9)
      `);
      await c.query(`
        INSERT INTO kalshi_scalp_incidents (id, mode, symbol, window_key, ticker, description)
        VALUES ('DBTEST-old-inc', 'paper', 'BTC', 'DBTEST-old-wk', 'T', 'legacy')
      `);
    } finally {
      c.release();
    }

    // Run the migration — must upgrade, not fail.
    await db.runScalpMigrations();

    // Verify new columns exist + have safe backfilled values; queries succeed.
    const c2 = await pool.connect();
    try {
      const res = (await c2.query(
        `SELECT status, reserved_budget, ticker FROM kalshi_scalp_reservations WHERE id = 'DBTEST-old-res'`,
      )) as { rows: Array<Record<string, unknown>> };
      assert.equal(res.rows[0]?.["status"], "claimed");
      assert.equal(Number(res.rows[0]?.["reserved_budget"]), 0);

      const ord = (await c2.query(
        `SELECT status, filled_count, budget_spent, winning_contract_cost, error_message
         FROM kalshi_scalp_orders WHERE id = 'DBTEST-old-ord'`,
      )) as { rows: Array<Record<string, unknown>> };
      assert.equal(ord.rows[0]?.["status"], "unknown"); // backfilled default
      assert.equal(Number(ord.rows[0]?.["filled_count"]), 0);

      const inc = (await c2.query(
        `SELECT actual_winning_cost, expected_band_min, expected_band_max, severity, actual_fill_price
         FROM kalshi_scalp_incidents WHERE id = 'DBTEST-old-inc'`,
      )) as { rows: Array<Record<string, unknown>> };
      assert.equal(Number(inc.rows[0]?.["actual_winning_cost"]), 0);
      assert.equal(Number(inc.rows[0]?.["expected_band_max"]), 1);
      assert.equal(inc.rows[0]?.["severity"], "high");
      // Legacy column left intact.
      assert.ok("actual_fill_price" in (inc.rows[0] ?? {}));
    } finally {
      c2.release();
    }

    // Cleanup.
    const c3 = await pool.connect();
    try {
      await c3.query(`DELETE FROM kalshi_scalp_reservations WHERE window_key = 'DBTEST-old-wk'`);
      await c3.query(`DELETE FROM kalshi_scalp_orders WHERE window_key = 'DBTEST-old-wk'`);
      await c3.query(`DELETE FROM kalshi_scalp_incidents WHERE window_key = 'DBTEST-old-wk'`);
    } finally {
      c3.release();
    }
  });
});
