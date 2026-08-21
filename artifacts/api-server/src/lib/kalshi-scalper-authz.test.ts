import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  decideScalpMutationAuthz,
  getScalpMutationCapability,
  type ScalpAdminState,
} from "./kalshi-scalper-authz.ts";

const NO_ADMIN: ScalpAdminState = { hasAdmin: false, isAdmin: false };
const NON_ADMIN: ScalpAdminState = { hasAdmin: true, isAdmin: false };
const ADMIN: ScalpAdminState = { hasAdmin: true, isAdmin: true };

describe("decideScalpMutationAuthz (fail-closed role authorization)", () => {
  it("denies missing and blank authenticated users", () => {
    for (const userId of [undefined, null, "", "   "]) {
      const decision = decideScalpMutationAuthz(userId, ADMIN);
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 401);
      assert.equal(decision.reason, "unauthenticated");
    }
  });

  it("denies normal writes before the first admin is claimed", () => {
    const decision = decideScalpMutationAuthz("user_first", NO_ADMIN);
    assert.equal(decision.allowed, false);
    assert.equal(decision.status, 403);
    assert.equal(decision.reason, "bootstrap_available");
    assert.match(decision.error ?? "", /no Scalper administrator/i);
  });

  it("denies a signed-in user without the persisted admin role", () => {
    const decision = decideScalpMutationAuthz("user_ordinary", NON_ADMIN);
    assert.equal(decision.allowed, false);
    assert.equal(decision.status, 403);
    assert.equal(decision.reason, "not_authorized");
  });

  it("allows a signed-in user with the persisted admin role", () => {
    const decision = decideScalpMutationAuthz("user_admin", ADMIN);
    assert.deepEqual(decision, {
      allowed: true,
      status: 200,
      error: null,
      reason: "authorized",
    });
  });

  it("never treats isAdmin=false as authorized", () => {
    for (const state of [NO_ADMIN, NON_ADMIN]) {
      assert.equal(
        decideScalpMutationAuthz("user_signed_in", state).allowed,
        false,
      );
    }
  });
});

describe("getScalpMutationCapability", () => {
  it("offers the one-time claim only to an authenticated user when no admin exists", () => {
    assert.deepEqual(
      getScalpMutationCapability("user_first", NO_ADMIN),
      {
        canManage: false,
        canClaimAdmin: true,
        reason: "bootstrap_available",
        message: "Forbidden — no Scalper administrator has been claimed",
      },
    );
  });

  it("does not offer a claim to a signed-out request", () => {
    const capability = getScalpMutationCapability(null, NO_ADMIN);
    assert.equal(capability.canManage, false);
    assert.equal(capability.canClaimAdmin, false);
    assert.equal(capability.reason, "unauthenticated");
  });

  it("projects authorized access without returning identity values", () => {
    const capability = getScalpMutationCapability("user_admin", ADMIN);
    assert.deepEqual(capability, {
      canManage: true,
      canClaimAdmin: false,
      reason: "authorized",
      message: null,
    });
    assert.ok(!("userId" in capability));
    assert.ok(!JSON.stringify(capability).includes("user_admin"));
  });
});

describe("scalper route wiring (static source assertions)", () => {
  const routeSrc = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "routes", "kalshi-scalper.ts"), "utf8");
  })();

  it("uses the persisted role store and not BOT_ADMIN_CLERK_USER_ID", () => {
    assert.match(routeSrc, /getScalpAdminState/);
    assert.match(routeSrc, /claimInitialScalpAdmin/);
    assert.doesNotMatch(routeSrc, /BOT_ADMIN_CLERK_USER_ID/);
  });

  it("guards both Scalper mutation routes with requireScalpAdmin", () => {
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/config["']\s*,\s*requireScalpAdmin/,
    );
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/reset-circuit-breaker["']\s*,\s*requireScalpAdmin/,
    );
  });

  it("requires Clerk authentication and an atomic store claim for bootstrap", () => {
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/admin\/claim["'][\s\S]*getAuth\(req\)[\s\S]*claimInitialScalpAdmin\(userId\)/,
    );
  });

  it("keeps read-only Scalper routes outside requireScalpAdmin", () => {
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
      assert.ok(!re.test(routeSrc), `GET ${path} must remain read-only`);
    }
  });
});