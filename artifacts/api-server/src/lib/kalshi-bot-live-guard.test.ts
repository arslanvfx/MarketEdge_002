// Behavioral unit tests for all three live-mode enforcement layers.
//
// Architecture:
//   All three guards delegate to two extracted wrapper functions in
//   kalshi-bot-engine-core.ts (zero I/O, importable without DB):
//
//   Layer 1 — setBotMode
//     Real code: assertSetBotModeAllowed(mode, process.env.NODE_ENV, isKalshiConfigured())
//     Test: call assertSetBotModeAllowed directly — this IS the real setBotMode guard.
//
//   Layer 2 — POST /crypto/bot/mode route handler
//     Real code: if (mode === "live" && !isLiveModePermitted(process.env.NODE_ENV)) { 403 }
//     Test: call isLiveModePermitted + verify the complete 403 decision path, then
//     confirm the route source calls setBotMode only after the guard clears.
//
//   Layer 3 — loadBotConfigFromDB startup restore
//     Real code: applyStartupModeRestore(saved.mode, process.env.NODE_ENV)
//     Test: call applyStartupModeRestore directly — this IS the real startup restore logic.
//
//   Why not import kalshi-bot.ts / routes/kalshi-bot.ts directly:
//     @workspace/db uses extensionless barrel exports (`export * from "./schema"`)
//     which trigger ERR_UNSUPPORTED_DIR_IMPORT in Node's native-ESM test runner.
//     Extracting guards to kalshi-bot-engine-core (zero-dep) is the established
//     pattern for this project (see api-server unit-test memory note).
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLiveModePermitted,
  assertSetBotModeAllowed,
  resolveStartupMode,
  applyStartupModeRestore,
} from "./kalshi-bot-engine-core.ts";
import { computeMarketableLimitPrice } from "./kalshi-trader.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Execution-time min-return enforcement (computeMarketableLimitPrice)
// ---------------------------------------------------------------------------
// The decision-time min-return gate can't be trusted (cache yesPrice is often
// null in production), so the authoritative floor is enforced here by capping
// the marketable-limit price. fill_or_kill then kills any fill below the floor.

test("price-cap: no floor → base marketable-limit behaviour (bid crosses up)", () => {
  // ref 0.50, +0.15 buffer = 0.65; no cap applied
  assert.equal(computeMarketableLimitPrice("bid", 0.5, undefined), 0.65);
  // no ref → fully aggressive
  assert.equal(computeMarketableLimitPrice("bid", null, undefined), 0.99);
  assert.equal(computeMarketableLimitPrice("ask", null, 1), 0.01);
});

test("price-cap: floor unbinding for a high-return YES bet (does not lower price)", () => {
  // ref 0.50 → 0.65; maxCost for 1.44x = 0.694; 0.65 < 0.694 so cap does not bind
  assert.equal(computeMarketableLimitPrice("bid", 0.5, 1.44), 0.65);
});

test("price-cap: floor caps a low-return YES buy at maxCost (cent-rounded down)", () => {
  // ref 0.85 → +0.15 = 1.0 clamped to 0.99; maxCost 1.44x ≈ 0.6944
  // cap binds; bid rounds DOWN to nearest cent → 0.69 (floor(69.44)/100)
  // → return 1/0.69 ≈ 1.449x > 1.44x — constraint satisfied
  const p = computeMarketableLimitPrice("bid", 0.85, 1.44);
  assert.equal(p, 0.69);
  assert.ok(1 / p >= 1.44, `return ${(1 / p).toFixed(4)} must be ≥ 1.44`);
});

test("price-cap: floor raises the ask-side price so NO cost can't exceed maxCost (cent-rounded up)", () => {
  // NO cost = 1 - price. For 1.44x, maxCost ≈ 0.6944 → price floor ≈ 0.3056.
  // ref 0.20 → -0.15 = 0.05; cap raises it; ask rounds UP → 0.31 (ceil(30.56)/100)
  // NO cost = 1 - 0.31 = 0.69 → return 1/0.69 ≈ 1.449x ≥ 1.44x — constraint satisfied
  const p = computeMarketableLimitPrice("ask", 0.2, 1.44);
  assert.equal(p, 0.31);
  const noCost = 1 - p;
  assert.ok(1 / noCost >= 1.44, `return ${(1 / noCost).toFixed(4)} must be ≥ 1.44`);
});

