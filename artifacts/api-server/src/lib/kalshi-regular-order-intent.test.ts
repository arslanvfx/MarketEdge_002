// ---------------------------------------------------------------------------
// kalshi-regular-order-intent.test.ts — DB concurrency tests for the durable
// regular-bot order-intent reservation. Opt-in: requires DATABASE_URL AND
// REGULAR_DB_TEST=1 (the @workspace/db package uses directory ESM imports the
// bare node runner cannot resolve without the app tooling).
//
//   DATABASE_URL=postgres://... REGULAR_DB_TEST=1 <app test tooling>
// ---------------------------------------------------------------------------

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const RUN_DB_TESTS = !!process.env["DATABASE_URL"] && process.env["REGULAR_DB_TEST"] === "1";

if (RUN_DB_TESTS) {
  after(async () => {
    try {
      const dbmod = await import("@workspace/db");
      const p = dbmod.pool as { end?: () => Promise<void> } | undefined;
      const critical = dbmod.criticalIntentPool as { end?: () => Promise<void> } | undefined;
      if (critical && typeof critical.end === "function") await critical.end();
      if (p && typeof p.end === "function") await p.end();
    } catch { /* best-effort */ }
  });
}

describe("regular order intent (DB concurrency)", { skip: !RUN_DB_TESTS ? "set REGULAR_DB_TEST=1 with DATABASE_URL" : false }, () => {
  let mod: typeof import("./kalshi-regular-order-intent.ts");
  let pool: {
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
      release: () => void;
    }>;
  };
  const MODE = "live" as const;

  async function cleanup(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM kalshi_regular_order_intents WHERE window_key LIKE 'DBTEST-%'`);
      await c.query(`DELETE FROM kalshi_regular_exit_intents WHERE window_key LIKE 'DBTEST-%'`);
      await c.query(`DELETE FROM kalshi_bot_bets WHERE window_key LIKE 'DBTEST-%'`);
      await c.query(
        `INSERT INTO bot_config (id, config, updated_at)
         VALUES ('dashboard2_execution_ownership', '{"owner":"current_bot"}'::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      );
    } finally {
      c.release();
    }
  }

  // Insert an authoritative live 'bet' row so reconciliation can prove a fill.
  // `offsetMs` shifts created_at relative to now (negative = before).
  async function insertLiveBet(opts: {
    symbol: string;
    windowKey: string;
    contractCount: number;
    entryPrice: number;
    offsetMs?: number;
    action?: "bet" | "expired";
    source?: "bot" | "manual";
  }): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO kalshi_bot_bets
           (id, symbol, window_key, ticker, direction, action, mode, source,
            entry_price, contract_count, kalshi_target, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'live',$7,$8,$9,$10, NOW() + ($11 || ' milliseconds')::interval)`,
        [
          randomUUID(), opts.symbol, opts.windowKey, "KXBTC-TEST", "yes",
          opts.action ?? "bet", opts.source ?? "bot", String(opts.entryPrice),
          opts.contractCount, "60000",
          String(opts.offsetMs ?? 0),
        ],
      );
    } finally {
      c.release();
    }
  }

  before(async () => {
    mod = await import("./kalshi-regular-order-intent.ts");
    const dbmod = await import("@workspace/db");
    pool = dbmod.pool as typeof pool;
    await mod.runRegularOrderIntentMigrations();
  });

  beforeEach(cleanup);
  after(cleanup);

  const key = (clientOrderId: string, windowKey: string) => ({
    clientOrderId, mode: MODE, symbol: "BTC", windowKey, ticker: "KXBTC-TEST",
    side: "yes" as const, requestedCount: 3, limitPrice: 0.5,
  });

  it("second claim for same (mode,symbol,window) is denied while first is unresolved", async () => {
    const wk = "DBTEST-A";
    const a = await mod.claimRegularOrderIntent(key("cid-a1", wk));
    assert.equal(a.claimed, true);
    const b = await mod.claimRegularOrderIntent(key("cid-a2", wk));
    assert.equal(b.claimed, false);
    assert.equal(b.reason, "unresolved_intent_exists");
  });

  it("durable execution ownership atomically gates new live entry claims", async () => {
    const setOwner = async (owner: "current_bot" | "dashboard2_bot" | "paused") => {
      const c = await pool.connect();
      try {
        await c.query(
          `UPDATE bot_config SET config = $1::jsonb, updated_at = NOW()
           WHERE id = 'dashboard2_execution_ownership'`,
          [JSON.stringify({ owner })],
        );
      } finally {
        c.release();
      }
    };

    await setOwner("paused");
    const paused = await mod.claimRegularOrderIntent(key("cid-owner-paused", "DBTEST-OWNER-PAUSED"));
    assert.deepEqual(paused, { claimed: false, reason: "execution_owner_not_current_bot" });

    await setOwner("dashboard2_bot");
    const dashboard2 = await mod.claimRegularOrderIntent(key("cid-owner-d2", "DBTEST-OWNER-D2"));
    assert.deepEqual(dashboard2, { claimed: false, reason: "execution_owner_not_current_bot" });

    await setOwner("current_bot");
    const current = await mod.claimRegularOrderIntent(key("cid-owner-current", "DBTEST-OWNER-CURRENT"));
    assert.deepEqual(current, { claimed: true, reason: null });
  });

  it("PARALLEL claims: exactly one wins", async () => {
    const wk = "DBTEST-P";
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => mod.claimRegularOrderIntent(key(`cid-p${i}`, wk))),
    );
    const won = results.filter((r) => r.claimed).length;
    assert.equal(won, 1, "exactly one parallel claim may win the reservation");
  });

  it("UNKNOWN outcome RETAINS the reservation (still blocks re-entry)", async () => {
    const wk = "DBTEST-U";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-u1", wk))).claimed, true);
    await mod.markRegularOrderIntentUnknown({ clientOrderId: "cid-u1", reason: "transport_or_timeout" });
    // Still blocked.
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), true);
    assert.equal((await mod.claimRegularOrderIntent(key("cid-u2", wk))).claimed, false);
    assert.equal((await mod.claimRegularOrderIntent(key("cid-u3", "DBTEST-U-NEXT"))).claimed, false);
    assert.equal(await mod.countUnresolvedRegularIntents() >= 1, true);
  });

  it("operator clear retains the intent row but releases an unresolved reservation", async () => {
    const wk = "DBTEST-OPERATOR-CLEAR";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-clear1", wk))).claimed, true);
    await mod.markRegularOrderIntentUnknown({
      clientOrderId: "cid-clear1",
      reason: "unparseable_exchange_response",
    });

    const result = await mod.clearRegularOrderIntent({
      clientOrderId: "cid-clear1",
      actorId: "user_dbtest",
    });

    assert.equal(result.outcome, "cleared");
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), false);
    assert.equal((await mod.claimRegularOrderIntent(key("cid-clear2", "DBTEST-OPERATOR-CLEAR-NEXT"))).claimed, true);

    const after = await readIntent("cid-clear1");
    assert.ok(after, "operator clear must retain the original intent row");
    assert.equal(after!.status, "operator_cleared");
  });

  it("operator clear cannot release a reserved intent that may still be in flight", async () => {
    const wk = "DBTEST-OPERATOR-CLEAR-RESERVED";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-clear-reserved1", wk))).claimed, true);

    const result = await mod.clearRegularOrderIntent({
      clientOrderId: "cid-clear-reserved1",
      actorId: "user_dbtest",
    });

    assert.deepEqual(result, { outcome: "not_unresolved", status: "reserved" });
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), true);
    assert.equal((await mod.claimRegularOrderIntent(key("cid-clear-reserved2", wk))).claimed, false);
  });

  it("a late definite resolver cannot overwrite an operator-cleared audit record", async () => {
    const wk = "DBTEST-OPERATOR-CLEAR-LATE-RESOLVE";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-clear-late1", wk))).claimed, true);
    await mod.markRegularOrderIntentUnknown({
      clientOrderId: "cid-clear-late1",
      reason: "transport_timeout",
    });
    assert.equal(
      (await mod.clearRegularOrderIntent({
        clientOrderId: "cid-clear-late1",
        actorId: "user_dbtest",
      })).outcome,
      "cleared",
    );

    await assert.rejects(
      mod.resolveRegularOrderIntent({
        clientOrderId: "cid-clear-late1",
        status: "filled",
        filledCount: 3,
        avgFillPrice: 0.5,
        orderId: "late-order",
      }),
      /matched zero rows/,
    );
    assert.equal((await readIntent("cid-clear-late1"))?.status, "operator_cleared");
  });

  it("confirmed fill remains blocking for the same symbol/window", async () => {
    const wk = "DBTEST-F";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-f1", wk))).claimed, true);
    await mod.resolveRegularOrderIntent({
      clientOrderId: "cid-f1", status: "filled", filledCount: 3, avgFillPrice: 0.5, orderId: "o1",
    });
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), false);
    // A filled exchange intent is resolved, but still blocks another order in
    // the same window so a restart cannot duplicate confirmed exposure.
    assert.equal((await mod.claimRegularOrderIntent(key("cid-f2", wk))).claimed, false);
  });

  it("zero_fill releases exposure but enforces the durable 30-second retry cooldown", async () => {
    const wk = "DBTEST-Z";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-z1", wk))).claimed, true);
    await mod.resolveRegularOrderIntent({ clientOrderId: "cid-z1", status: "zero_fill", filledCount: 0 });
    assert.deepEqual(
      await mod.claimRegularOrderIntent(key("cid-z2", wk)),
      { claimed: false, reason: "authoritative_zero_fill_cooldown" },
    );
    await pool.query(
      `UPDATE kalshi_regular_order_intents
          SET resolved_at = NOW() - INTERVAL '31 seconds'
        WHERE client_order_id = $1`,
      ["cid-z1"],
    );
    assert.equal((await mod.claimRegularOrderIntent(key("cid-z3", wk))).claimed, true);
  });

  it("resolve detects a missing intent row instead of reporting success", async () => {
    await assert.rejects(
      mod.resolveRegularOrderIntent({
        clientOrderId: "cid-does-not-exist",
        status: "filled",
        filledCount: 1,
        avgFillPrice: 0.5,
      }),
      /matched zero rows/,
    );
  });

  it("shared per-window cap is atomic across different symbols", async () => {
    const wk = "DBTEST-CAP";
    const a = await mod.claimRegularOrderIntent({ ...key("cid-cap1", wk), maxOrdersPerWindow: 1 });
    const b = await mod.claimRegularOrderIntent({
      ...key("cid-cap2", wk),
      symbol: "ETH",
      ticker: "KXETH-TEST",
      maxOrdersPerWindow: 1,
    });
    assert.equal(a.claimed, true);
    assert.equal(b.claimed, false);
    assert.equal(b.reason, "window_order_cap_reached");
  });

  it("same-turn distinct-symbol claims are committed as one cap-safe batch", async () => {
    const wk = "DBTEST-BATCH";
    const results = await Promise.all(
      ["BTC", "ETH", "SOL", "XRP"].map((symbol, index) =>
        mod.claimRegularOrderIntent({
          ...key(`cid-batch-${index}`, wk),
          symbol,
          ticker: `KX${symbol}-TEST`,
          requestedCost: 1,
          maxOrdersPerWindow: 3,
          maxTotalExposure: 10,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.claimed).length, 3);
    assert.equal(results.filter((result) => result.reason === "window_order_cap_reached").length, 1);
  });

  it("separate async continuations in one price cycle join the same cap-safe cohort", async () => {
    const wk = "DBTEST-ASYNC-BATCH";
    const symbols = ["BTC", "ETH", "SOL", "XRP"];
    const claims = symbols.map((symbol, index) =>
      new Promise<mod.ClaimIntentResult>((resolve, reject) => {
        setTimeout(() => {
          mod.claimRegularOrderIntent({
            ...key(`cid-async-batch-${index}`, wk),
            symbol,
            ticker: `KX${symbol}-TEST`,
            requestedCost: 1,
            maxOrdersPerWindow: 3,
            maxTotalExposure: 10,
          }).then(resolve, reject);
        }, index * 2);
      }),
    );
    const results = await Promise.all(claims);
    assert.equal(results.filter((result) => result.claimed).length, 3);
    assert.equal(results.filter((result) => result.reason === "window_order_cap_reached").length, 1);
  });

  async function readIntent(clientOrderId: string): Promise<{
    status: string;
    filled_count: string | null;
    avg_fill_price: string | null;
  } | null> {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT status, filled_count, avg_fill_price
         FROM kalshi_regular_order_intents WHERE client_order_id = $1`,
        [clientOrderId],
      );
      return (r.rows[0] as {
        status: string;
        filled_count: string | null;
        avg_fill_price: string | null;
      }) ?? null;
    } finally {
      c.release();
    }
  }

  it("reconciliation flips a stranded reserved intent to filled when an authoritative bet exists", async () => {
    const wk = "DBTEST-RECON";
    // Simulate the scoping bug: intent claimed (reserved) but never resolved to
    // filled even though the fill persisted a bet row.
    assert.equal((await mod.claimRegularOrderIntent({
      ...key("cid-recon1", wk),
      requestedCount: 4,
    })).claimed, true);
    await insertLiveBet({ symbol: "BTC", windowKey: wk, contractCount: 4, entryPrice: 0.63, offsetMs: 1_000 });

    const res = await mod.reconcileReservedRegularIntents();
    assert.equal(res.reconciled >= 1, true, "at least one reserved intent reconciled");

    const after = await readIntent("cid-recon1");
    assert.ok(after);
    assert.equal(after!.status, "filled");
    assert.equal(Number(after!.filled_count), 4, "contract_count copied as fill metadata");
    assert.equal(Number(after!.avg_fill_price), 0.63, "entry_price copied as fill metadata");
    // A restart cannot duplicate confirmed exposure — same-window re-claim denied.
    assert.equal((await mod.claimRegularOrderIntent(key("cid-recon2", wk))).claimed, false);
  });

  it("reconciliation recognizes a confirmed bet after settlement changes its action to expired", async () => {
    const wk = "DBTEST-RECON-EXPIRED";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-recon-expired", wk))).claimed, true);
    await insertLiveBet({
      symbol: "BTC",
      windowKey: wk,
      contractCount: 1,
      entryPrice: 0.81,
      offsetMs: 1_000,
      action: "expired",
    });

    const res = await mod.reconcileReservedRegularIntents();
    assert.equal(res.reconciled >= 1, true);
    assert.equal((await readIntent("cid-recon-expired"))?.status, "filled");
  });

  it("reconciliation leaves an UNMATCHED reserved intent blocked (no authoritative bet)", async () => {
    const wk = "DBTEST-RECON-NOBET";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-nobet1", wk))).claimed, true);

    const res = await mod.reconcileReservedRegularIntents();
    assert.equal(res.unmatched >= 1, true, "reserved intent with no bet counted as unmatched");

    const after = await readIntent("cid-nobet1");
    assert.ok(after);
    assert.equal(after!.status, "reserved", "unmatched reserved stays reserved (blocked)");
    // Still blocks re-entry for the symbol/window.
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), true);
    assert.equal((await mod.claimRegularOrderIntent(key("cid-nobet2", wk))).claimed, false);
  });

  it("reconciliation leaves UNKNOWN intents untouched even when a bet exists", async () => {
    const wk = "DBTEST-RECON-UNK";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-unk1", wk))).claimed, true);
    await mod.markRegularOrderIntentUnknown({ clientOrderId: "cid-unk1", reason: "transport_or_timeout" });
    // Even a matching bet row must not release fail-closed unknown exposure.
    await insertLiveBet({ symbol: "BTC", windowKey: wk, contractCount: 2, entryPrice: 0.5, offsetMs: 50 });

    await mod.reconcileReservedRegularIntents();

    const after = await readIntent("cid-unk1");
    assert.ok(after);
    assert.equal(after!.status, "unknown", "unknown stays unknown — never reconciled");
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), true);
  });

  it("reconciliation does not treat a matching manual bet as proof of the bot intent", async () => {
    const wk = "DBTEST-RECON-MANUAL";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-manual1", wk))).claimed, true);
    await insertLiveBet({
      symbol: "BTC",
      windowKey: wk,
      contractCount: 1,
      entryPrice: 0.81,
      offsetMs: 50,
      source: "manual",
    });

    await mod.reconcileReservedRegularIntents();

    const after = await readIntent("cid-manual1");
    assert.ok(after);
    assert.equal(after!.status, "reserved");
    assert.equal(await mod.hasUnresolvedRegularIntent(MODE, "BTC", wk), true);
  });

  it("exit intent blocks a second close submission after an unknown result", async () => {
    const exitKey = {
      clientOrderId: "exit-1",
      mode: MODE,
      positionId: "DBTEST-POS-1",
      symbol: "BTC",
      windowKey: "DBTEST-EXIT",
      ticker: "KXBTC-TEST",
      side: "yes" as const,
      requestedCount: 3,
    };
    assert.equal((await mod.claimRegularExitIntent(exitKey)).claimed, true);
    await mod.markRegularExitIntentUnknown({
      clientOrderId: exitKey.clientOrderId,
      reason: "transport_or_timeout",
    });
    assert.equal(
      (await mod.claimRegularExitIntent({ ...exitKey, clientOrderId: "exit-2" })).claimed,
      false,
    );
  });

  it("definite zero-fill exit releases the position for a later close attempt", async () => {
    const exitKey = {
      clientOrderId: "exit-z1",
      mode: MODE,
      positionId: "DBTEST-POS-Z",
      symbol: "BTC",
      windowKey: "DBTEST-EXIT-Z",
      ticker: "KXBTC-TEST",
      side: "yes" as const,
      requestedCount: 3,
    };
    assert.equal((await mod.claimRegularExitIntent(exitKey)).claimed, true);
    await mod.resolveRegularExitIntent({
      clientOrderId: exitKey.clientOrderId,
      status: "zero_fill",
      filledCount: 0,
    });
    assert.equal(
      (await mod.claimRegularExitIntent({ ...exitKey, clientOrderId: "exit-z2" })).claimed,
      true,
    );
  });
});
