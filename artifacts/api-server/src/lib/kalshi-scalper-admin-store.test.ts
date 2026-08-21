import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  claimInitialScalpAdmin,
  getScalpAdminState,
} from "./kalshi-scalper-admin-store.ts";

type FakeResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

function fakeQueryable(results: FakeResult[]) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const next = results.shift();
      if (!next) throw new Error("Unexpected query");
      return next;
    },
  };
}

describe("getScalpAdminState", () => {
  it("uses a bound identity parameter and returns boolean role state", async () => {
    const queryable = fakeQueryable([
      { rows: [{ has_admin: true, is_admin: false }], rowCount: 1 },
    ]);
    const state = await getScalpAdminState(" user_current ", queryable);
    assert.deepEqual(state, { hasAdmin: true, isAdmin: false });
    assert.deepEqual(queryable.calls[0]?.values, ["user_current"]);
    assert.match(queryable.calls[0]?.text ?? "", /clerk_user_id = \$1/);
  });
});

describe("claimInitialScalpAdmin", () => {
  it("returns claimed when the atomic insert wins", async () => {
    const queryable = fakeQueryable([
      { rows: [{ clerk_user_id: "user_first" }], rowCount: 1 },
    ]);
    const result = await claimInitialScalpAdmin("user_first", queryable);
    assert.equal(result.status, "claimed");
    assert.deepEqual(result.state, { hasAdmin: true, isAdmin: true });
    assert.match(queryable.calls[0]?.text ?? "", /ON CONFLICT DO NOTHING/);
    assert.deepEqual(queryable.calls[0]?.values, ["user_first"]);
  });

  it("is idempotent for the account that already holds the role", async () => {
    const queryable = fakeQueryable([
      { rows: [], rowCount: 0 },
      { rows: [{ has_admin: true, is_admin: true }], rowCount: 1 },
    ]);
    const result = await claimInitialScalpAdmin("user_first", queryable);
    assert.equal(result.status, "already_admin");
  });

  it("denies a later account after another admin won the claim", async () => {
    const queryable = fakeQueryable([
      { rows: [], rowCount: 0 },
      { rows: [{ has_admin: true, is_admin: false }], rowCount: 1 },
    ]);
    const result = await claimInitialScalpAdmin("user_later", queryable);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.state, { hasAdmin: true, isAdmin: false });
  });
});