test("price-cap: high-return NO bet is unaffected by the floor", () => {
  // ref 0.90 → NO cost 0.10 (10x). ask price 0.90-0.15=0.75; floor 0.3056 doesn't bind.
  assert.equal(computeMarketableLimitPrice("ask", 0.9, 1.44), 0.75);
});

test("price-cap: floor ≤ 1 disables the cap entirely", () => {
  assert.equal(computeMarketableLimitPrice("bid", 0.85, 1), 0.99);
  assert.equal(computeMarketableLimitPrice("bid", 0.85, 0), 0.99);
});

test("price-cap: result always clamped to the valid 0.01–0.99 range", () => {
  const p = computeMarketableLimitPrice("bid", 0.5, 100); // maxCost 0.01
  assert.ok(p >= 0.01 && p <= 0.99);
});

function readSrc(file: string): string {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

// ===========================================================================
// Layer 1 — setBotMode guard
//
//   setBotMode calls: assertSetBotModeAllowed(mode, NODE_ENV, isKalshiConfigured())
//
//   assertSetBotModeAllowed is the REAL guard function extracted for testability.
//   Testing it exercises the same code path as calling setBotMode — the only
//   difference is that we supply isKalshiConfigured as a boolean parameter
//   instead of calling the live function (which reads KALSHI_API_KEY).
// ===========================================================================

test("Layer1/setBotMode: throws env error for live in development", () => {
  assert.throws(
    () => assertSetBotModeAllowed("live", "development", false),
    { message: "Live betting is only available in the production deployment." },
  );
});

test("Layer1/setBotMode: throws env error for live when NODE_ENV is undefined", () => {
  assert.throws(
    () => assertSetBotModeAllowed("live", undefined, false),
    { message: "Live betting is only available in the production deployment." },
  );
});

test("Layer1/setBotMode: throws env error for live in test environment", () => {
  assert.throws(
    () => assertSetBotModeAllowed("live", "test", false),
    { message: "Live betting is only available in the production deployment." },
  );
});

test("Layer1/setBotMode: throws env error for live in staging environment", () => {
  assert.throws(
    () => assertSetBotModeAllowed("live", "staging", false),
    { message: "Live betting is only available in the production deployment." },
  );
});

test("Layer1/setBotMode: does NOT throw env error for paper in development", () => {
  assert.doesNotThrow(() => assertSetBotModeAllowed("paper", "development", false));
});

test("Layer1/setBotMode: does NOT throw env error for paper when NODE_ENV=undefined", () => {
  assert.doesNotThrow(() => assertSetBotModeAllowed("paper", undefined, false));
});

test("Layer1/setBotMode: env guard clears in production — Kalshi-config check is next", () => {
  // In production with no API key, env guard clears but Kalshi-config guard fires.
  assert.throws(
    () => assertSetBotModeAllowed("live", "production", false /* kalshi not configured */),
    { message: "KALSHI_API_KEY not configured — cannot enable live mode" },
    // Critically: must NOT be the env-guard error
  );
});

test("Layer1/setBotMode: both guards clear in production with Kalshi configured — no throw", () => {
  assert.doesNotThrow(
    () => assertSetBotModeAllowed("live", "production", true /* kalshi configured */),
  );
});

test("Layer1/setBotMode: paper mode never blocked regardless of env or Kalshi config", () => {
  assert.doesNotThrow(() => assertSetBotModeAllowed("paper", "development", false));
  assert.doesNotThrow(() => assertSetBotModeAllowed("paper", "production",  false));
  assert.doesNotThrow(() => assertSetBotModeAllowed("paper", undefined,     false));
  assert.doesNotThrow(() => assertSetBotModeAllowed("paper", "production",  true));
});

// Wiring check: setBotMode source must delegate to assertSetBotModeAllowed
test("Layer1/wiring: setBotMode source delegates to assertSetBotModeAllowed", () => {
  const src = readSrc("kalshi-bot.ts");
  const fnIdx = src.indexOf("export function setBotMode(");
  assert.ok(fnIdx !== -1, "setBotMode must be exported");
  const body = src.slice(fnIdx, fnIdx + 400);
  assert.ok(
    body.includes("assertSetBotModeAllowed("),
    "setBotMode must call assertSetBotModeAllowed — the guard has been removed or renamed",
  );
});

// ===========================================================================
// Layer 2 — POST /crypto/bot/mode route guard
//
//   Route calls: isLiveModePermitted(process.env.NODE_ENV)
//   On false: res.status(403) and early return — setBotMode is NOT called.
//
//   isLiveModePermitted is the exact function the route uses.  We test its
//   semantics exhaustively, then confirm the route's wiring via source check.
// ===========================================================================

test("Layer2/route: isLiveModePermitted false in development → 403 branch (setBotMode not called)", () => {
  // Inline the complete route handler decision without Express I/O:
  const processRouteRequest = (mode: string, env: string | undefined) => {
    if (mode !== "paper" && mode !== "live") return { status: 400, calledSetBotMode: false };
    if (mode === "live" && !isLiveModePermitted(env)) return { status: 403, calledSetBotMode: false };
    return { status: 200, calledSetBotMode: true };
  };

  const result = processRouteRequest("live", "development");
  assert.equal(result.status, 403, "must return 403");
  assert.equal(result.calledSetBotMode, false, "setBotMode must NOT be called when 403 fires");
});

test("Layer2/route: 403 when NODE_ENV is undefined", () => {
  const shouldReturn403 = (mode: string, env: string | undefined) =>
    mode === "live" && !isLiveModePermitted(env);
  assert.equal(shouldReturn403("live", undefined), true);
});

test("Layer2/route: 403 for live in test environment", () => {
  assert.equal(isLiveModePermitted("test"), false);
});

test("Layer2/route: 403 for live in staging environment", () => {
  assert.equal(isLiveModePermitted("staging"), false);
});

test("Layer2/route: paper mode in development — no 403, setBotMode is called", () => {
  const processRouteRequest = (mode: string, env: string | undefined) => {
    if (mode !== "paper" && mode !== "live") return { status: 400, calledSetBotMode: false };
    if (mode === "live" && !isLiveModePermitted(env)) return { status: 403, calledSetBotMode: false };
    return { status: 200, calledSetBotMode: true };
  };

  const result = processRouteRequest("paper", "development");
  assert.notEqual(result.status, 403, "paper must NOT 403");
  assert.equal(result.calledSetBotMode, true, "setBotMode must be called for paper");
});

test("Layer2/route: live mode in production — no 403, setBotMode is called", () => {
  const processRouteRequest = (mode: string, env: string | undefined) => {
    if (mode !== "paper" && mode !== "live") return { status: 400, calledSetBotMode: false };
    if (mode === "live" && !isLiveModePermitted(env)) return { status: 403, calledSetBotMode: false };
    return { status: 200, calledSetBotMode: true };
  };

  const result = processRouteRequest("live", "production");
  assert.notEqual(result.status, 403, "production live must NOT 403");
  assert.equal(result.calledSetBotMode, true, "setBotMode must be called in production");
});

test("Layer2/route: invalid mode returns 400 (not 403)", () => {
  const processRouteRequest = (mode: string, env: string | undefined) => {
    if (mode !== "paper" && mode !== "live") return { status: 400, calledSetBotMode: false };
    if (mode === "live" && !isLiveModePermitted(env)) return { status: 403, calledSetBotMode: false };
    return { status: 200, calledSetBotMode: true };
  };

  const result = processRouteRequest("invalid", "development");
  assert.equal(result.status, 400);
  assert.equal(result.calledSetBotMode, false);
});

// Wiring check: route source must call isLiveModePermitted and return 403
test("Layer2/wiring: route handler source calls isLiveModePermitted and returns 403", () => {
  const src = readSrc("../routes/kalshi-bot.ts");
  assert.ok(
    src.includes("isLiveModePermitted(process.env.NODE_ENV)"),
    "route must call isLiveModePermitted(process.env.NODE_ENV)",
  );
  assert.ok(src.includes("res.status(403)"), "route must return 403 when guard fires");
  // setBotMode must be called AFTER the guard, never before
  const guardIdx = src.indexOf("isLiveModePermitted(process.env.NODE_ENV)");
  const setBotModeCallIdx = src.indexOf("setBotMode(mode", guardIdx);
  assert.ok(setBotModeCallIdx > guardIdx, "setBotMode must be called AFTER the guard block");
});

// ===========================================================================
// Layer 3 — loadBotConfigFromDB startup restore
//
//   Real code: const { effective, didDowngrade } = applyStartupModeRestore(saved.mode, NODE_ENV)
//   If didDowngrade: botMode = effective (paper); _persistModeToConfig() called to rewrite DB.
//
//   applyStartupModeRestore is the REAL startup restore logic extracted for testability.
//   Testing it verifies: (a) mode is correctly downgraded, (b) downgrade is detected
//   so the DB rewrite fires, (c) paper is never changed.
// ===========================================================================

test("Layer3/startup: live+development → effective=paper, didDowngrade=true", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("live", "development");
  assert.equal(effective, "paper", "mode must be downgraded to paper");
  assert.equal(didDowngrade, true, "didDowngrade must be true so DB rewrite fires");
});

