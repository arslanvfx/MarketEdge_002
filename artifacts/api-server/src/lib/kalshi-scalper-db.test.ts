// ---------------------------------------------------------------------------
// kalshi-scalper-db.test.ts — DB-level concurrency tests for the atomic
// claim-and-cap transaction. Guarded by DATABASE_URL: when it's not set (e.g.
// pure unit CI), the whole suite is skipped so `node --test` still passes.
//
// Run with a live Postgres:  DATABASE_URL=postgres://... node --experimental-strip-types --test
// ---------------------------------------------------------------------------

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { evaluateScalpReservationRetry } from "./kalshi-scalper-policy.ts";
import {
  DEFAULT_SCALP_CONFIG,
  DEFAULT_SCALP_OPEN_CAP_DOLLARS,
} from "./kalshi-scalper-types.ts";

// Requires BOTH a DATABASE_URL and an explicit opt-in, because the
// @workspace/db package uses directory ESM imports that the bare
// `node --experimental-strip-types --test` runner cannot resolve. Run this
// suite through the app's bundler/tsx tooling with SCALPER_DB_TEST=1 set.
const RUN_DB_TESTS = !!process.env["DATABASE_URL"] && process.env["SCALPER_DB_TEST"] === "1";

// The backward-compatibility migration test DROPS all three scalper tables and
// recreates them with an old schema before running runScalpMigrations(). This
// is intentionally destructive and must NEVER run against the shared dev
// database. It requires a dedicated throwaway database AND an explicit second
// opt-in: SCALPER_MIGRATION_TEST=1.
//
// Example (throwaway DB only):
//   DATABASE_URL=postgres://... SCALPER_DB_TEST=1 SCALPER_MIGRATION_TEST=1 tsx --test .../kalshi-scalper-db.test.ts
const RUN_MIGRATION_TEST =
  RUN_DB_TESTS && process.env["SCALPER_MIGRATION_TEST"] === "1";

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
  const OPEN_CAP = DEFAULT_SCALP_OPEN_CAP_DOLLARS;

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

  it("defaults invalid open caps while preserving valid operator-entered values", async () => {
    const c = await pool.connect();
    const original = await c.query(
      "SELECT config FROM kalshi_scalp_config WHERE id = 'singleton'",
    );
    const hadOriginal = original.rows.length > 0;
    const originalConfig = original.rows[0]?.["config"];
    try {
      for (const [storedOpenCap, expectedOpenCap] of [
        [null, OPEN_CAP],
        [0, OPEN_CAP],
        [75, 75],
        [500, 500],
      ] as const) {
        const legacyConfig = {
          ...(hadOriginal && originalConfig && typeof originalConfig === "object"
            ? originalConfig
            : DEFAULT_SCALP_CONFIG),
          openCapDollars: storedOpenCap,
        };
        await c.query(
          `INSERT INTO kalshi_scalp_config (id, config, updated_at)
           VALUES ('singleton', $1, NOW())
           ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = NOW()`,
          [JSON.stringify(legacyConfig)],
        );

        const loaded = await db.loadScalpConfigFromDB();
        assert.equal(loaded.openCapDollars, expectedOpenCap);

        const persisted = await c.query(
          "SELECT config FROM kalshi_scalp_config WHERE id = 'singleton'",
        );
        const persistedConfig = persisted.rows[0]?.["config"] as Record<string, unknown>;
        assert.equal(Number(persistedConfig["openCapDollars"]), expectedOpenCap);
      }
    } finally {
      if (hadOriginal) {
        await c.query(
          `UPDATE kalshi_scalp_config
           SET config = $1, updated_at = NOW()
           WHERE id = 'singleton'`,
          [JSON.stringify(originalConfig)],
        );
      } else {
        await c.query("DELETE FROM kalshi_scalp_config WHERE id = 'singleton'");
      }
      c.release();
    }
  });

  it("duplicate (mode,symbol,windowKey) is claimed only once", async () => {
    const wk = `DBTEST-dup-${Date.now()}`;
    const r1 = await db.claimReservationAndCap("id-a-" + wk, MODE, "BTC", wk, "T", 2, null, OPEN_CAP);
    const r2 = await db.claimReservationAndCap("id-b-" + wk, MODE, "BTC", wk, "T", 2, null, OPEN_CAP);
    assert.equal(r1.claimed, true);
    assert.equal(r1.allowed, true);
    assert.equal(r2.claimed, false);
    assert.equal(r2.reason, "terminal");
  });

  it("concurrent distinct claims respect the daily cap exactly (no double-add, no over-admit)", async () => {
    const base = `DBTEST-cap-${Date.now()}`;
    const budget = 2;
    const baseline = await db.getScalpCommittedTotals(MODE, `${base}-0`);
    const dailyCap = baseline.dailyCommitted + 6; // exactly 3 new attempts of $2 should be allowed
    const N = 8;

    // Fire N distinct-window claims concurrently.
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        db.claimReservationAndCap(
          `id-${base}-${i}`, MODE, "ETH", `${base}-${i}`, "T", budget, dailyCap, OPEN_CAP,
        ),
      ),
    );

    const allowed = results.filter((r) => r.claimed && r.allowed).length;
    const denied = results.filter((r) => r.claimed && !r.allowed).length;

    // Exactly floor(cap / budget) = 3 admitted; the rest cap-denied.
    assert.equal(allowed, 3, `expected 3 allowed above the existing daily baseline, got ${allowed}`);
    assert.equal(allowed + denied, N, "every distinct claim must persist a durable outcome");

    // Denied rows persist as 'skipped' with reserved_budget=0 → re-claim still duplicate.
    const reAttempt = await db.claimReservationAndCap(
      `id-re-${base}`, MODE, "ETH", `${base}-0`, "T", budget, dailyCap, OPEN_CAP,
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

    const c = await pool.connect();
    try {
      const denied = await c.query(
        `SELECT status, reason, reserved_budget, skip_evidence
         FROM kalshi_scalp_reservations
         WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "SOL", `${base}-2`],
      );
      assert.equal(denied.rows.length, 1, "cap denial must leave one durable reservation");
      assert.equal(denied.rows[0]?.["status"], "skipped");
      assert.match(String(denied.rows[0]?.["reason"]), /^open_cap_exceeded/);
      assert.equal(Number(denied.rows[0]?.["reserved_budget"]), 0);

      const evidence = denied.rows[0]?.["skip_evidence"] as Record<string, unknown>;
      assert.equal(Number(evidence["requestedBudget"]), budget);
      assert.equal(Number(evidence["openCapDollars"]), openCap);
      assert.equal(Number(evidence["openCommittedDollars"]), budget);
      assert.ok(typeof evidence["skippedAt"] === "string");

      const orders = await c.query(
        `SELECT COUNT(*)::int AS count
         FROM kalshi_scalp_orders
         WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "SOL", `${base}-2`],
      );
      assert.equal(Number(orders.rows[0]?.["count"]), 0, "cap denial must not create or submit an order");
    } finally {
      c.release();
    }
  });

  it("does not let a prior-window confirmed fill consume current-window open exposure", async () => {
    const base = `DBTEST-stale-settlement-${Date.now()}`;
    const previousWindow = `${base}-previous`;
    const activeWindow = `${base}-active`;
    const c = await pool.connect();
    try {
      const insertOrder = async (
        id: string,
        windowKey: string,
        status: "filled" | "unknown",
        budgetSpent: number,
      ) => {
        await c.query(
          `INSERT INTO kalshi_scalp_orders
             (id, mode, symbol, window_key, ticker, side, entry_yes_price,
              contract_count, limit_price, winning_contract_cost, status,
              filled_count, avg_fill_price, budget_spent, created_at)
           VALUES ($1, $2, 'BTC', $3, 'DBTEST-BTC', 'yes', 0.90,
                   1, 0.90, 0.90, $4, $5, 0.90, $6, NOW())`,
          [
            id,
            MODE,
            windowKey,
            status,
            status === "filled" ? 1 : 0,
            budgetSpent,
          ],
        );
      };

      const baseline = await db.getScalpCommittedTotals(MODE, activeWindow);
      const displayBaseline = await db.getOpenScalpSpend(MODE, activeWindow);

      await insertOrder(`${base}-old-fill`, previousWindow, "filled", 7);
      const afterOldFill = await db.getScalpCommittedTotals(MODE, activeWindow);
      const displayAfterOldFill = await db.getOpenScalpSpend(MODE, activeWindow);
      assert.equal(afterOldFill.openCommitted, baseline.openCommitted);
      assert.equal(displayAfterOldFill, displayBaseline);

      await insertOrder(`${base}-active-fill`, activeWindow, "filled", 3);
      const afterActiveFill = await db.getScalpCommittedTotals(MODE, activeWindow);
      assert.equal(afterActiveFill.openCommitted, baseline.openCommitted + 3);

      await insertOrder(`${base}-old-unknown`, previousWindow, "unknown", 2);
      const afterOldUnknown = await db.getScalpCommittedTotals(MODE, activeWindow);
      assert.equal(
        afterOldUnknown.openCommitted,
        baseline.openCommitted + 5,
        "indeterminate prior-window submissions must remain fail-closed",
      );
    } finally {
      c.release();
    }
  });

  it("normalizes a legacy null at the atomic claim boundary and denies before any order", async () => {
    const base = `DBTEST-open-legacy-null-${Date.now()}`;
    const requestedBudget = OPEN_CAP + 1;
    const denied = await db.claimReservationAndCap(
      `id-${base}`,
      MODE,
      "SOL",
      base,
      "T",
      requestedBudget,
      null,
      null as unknown as number,
    );
    assert.equal(denied.claimed, true);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? "", /^open_cap_exceeded/);
    assert.match(denied.reason ?? "", new RegExp(`cap=${OPEN_CAP}`));

    const c = await pool.connect();
    try {
      const reservation = await c.query(
        `SELECT status, reserved_budget, skip_evidence
         FROM kalshi_scalp_reservations
         WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "SOL", base],
      );
      assert.equal(reservation.rows[0]?.["status"], "skipped");
      assert.equal(Number(reservation.rows[0]?.["reserved_budget"]), 0);
      const evidence = reservation.rows[0]?.["skip_evidence"] as Record<string, unknown>;
      assert.equal(Number(evidence["openCapDollars"]), OPEN_CAP);

      const orders = await c.query(
        `SELECT COUNT(*)::int AS count
         FROM kalshi_scalp_orders
         WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "SOL", base],
      );
      assert.equal(Number(orders.rows[0]?.["count"]), 0);
    } finally {
      c.release();
    }
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
    const first = await db.claimReservationAndCap(`id-${wk}`, MODE, "BTC", wk, "T", 2, null, OPEN_CAP);
    assert.equal(first.allowed, true);
    await db.updateReservationStatus(MODE, "BTC", wk, "skipped", "final_quote_outside_band", true);

    const cooling = await db.claimReservationAndCap(`id-cooling-${wk}`, MODE, "BTC", wk, "T", 2, null, OPEN_CAP);
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

    const retried = await db.claimReservationAndCap(`id-retry-${wk}`, MODE, "BTC", wk, "T", 2, null, OPEN_CAP);
    assert.equal(retried.claimed, true);
    assert.equal(retried.allowed, true);
    assert.equal(retried.reservationId, first.reservationId);
  });

  it("persists cap denial on the existing durable row during a re-claim", async () => {
    const wk = `DBTEST-rearm-cap-${Date.now()}`;
    const first = await db.claimReservationAndCap(
      `id-${wk}`, MODE, "BTC", wk, "T", 2, null, OPEN_CAP,
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
      `new-id-${wk}`, MODE, "BTC", wk, "T", 2, 1, OPEN_CAP,
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
    let claim = await db.claimReservationAndCap(`id-${wk}`, MODE, "ETH", wk, "T", 2, null, OPEN_CAP);
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
        clientOrderId: `client-${submission}-${wk}`,
        orderId: `exchange-${submission}`,
        exchangeResponseReason: null,
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
        reconciledAt: null,
        reconciliationEvidence: null,
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
        `id-next-${submission}-${wk}`, MODE, "ETH", wk, "T", 2, null, OPEN_CAP,
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

  it("reconciles one uncertain order atomically and releases its reservation only once", async () => {
    const wk = `DBTEST-reconcile-${Date.now()}`;
    const orderRecordId = `order-${wk}`;
    const claim = await db.claimReservationAndCap(`reservation-${wk}`, MODE, "GOLD", wk, "T", 2, null, OPEN_CAP);
    assert.equal(claim.allowed, true);
    await db.insertScalpOrderIntent({
      id: orderRecordId,
      mode: MODE,
      symbol: "GOLD",
      windowKey: wk,
      ticker: "T",
      side: "yes",
      entryYesPrice: 0.94,
      contractCount: 2,
      budgetSpent: 0,
      clientOrderId: `client-${wk}`,
      orderId: null,
      exchangeResponseReason: "unparseable_fill_count",
      filledCount: 0,
      avgFillPrice: null,
      limitPrice: 0.94,
      winningContractCost: null,
      status: "unknown",
      errorMessage: "response could not be verified",
      settlementResult: null,
      outcome: null,
      pnl: null,
      incidentId: null,
      reconciledAt: null,
      reconciliationEvidence: null,
      createdAt: new Date(),
      settledAt: null,
    });

    const first = await db.reconcileScalpOrderAndReleaseReservation({
      orderRecordId,
      mode: MODE,
      symbol: "GOLD",
      windowKey: wk,
      status: "filled",
      filledCount: 1.75,
      avgFillPrice: 0.9314285714285714,
      winningContractCost: 0.9314285714285714,
      budgetSpent: 1.63,
      exchangeOrderId: "exchange-order",
      exchangeResponseReason: "reconciled_authoritative_fills",
      evidence: { source: "test" },
    });
    const second = await db.reconcileScalpOrderAndReleaseReservation({
      orderRecordId,
      mode: MODE,
      symbol: "GOLD",
      windowKey: wk,
      status: "filled",
      filledCount: 1.75,
      avgFillPrice: 0.9314285714285714,
      winningContractCost: 0.9314285714285714,
      budgetSpent: 1.63,
      exchangeOrderId: "exchange-order",
      exchangeResponseReason: "reconciled_authoritative_fills",
      evidence: { source: "test-repeat" },
    });
    assert.equal(first, "resolved");
    assert.equal(second, "already_resolved");

    const verify = await pool.connect();
    try {
      const orderRow = await verify.query(
        `SELECT status, filled_count::text, avg_fill_price::text,
                winning_contract_cost::text, budget_spent::text,
                reconciled_at, reconciliation_evidence
           FROM kalshi_scalp_orders WHERE id = $1`,
        [orderRecordId],
      );
      const reservationRow = await verify.query(
        `SELECT status, reserved_budget
           FROM kalshi_scalp_reservations
          WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "GOLD", wk],
      );
      assert.equal(orderRow.rows[0]?.status, "filled");
      assert.equal(orderRow.rows[0]?.filled_count, "1.75");
      assert.equal(orderRow.rows[0]?.avg_fill_price, "0.93142857");
      assert.equal(orderRow.rows[0]?.winning_contract_cost, "0.93142857");
      assert.equal(orderRow.rows[0]?.budget_spent, "1.63000000");
      assert.ok(orderRow.rows[0]?.reconciled_at);
      assert.deepEqual(orderRow.rows[0]?.reconciliation_evidence, { source: "test" });
      assert.equal(reservationRow.rows[0]?.status, "filled");
      assert.equal(Number(reservationRow.rows[0]?.reserved_budget), 0);
    } finally {
      verify.release();
    }
  });

  it("keeps the reservation held until every unresolved sibling order is reconciled", async () => {
    const wk = `DBTEST-siblings-${Date.now()}`;
    const claim = await db.claimReservationAndCap(`reservation-${wk}`, MODE, "SILVER", wk, "T", 2, null, OPEN_CAP);
    assert.equal(claim.allowed, true);
    for (const suffix of ["a", "b"]) {
      await db.insertScalpOrderIntent({
        id: `order-${suffix}-${wk}`,
        mode: MODE,
        symbol: "SILVER",
        windowKey: wk,
        ticker: "T",
        side: "yes",
        entryYesPrice: 0.94,
        contractCount: 2,
        budgetSpent: 0,
        clientOrderId: `client-${suffix}-${wk}`,
        orderId: null,
        exchangeResponseReason: "submit_response_unverified",
        filledCount: 0,
        avgFillPrice: null,
        limitPrice: 0.94,
        winningContractCost: null,
        status: "unknown",
        errorMessage: "response could not be verified",
        settlementResult: null,
        outcome: null,
        pnl: null,
        incidentId: null,
        reconciledAt: null,
        reconciliationEvidence: null,
        createdAt: new Date(),
        settledAt: null,
      });
    }

    const first = await db.reconcileScalpOrderAndReleaseReservation({
      orderRecordId: `order-a-${wk}`,
      mode: MODE,
      symbol: "SILVER",
      windowKey: wk,
      status: "zero_fill",
      filledCount: 0,
      avgFillPrice: null,
      winningContractCost: null,
      budgetSpent: 0,
      exchangeOrderId: "exchange-a",
      exchangeResponseReason: "reconciled_terminal_zero_fill",
      evidence: { source: "test" },
    });
    assert.equal(first, "resolved_held");

    const verifyHeld = await pool.connect();
    try {
      const held = await verifyHeld.query(
        `SELECT status, reserved_budget FROM kalshi_scalp_reservations
          WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "SILVER", wk],
      );
      assert.equal(held.rows[0]?.status, "unknown");
      assert.equal(Number(held.rows[0]?.reserved_budget), 2);
    } finally {
      verifyHeld.release();
    }

    const second = await db.reconcileScalpOrderAndReleaseReservation({
      orderRecordId: `order-b-${wk}`,
      mode: MODE,
      symbol: "SILVER",
      windowKey: wk,
      status: "zero_fill",
      filledCount: 0,
      avgFillPrice: null,
      winningContractCost: null,
      budgetSpent: 0,
      exchangeOrderId: "exchange-b",
      exchangeResponseReason: "reconciled_terminal_zero_fill",
      evidence: { source: "test" },
    });
    assert.equal(second, "resolved");
  });

  it("keeps the aggregate reservation filled when a partial-fill sibling resolves before a zero-fill sibling", async () => {
    const wk = `DBTEST-mixed-siblings-${Date.now()}`;
    const claim = await db.claimReservationAndCap(`reservation-${wk}`, MODE, "GOLD", wk, "T", 2, null, OPEN_CAP);
    assert.equal(claim.allowed, true);
    for (const suffix of ["partial", "zero"]) {
      await db.insertScalpOrderIntent({
        id: `order-${suffix}-${wk}`,
        mode: MODE,
        symbol: "GOLD",
        windowKey: wk,
        ticker: "T",
        side: "yes",
        entryYesPrice: 0.94,
        contractCount: 2,
        budgetSpent: 0,
        clientOrderId: `client-${suffix}-${wk}`,
        orderId: null,
        exchangeResponseReason: "submit_response_unverified",
        filledCount: 0,
        avgFillPrice: null,
        limitPrice: 0.94,
        winningContractCost: null,
        status: "unknown",
        errorMessage: "response could not be verified",
        settlementResult: null,
        outcome: null,
        pnl: null,
        incidentId: null,
        reconciledAt: null,
        reconciliationEvidence: null,
        createdAt: new Date(),
        settledAt: null,
      });
    }

    const incidentId = `incident-${wk}`;
    const first = await db.reconcileScalpOrderAndReleaseReservation({
      orderRecordId: `order-partial-${wk}`,
      mode: MODE,
      symbol: "GOLD",
      windowKey: wk,
      status: "filled",
      filledCount: 1.17,
      avgFillPrice: 0.94,
      winningContractCost: 0.94,
      budgetSpent: 1.0998,
      exchangeOrderId: "exchange-partial",
      exchangeResponseReason: "reconciled_authoritative_fills",
      evidence: { source: "mixed-sibling-test" },
      incident: {
        id: incidentId,
        orderId: `order-partial-${wk}`,
        mode: MODE,
        symbol: "GOLD",
        windowKey: wk,
        ticker: "T",
        severity: "high",
        description: "test incident",
        expectedBandMin: 0.91,
        expectedBandMax: 0.93,
        actualWinningCost: 0.94,
        createdAt: new Date(),
      },
    });
    assert.equal(first, "resolved_held");

    const second = await db.reconcileScalpOrderAndReleaseReservation({
      orderRecordId: `order-zero-${wk}`,
      mode: MODE,
      symbol: "GOLD",
      windowKey: wk,
      status: "zero_fill",
      filledCount: 0,
      avgFillPrice: null,
      winningContractCost: null,
      budgetSpent: 0,
      exchangeOrderId: "exchange-zero",
      exchangeResponseReason: "reconciled_terminal_zero_fill",
      evidence: { source: "mixed-sibling-test" },
    });
    assert.equal(second, "resolved");

    const verify = await pool.connect();
    try {
      const reservation = await verify.query(
        `SELECT status, reason, reserved_budget
           FROM kalshi_scalp_reservations
          WHERE mode = $1 AND symbol = $2 AND window_key = $3`,
        [MODE, "GOLD", wk],
      );
      const order = await verify.query(
        `SELECT incident_id FROM kalshi_scalp_orders WHERE id = $1`,
        [`order-partial-${wk}`],
      );
      const incident = await verify.query(
        `SELECT id FROM kalshi_scalp_incidents WHERE id = $1`,
        [incidentId],
      );
      assert.equal(reservation.rows[0]?.status, "filled");
      assert.equal(reservation.rows[0]?.reason, "reconciled_attempt_contains_fill");
      assert.equal(Number(reservation.rows[0]?.reserved_budget), 0);
      assert.equal(order.rows[0]?.incident_id, incidentId);
      assert.equal(incident.rows[0]?.id, incidentId);
    } finally {
      verify.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible migrations: simulate an OLDER schema (missing lifecycle
// columns) then run runScalpMigrations() and confirm it upgrades cleanly and
// subsequent queries work.
// ---------------------------------------------------------------------------

describe("runScalpMigrations backward compatibility", { skip: !RUN_MIGRATION_TEST ? "set SCALPER_DB_TEST=1 SCALPER_MIGRATION_TEST=1 with a THROWAWAY DATABASE_URL — drops all scalper tables" : false }, () => {
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

// ---------------------------------------------------------------------------
// skip_evidence persistence tests
// ---------------------------------------------------------------------------

describe("skip_evidence persistence and retrieval", { skip: !RUN_DB_TESTS ? "set SCALPER_DB_TEST=1 with DATABASE_URL" : false }, () => {
  let db: typeof import("./kalshi-scalper-db.ts");
  const MODE = "paper" as const;
  const WINDOW_KEY = "DBTEST-skipev-wk";
  const SYMBOL = "BTC";
  const TICKER = "BTC-TICKER";

  before(async () => {
    db = await import("./kalshi-scalper-db.ts");
    // Clean up any residual rows from previous runs (both the primary window key
    // and the -noskip variant used by the second test).
    const { pool: p } = await import("@workspace/db");
    const c = await p.connect();
    try {
      await c.query(
        `DELETE FROM kalshi_scalp_orders WHERE mode = $1 AND window_key LIKE $2`,
        [MODE, `${WINDOW_KEY}%`],
      );
      await c.query(
        `DELETE FROM kalshi_scalp_reservations WHERE mode = $1 AND window_key LIKE $2`,
        [MODE, `${WINDOW_KEY}%`],
      );
    } finally {
      c.release();
    }
  });

  it("persists skip_evidence JSONB alongside a skipped reservation", async () => {
    const { pool: p } = await import("@workspace/db");

    // Insert a reservation row manually.
    const resId = `DBTEST-skipev-${Date.now()}`;
    const c = await p.connect();
    try {
      await c.query(
        `INSERT INTO kalshi_scalp_reservations (id, mode, symbol, window_key, ticker, status, reserved_budget, created_at, attempted_at)
         VALUES ($1, $2, $3, $4, $5, 'claimed', 0, NOW(), NOW())`,
        [resId, MODE, SYMBOL, WINDOW_KEY, TICKER],
      );
    } finally {
      c.release();
    }

    // Update to skipped with evidence.
    const evidence = {
      timingPhase: "eligible" as const,
      closeTimeIso: new Date(Date.now() + 30_000).toISOString(),
      secondsRemaining: 30,
      effectiveWindowSeconds: 120,
      quoteFetchOk: false,
      quotedReason: "final_quote_invalid",
      elapsedMs: 42,
      skippedAt: new Date().toISOString(),
    };
    await db.updateReservationStatus(MODE, SYMBOL, WINDOW_KEY, "skipped", "final_quote_invalid", true, evidence);

    // Verify via getRecentScalpReservations.
    const rows = await db.getRecentScalpReservations({ mode: MODE, limit: 100 });
    const row = rows.find((r) => r.id === resId);
    assert.ok(row, "reservation row should be returned");
    assert.equal(row.status, "skipped");
    assert.equal(row.reason, "final_quote_invalid");
    assert.ok(row.skipEvidence != null, "skipEvidence should be non-null");
    assert.equal(row.skipEvidence?.timingPhase, "eligible");
    assert.equal(row.skipEvidence?.quotedReason, "final_quote_invalid");
    assert.equal(row.skipEvidence?.elapsedMs, 42);
    assert.equal(row.skipEvidence?.effectiveWindowSeconds, 120);
  });

  it("returns null skipEvidence for non-skip rows (compatible with old rows)", async () => {
    const { pool: p } = await import("@workspace/db");
    const WINDOW_KEY2 = `${WINDOW_KEY}-noskip`;
    const resId = `DBTEST-skipev-noskip-${Date.now()}`;
    const c = await p.connect();
    try {
      await c.query(
        `INSERT INTO kalshi_scalp_reservations (id, mode, symbol, window_key, ticker, status, reserved_budget, created_at, attempted_at)
         VALUES ($1, $2, $3, $4, $5, 'filled', 0, NOW(), NOW())`,
        [resId, MODE, SYMBOL, WINDOW_KEY2, TICKER],
      );
    } finally {
      c.release();
    }

    const rows = await db.getRecentScalpReservations({ mode: MODE, limit: 100 });
    const row = rows.find((r) => r.id === resId);
    assert.ok(row, "filled reservation row should be returned");
    assert.equal(row.status, "filled");
    // skipEvidence should be null for rows without it.
    assert.equal(row.skipEvidence, null);
  });

  it("persists compact final guard-pass evidence with the order intent", async () => {
    const orderId = `DBTEST-entry-evidence-${Date.now()}`;
    const windowKey = `${WINDOW_KEY}-entry`;
    const evaluatedAt = new Date().toISOString();
    await db.insertScalpOrderIntent({
      id: orderId,
      mode: MODE,
      symbol: SYMBOL,
      windowKey,
      ticker: TICKER,
      side: "yes",
      entryYesPrice: 0.97,
      contractCount: 2,
      budgetSpent: 0,
      clientOrderId: null,
      orderId: `paper-${orderId}`,
      exchangeResponseReason: null,
      filledCount: 2,
      avgFillPrice: 0.97,
      limitPrice: 0.99,
      winningContractCost: 0.97,
      status: "paper",
      errorMessage: null,
      settlementResult: null,
      outcome: null,
      pnl: null,
      incidentId: null,
      reconciledAt: null,
      reconciliationEvidence: null,
      entryGuardEvidence: {
        schemaVersion: 1,
        phase: "final_pre_submit",
        evaluatedAt,
        side: "yes",
        directionGuardEnabled: true,
        rapidMoveGuardEnabled: true,
        targetProximityGuardEnabled: true,
        samples: [
          { at: new Date(Date.parse(evaluatedAt) - 1_000).toISOString(), price: 101 },
          { at: evaluatedAt, price: 102 },
        ],
        sampleCoverageMs: 1_000,
        samplesUsed: 2,
        wrongWayResetCount: 1,
        lastWrongWayResetAt: evaluatedAt,
        consecutiveWrongWayMoves: 0,
        consecutiveWrongWaySeconds: 0,
        directionalMovePct: 0.99,
        freefallConsecutiveSeconds: 4,
        rapidMovePct: 0.99,
        rapidMoveThresholdPct: 1.5,
        rapidMoveLookbackSeconds: 4,
        distancePct: 2,
        minimumPct: 0.05,
        targetPrice: 100,
        underlyingPrice: 102,
      },
      createdAt: new Date(),
      settledAt: null,
    });

    const orders = await db.getScalpOrders({ mode: MODE, symbol: SYMBOL, limit: 100 });
    const stored = orders.find((order) => order.id === orderId);
    assert.ok(stored);
    assert.equal(stored.entryGuardEvidence?.phase, "final_pre_submit");
    assert.equal(stored.entryGuardEvidence?.wrongWayResetCount, 1);
    assert.equal(stored.entryGuardEvidence?.distancePct, 2);
    assert.deepEqual(
      stored.entryGuardEvidence?.samples.map((sample) => sample.price),
      [101, 102],
    );
  });
});

// ---------------------------------------------------------------------------
// claimReservationAndCap final-window boundary check
// ---------------------------------------------------------------------------

describe("claimReservationAndCap outside_window_at_claim", { skip: !RUN_DB_TESTS ? "set SCALPER_DB_TEST=1 with DATABASE_URL" : false }, () => {
  let db: typeof import("./kalshi-scalper-db.ts");
  const MODE = "paper" as const;
  const SYMBOL = "BTC";
  const TICKER = "BTC-TICKER";
  const OPEN_CAP = DEFAULT_SCALP_OPEN_CAP_DOLLARS;

  before(async () => {
    db = await import("./kalshi-scalper-db.ts");
  });

  it("rejects a claim when closeTime is outside the final window (already passed)", async () => {
    const windowKey = `DBTEST-windowbnd-past-${Date.now()}`;
    // Close time is 10 seconds in the past.
    const closeTime = new Date(Date.now() - 10_000).toISOString();
    const result = await db.claimReservationAndCap(
      `id-past-${Date.now()}`, MODE, SYMBOL, windowKey, TICKER,
      2, null, OPEN_CAP,
      closeTime, 120,
    );
    assert.equal(result.claimed, false, "Should not claim when window is expired");
    assert.equal(result.reason, "outside_window_at_claim");
    assert.ok(result.reservationId, "Denied claim should still have a durable reservation id");
    const rows = await db.getRecentScalpReservations({ mode: MODE, limit: 100 });
    const row = rows.find((candidate) => candidate.id === result.reservationId);
    assert.equal(row?.status, "skipped");
    assert.equal(row?.skipEvidence?.timingPhase, "closed_expired");

    const { pool: p } = await import("@workspace/db");
    const c = await p.connect();
    try {
      await c.query(`DELETE FROM kalshi_scalp_reservations WHERE id = $1`, [result.reservationId]);
    } finally {
      c.release();
    }
  });

  it("rejects a claim when closeTime is far future (outside 45-second window)", async () => {
    const windowKey = `DBTEST-windowbnd-far-${Date.now()}`;
    // 300 seconds in the future, but window is only 45 s.
    const closeTime = new Date(Date.now() + 300_000).toISOString();
    const result = await db.claimReservationAndCap(
      `id-far-${Date.now()}`, MODE, SYMBOL, windowKey, TICKER,
      2, null, OPEN_CAP,
      closeTime, 45,
    );
    assert.equal(result.claimed, false, "Should not claim when outside 45 s window");
    assert.equal(result.reason, "outside_window_at_claim");
    assert.ok(result.reservationId, "Denied early claim should be auditable");
    const rows = await db.getRecentScalpReservations({ mode: MODE, limit: 100 });
    const row = rows.find((candidate) => candidate.id === result.reservationId);
    assert.equal(row?.skipEvidence?.effectiveWindowSeconds, 45);
    assert.equal(row?.skipEvidence?.timingPhase, "waiting_eligibility");

    const { pool: p } = await import("@workspace/db");
    const c = await p.connect();
    try {
      await c.query(`DELETE FROM kalshi_scalp_reservations WHERE id = $1`, [result.reservationId]);
    } finally {
      c.release();
    }
  });

  it("replaces stale retryable skip evidence when the same reservation reaches the boundary", async () => {
    const windowKey = `DBTEST-windowbnd-retry-${Date.now()}`;
    const first = await db.claimReservationAndCap(
      `id-retry-${Date.now()}`, MODE, SYMBOL, windowKey, TICKER,
      0, null, OPEN_CAP,
    );
    assert.equal(first.claimed, true);
    await db.updateReservationStatus(
      MODE,
      SYMBOL,
      windowKey,
      "skipped",
      "final_quote_invalid",
      true,
      {
        quotedReason: "final_quote_invalid",
        skippedAt: new Date().toISOString(),
      },
    );

    const expiredClose = new Date(Date.now() - 1_000).toISOString();
    const denied = await db.claimReservationAndCap(
      `id-retry-second-${Date.now()}`, MODE, SYMBOL, windowKey, TICKER,
      0, null, OPEN_CAP,
      expiredClose, 45,
    );
    assert.equal(denied.claimed, false);
    assert.equal(denied.reason, "outside_window_at_claim");
    assert.equal(denied.reservationId, first.reservationId);

    const rows = await db.getRecentScalpReservations({ mode: MODE, limit: 100 });
    const row = rows.find((candidate) => candidate.id === first.reservationId);
    assert.equal(row?.status, "skipped");
    assert.equal(row?.reason, "outside_window_at_claim");
    assert.equal(row?.skipEvidence?.timingPhase, "closed_expired");
    assert.equal(row?.skipEvidence?.quotedReason, undefined);
    const retry = evaluateScalpReservationRetry({
      status: row?.status ?? "",
      reason: row?.reason,
      elapsedMs: 0,
      submittedOrders: row?.submissionCount ?? 0,
    });
    assert.equal(retry.terminal, true);

    const { pool: p } = await import("@workspace/db");
    const c = await p.connect();
    try {
      await c.query(`DELETE FROM kalshi_scalp_reservations WHERE id = $1`, [first.reservationId]);
    } finally {
      c.release();
    }
  });

  it("allows a claim when closeTime is within the final window", async () => {
    const closeMs = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    const closeTime = new Date(closeMs).toISOString();
    const windowKey = new Date(closeMs - 15 * 60_000).toISOString().slice(0, 16);
    // The next exact minute boundary is at most 60 seconds away, inside 120 s.
    const result = await db.claimReservationAndCap(
      `id-ok-${Date.now()}`, MODE, SYMBOL, windowKey, TICKER,
      0, null, OPEN_CAP,
      closeTime, 120,
    );
    // Budget = 0 means cap check always passes; should be claimed and allowed.
    assert.equal(result.claimed, true, "Should claim when inside window");

    // Cleanup.
    const { pool: p } = await import("@workspace/db");
    const c = await p.connect();
    try {
      await c.query(`DELETE FROM kalshi_scalp_reservations WHERE mode = $1 AND window_key = $2`, [MODE, windowKey]);
    } finally {
      c.release();
    }
  });

  it("allows claim without final-window check when closeTime is omitted", async () => {
    const windowKey = `DBTEST-windowbnd-noctrl-${Date.now()}`;
    // No closeTime supplied → bypass final-window enforcement (backward compat).
    const result = await db.claimReservationAndCap(
      `id-noctrl-${Date.now()}`, MODE, SYMBOL, windowKey, TICKER,
      0, null, OPEN_CAP,
      // No closeTime / finalWindowSeconds passed
    );
    assert.equal(result.claimed, true, "Should claim when no window enforcement args supplied");

    // Cleanup.
    const { pool: p } = await import("@workspace/db");
    const c = await p.connect();
    try {
      await c.query(`DELETE FROM kalshi_scalp_reservations WHERE mode = $1 AND window_key = $2`, [MODE, windowKey]);
    } finally {
      c.release();
    }
  });
});
