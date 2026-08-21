// ---------------------------------------------------------------------------
// kalshi-scalper-authz.test.ts — Unit tests for the fail-closed scalper
// mutation authorization decision, plus static route-wiring assertions.
// Run with: node --experimental-strip-types --test
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  decideScalpMutationAuthz,
  getScalpMutationCapability,
} from "./kalshi-scalper-authz.ts";

const ADMIN = "user_admin_123";

describe("decideScalpMutationAuthz (fail-closed)", () => {
  it("missing user (undefined) => 401 unauthenticated", () => {
    const d = decideScalpMutationAuthz(undefined, ADMIN);
    assert.equal(d.allowed, false);
    assert.equal(d.status, 401);
    assert.equal(d.reason, "unauthenticated");
    assert.ok(d.error);
  });

  it("missing user (null) => 401", () => {
    const d = decideScalpMutationAuthz(null, ADMIN);
    assert.equal(d.status, 401);
    assert.equal(d.reason, "unauthenticated");
  });

  it("blank user (whitespace) => 401", () => {
    const d = decideScalpMutationAuthz("   ", ADMIN);
    assert.equal(d.status, 401);
    assert.equal(d.reason, "unauthenticated");
  });

  it("signed-in user but admin config UNSET => 403 operator_not_configured", () => {
    const d = decideScalpMutationAuthz("user_someone", undefined);
    assert.equal(d.allowed, false);
    assert.equal(d.status, 403);
    assert.equal(d.reason, "operator_not_configured");
    assert.match(d.error ?? "", /not configured/i);
  });

  it("signed-in user but admin config BLANK => 403 operator_not_configured", () => {
    const d = decideScalpMutationAuthz("user_someone", "   ");
    assert.equal(d.status, 403);
    assert.equal(d.reason, "operator_not_configured");
  });

  it("signed-in user but admin config empty string => 403 operator_not_configured", () => {
    const d = decideScalpMutationAuthz("user_someone", "");
    assert.equal(d.status, 403);
    assert.equal(d.reason, "operator_not_configured");
  });

  it("ordinary signed-in user (not admin) => 403 not_authorized", () => {
    const d = decideScalpMutationAuthz("user_ordinary", ADMIN);
    assert.equal(d.allowed, false);
    assert.equal(d.status, 403);
    assert.equal(d.reason, "not_authorized");
  });

  it("exact authorized user => allowed (200)", () => {
    const d = decideScalpMutationAuthz(ADMIN, ADMIN);
    assert.equal(d.allowed, true);
    assert.equal(d.status, 200);
    assert.equal(d.reason, "authorized");
    assert.equal(d.error, null);
  });

  it("authorized match ignores surrounding whitespace on both sides", () => {
    const d = decideScalpMutationAuthz(`  ${ADMIN}  `, `  ${ADMIN}  `);
    assert.equal(d.allowed, true);
    assert.equal(d.reason, "authorized");
  });

  it("near-match (case/substring) is NOT authorized", () => {
    assert.equal(decideScalpMutationAuthz(ADMIN.toUpperCase(), ADMIN).reason, "not_authorized");
    assert.equal(decideScalpMutationAuthz(ADMIN + "x", ADMIN).reason, "not_authorized");
    assert.equal(decideScalpMutationAuthz(ADMIN.slice(0, -1), ADMIN).reason, "not_authorized");
  });

  it("fail-closed: no input combination without exact match is allowed", () => {
    const combos: Array<[string | null | undefined, string | null | undefined]> = [
      [undefined, undefined],
      [null, null],
      ["", ""],
      ["user_a", undefined],
      ["user_a", ""],
      ["user_a", "user_b"],
      [undefined, ADMIN],
    ];
    for (const [u, a] of combos) {
      assert.equal(decideScalpMutationAuthz(u, a).allowed, false, `expected deny for user=${u} admin=${a}`);
    }
  });
});

describe("getScalpMutationCapability", () => {
  it("projects authorized access without returning identity values", () => {
    const capability = getScalpMutationCapability(ADMIN, ADMIN);
    assert.deepEqual(capability, {
      canManage: true,
      reason: "authorized",
      message: null,
    });
    assert.ok(!("userId" in capability));
    assert.ok(!("adminId" in capability));
  });

  it("projects the exact denial reason without returning identity values", () => {
    const capability = getScalpMutationCapability("user_other", ADMIN);
    assert.equal(capability.canManage, false);
    assert.equal(capability.reason, "not_authorized");
    assert.match(capability.message ?? "", /not authorized/i);
    assert.ok(!JSON.stringify(capability).includes(ADMIN));
  });
});

// ---------------------------------------------------------------------------
// Static route-wiring assertions (no new packages): confirm both POST mutation
// routes are guarded by the strict helper-backed middleware, and that GET
// routes are NOT gated by it.
// ---------------------------------------------------------------------------

describe("scalper route wiring (static source assertions)", () => {
  const routeSrc = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "routes", "kalshi-scalper.ts"), "utf8");
  })();

  it("imports the pure authz helper", () => {
    assert.match(routeSrc, /decideScalpMutationAuthz/);
    assert.match(routeSrc, /kalshi-scalper-authz/);
  });

  it("POST /crypto/scalper/config is guarded by requireScalpAdmin", () => {
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/config["']\s*,\s*requireScalpAdmin/,
    );
  });

  it("POST /crypto/scalper/reset-circuit-breaker is guarded by requireScalpAdmin", () => {
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/reset-circuit-breaker["']\s*,\s*requireScalpAdmin/,
    );
  });

  it("requireScalpAdmin delegates to the pure helper", () => {
    assert.match(routeSrc, /function requireScalpAdmin[\s\S]*decideScalpMutationAuthz\(/);
  });

  it("GET config/status/history/performance are NOT guarded by requireScalpAdmin", () => {
    for (const path of [
      "/crypto/scalper/capability",
      "/crypto/scalper/config",
      "/crypto/scalper/status",
      "/crypto/scalper/history",
      "/crypto/scalper/performance",
    ]) {
      const re = new RegExp(
        `router\\.get\\(\\s*["']${path.replace(/\//g, "\\/")}["']\\s*,\\s*requireScalpAdmin`,
      );
      assert.ok(!re.test(routeSrc), `GET ${path} must not use requireScalpAdmin`);
    }
  });

  it("GET capability uses the safe capability projection", () => {
    assert.match(
      routeSrc,
      /router\.get\(\s*["']\/crypto\/scalper\/capability["'][\s\S]*getScalpMutationCapability\(/,
    );
  });

  it("no lingering fail-open requireAuth guard remains", () => {
    // The old fail-open guard was named requireAuth; ensure it's gone.
    assert.ok(!/function requireAuth\b/.test(routeSrc), "old requireAuth guard must be removed");
  });
});