test("Layer3/startup: live+undefined → effective=paper, didDowngrade=true", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("live", undefined);
  assert.equal(effective, "paper");
  assert.equal(didDowngrade, true);
});

test("Layer3/startup: live+test → effective=paper, didDowngrade=true", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("live", "test");
  assert.equal(effective, "paper");
  assert.equal(didDowngrade, true);
});

test("Layer3/startup: live+staging → effective=paper, didDowngrade=true", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("live", "staging");
  assert.equal(effective, "paper");
  assert.equal(didDowngrade, true);
});

test("Layer3/startup: live+production → effective=live, didDowngrade=false", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("live", "production");
  assert.equal(effective, "live", "live is preserved in production");
  assert.equal(didDowngrade, false, "no downgrade — DB rewrite must NOT fire");
});

test("Layer3/startup: paper+development → effective=paper, didDowngrade=false", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("paper", "development");
  assert.equal(effective, "paper");
  assert.equal(didDowngrade, false, "paper is never downgraded — no re-persist");
});

test("Layer3/startup: paper+production → effective=paper, didDowngrade=false", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("paper", "production");
  assert.equal(effective, "paper");
  assert.equal(didDowngrade, false);
});

test("Layer3/startup: paper+undefined → effective=paper, didDowngrade=false", () => {
  const { effective, didDowngrade } = applyStartupModeRestore("paper", undefined);
  assert.equal(effective, "paper");
  assert.equal(didDowngrade, false);
});

