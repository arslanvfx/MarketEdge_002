import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  decideScalpMutationAuthz,
  getScalpMutationCapability,
} from "./kalshi-scalper-authz.ts";

describe("decideScalpMutationAuthz (matches signed-in bot access)", () => {
  it("fails closed when Clerk provides no usable user identity", () => {
    for (const userId of [undefined, null, "", "   "]) {
      const decision = decideScalpMutationAuthz(userId);
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 401);
      assert.equal(decision.reason, "unauthenticated");
      assert.match(decision.error ?? "", /signed in/i);
    }
  });

  it("allows any authenticated Clerk user", () => {
    for (const userId of ["user_owner", "user_another_account", "  user_trimmed  "]) {
      assert.deepEqual(decideScalpMutationAuthz(userId), {
        allowed: true,
        status: 200,
        error: null,
        reason: "authorized",
      });
    }
  });
});

describe("getScalpMutationCapability", () => {
  it("reports management access for a signed-in user without exposing identity", () => {
    const capability = getScalpMutationCapability("user_owner");
    assert.deepEqual(capability, {
      canManage: true,
      reason: "authorized",
      message: null,
    });
    assert.ok(!("userId" in capability));
    assert.ok(!JSON.stringify(capability).includes("user_owner"));
  });

  it("reports signed-out access safely", () => {
    assert.deepEqual(getScalpMutationCapability(null), {
      canManage: false,
      reason: "unauthenticated",
      message: "Unauthorized — must be signed in",
    });
  });
});

describe("scalper route wiring (static source assertions)", () => {
  const routeSrc = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "routes", "kalshi-scalper.ts"), "utf8");
  })();

  it("uses Clerk authentication without a separate secret or role store", () => {
    assert.match(
      routeSrc,
      /function requireScalpAdmin[\s\S]*decideScalpMutationAuthz\(getAuth\(req\)\?\.userId\)/,
    );
    assert.doesNotMatch(routeSrc, /BOT_ADMIN_CLERK_USER_ID/);
    assert.doesNotMatch(routeSrc, /getScalpAdminState|claimInitialScalpAdmin/);
    assert.doesNotMatch(routeSrc, /\/crypto\/scalper\/admin\/claim/);
  });

  it("guards both Scalper mutation routes", () => {
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/config["']\s*,\s*requireScalpAdmin/,
    );
    assert.match(
      routeSrc,
      /router\.post\(\s*["']\/crypto\/scalper\/reset-circuit-breaker["']\s*,\s*requireScalpAdmin/,
    );
  });

  it("keeps the capability response identity-free", () => {
    assert.match(
      routeSrc,
      /router\.get\(\s*["']\/crypto\/scalper\/capability["'][\s\S]*getScalpMutationCapability\(getAuth\(req\)\?\.userId\)/,
    );
  });
});