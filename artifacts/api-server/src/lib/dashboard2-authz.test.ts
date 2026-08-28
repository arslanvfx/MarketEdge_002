import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decideDashboard2OperatorAuthz } from "./dashboard2-authz.ts";

test("Dashboard 2 operator authorization rejects unsigned users and enforces configured operators", () => {
  assert.equal(decideDashboard2OperatorAuthz({ userId: null }), "unauthenticated");
  assert.equal(decideDashboard2OperatorAuthz({
    userId: "user-ordinary",
    sessionClaims: { publicMetadata: { role: "member" } },
    configuredUserIds: "user-operator",
  }), "forbidden");
  assert.equal(decideDashboard2OperatorAuthz({
    userId: "user-ordinary",
    configuredUserIds: "user-operator",
  }), "forbidden");
});

test("Dashboard 2 allows signed-in users when no operator allowlist is configured", () => {
  assert.equal(decideDashboard2OperatorAuthz({ userId: "user-signed-in" }), "allowed");
  assert.equal(decideDashboard2OperatorAuthz({
    userId: "user-signed-in",
    configuredUserIds: " , ",
  }), "allowed");
});

test("Dashboard 2 operator authorization allows only explicit IDs or verified roles", () => {
  assert.equal(decideDashboard2OperatorAuthz({
    userId: "user-operator",
    configuredUserIds: "user-other, user-operator",
  }), "allowed");
  assert.equal(decideDashboard2OperatorAuthz({
    userId: "user-role",
    sessionClaims: { public_metadata: { role: "trading_operator" } },
  }), "allowed");
  assert.equal(decideDashboard2OperatorAuthz({
    userId: "user-admin",
    sessionClaims: { metadata: { role: "admin" } },
  }), "allowed");
});

test("every Dashboard 2 mutation route is wired through the operator guard", () => {
  const source = readFileSync(new URL("../routes/dashboard2.ts", import.meta.url), "utf8");
  for (const route of [
    "/v2/dashboard2/execution-owner",
    "/v2/dashboard2/mode",
    "/v2/dashboard2/config/:mode",
    "/v2/dashboard2/:mode/start",
    "/v2/dashboard2/:mode/pause",
  ]) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      source,
      new RegExp(`router\\.(?:patch|post)\\("${escaped}",\\s*requireDashboard2Operator`),
      `${route} must require operator authorization`,
    );
  }
});