// Wiring check: loadBotConfigFromDB source must delegate to applyStartupModeRestore
// and set botMode BEFORE _persistModeToConfig (ordering guarantee)
test("Layer3/wiring: loadBotConfigFromDB delegates to applyStartupModeRestore; botMode set before persist", () => {
  const src = readSrc("kalshi-bot-db.ts");
  const fnIdx = src.indexOf("export async function loadBotConfigFromDB(");
  assert.ok(fnIdx !== -1, "loadBotConfigFromDB must be exported");
  const body = src.slice(fnIdx, fnIdx + 2500);
  assert.ok(
    body.includes("applyStartupModeRestore(saved.mode, process.env.NODE_ENV)"),
    "loadBotConfigFromDB must call applyStartupModeRestore",
  );
  // botMode must be assigned before _persistModeToConfig
  const assignIdx = body.indexOf("botMode = effective");
  const persistIdx = body.indexOf("_persistModeToConfig()");
  assert.ok(assignIdx !== -1, "botMode must be assigned to effective");
  assert.ok(persistIdx !== -1, "_persistModeToConfig must be called");
  assert.ok(assignIdx < persistIdx, "botMode = effective must appear BEFORE _persistModeToConfig()");
});

// ===========================================================================
// resolveStartupMode — exhaustive semantic tests (also tested by Layer 3 above)
// ===========================================================================

test("resolveStartupMode: only 'production' permits live", () => {
  const envs: Array<string | undefined> = [
    "development", "test", "staging", undefined, "", "production",
  ];
  for (const env of envs) {
    const result = resolveStartupMode("live", env);
    if (env === "production") {
      assert.equal(result, "live", `env=${String(env)} should preserve live`);
    } else {
      assert.equal(result, "paper", `env=${String(env)} should downgrade to paper`);
    }
  }
});

test("resolveStartupMode: paper is preserved in every environment", () => {
  const envs: Array<string | undefined> = [
    "development", "test", "staging", undefined, "", "production",
  ];
  for (const env of envs) {
    assert.equal(resolveStartupMode("paper", env), "paper", `env=${String(env)}`);
  }
});

// ===========================================================================
// Cross-layer: applyStartupModeRestore consistent with assertSetBotModeAllowed
// ===========================================================================

test("Cross-layer: env permitted by isLiveModePermitted iff resolveStartupMode preserves live", () => {
  const envs: Array<string | undefined> = [
    "development", "test", "staging", undefined, "", "production",
  ];
  for (const env of envs) {
    const permitted = isLiveModePermitted(env);
    const resolved  = resolveStartupMode("live", env);
    assert.equal(
      permitted,
      resolved === "live",
      `env=${String(env)}: isLiveModePermitted=${permitted} must match resolveStartupMode=live(${resolved === "live"})`,
    );
  }
});
