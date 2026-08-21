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

const RUN_DB_TESTS = !!process.env["DATABASE_URL"] && process.env["REGULAR_DB_TEST"] === "1";

if (RUN_DB_TESTS) {
  after(async () => {
    try {
      const dbmod = await import("@workspace/db");
      const p = dbmod.pool as { end?: () => Promise<void> } | undefined;
      if (p && typeof p.end === "function") await p.end();
    } catch { /* best-effort */ }
  });
}

describe("regular order intent (DB concurrency)", { skip: !RUN_DB_TESTS ? "set REGULAR_DB_TEST=1 with DATABASE_URL" : false }, () => {
  let mod: typeof import("./kalshi-regular-order-intent.ts");
  let pool: { connect: () => Promise<{ query: (sql: string) => Promise<unknown>; release: () => void }> };
  const MODE = "live" as const;

  async function cleanup(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM kalshi_regular_order_intents WHERE window_key LIKE 'DBTEST-%'`);
      await c.query(`DELETE FROM kalshi_regular_exit_intents WHERE window_key LIKE 'DBTEST-%'`);
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

  it("zero_fill RELEASES the reservation (retry allowed)", async () => {
    const wk = "DBTEST-Z";
    assert.equal((await mod.claimRegularOrderIntent(key("cid-z1", wk))).claimed, true);
    await mod.resolveRegularOrderIntent({ clientOrderId: "cid-z1", status: "zero_fill", filledCount: 0 });
    assert.equal((await mod.claimRegularOrderIntent(key("cid-z2", wk))).claimed, true);
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
