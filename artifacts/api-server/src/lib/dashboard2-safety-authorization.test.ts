import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DASHBOARD2_POLICY } from "./dashboard2-policy.ts";
import {
  Dashboard2SafetyAuthorizationStore,
  type Dashboard2SafetyIdentity,
} from "./dashboard2-safety-authorization.ts";

const identity: Dashboard2SafetyIdentity = {
  mode: "live",
  symbol: "BTC",
  ticker: "KXBTC-TEST",
  windowKey: "2026-01-01T00:00",
  side: "yes",
  policyVersion: DEFAULT_DASHBOARD2_POLICY.version,
  bookVersion: "book-1",
};

test("safety authorization is one use and bound to identity", () => {
  const store = new Dashboard2SafetyAuthorizationStore();
  const authorization = store.issue(identity, DEFAULT_DASHBOARD2_POLICY, 1_000, 1_000);
  assert.deepEqual(store.consume(authorization.token, identity, 1_500), { accepted: true });
  assert.deepEqual(store.consume(authorization.token, identity, 1_500), {
    accepted: false,
    reason: "not_found_or_used",
  });

  const second = store.issue(identity, DEFAULT_DASHBOARD2_POLICY, 1_000, 1_000);
  assert.deepEqual(store.consume(second.token, { ...identity, bookVersion: "book-2" }, 1_500), {
    accepted: false,
    reason: "identity_mismatch",
  });
});

test("safety authorization expires", () => {
  const store = new Dashboard2SafetyAuthorizationStore();
  const authorization = store.issue(identity, DEFAULT_DASHBOARD2_POLICY, 1_000, 500);
  assert.deepEqual(store.consume(authorization.token, identity, 1_500), {
    accepted: false,
    reason: "expired",
  });
});