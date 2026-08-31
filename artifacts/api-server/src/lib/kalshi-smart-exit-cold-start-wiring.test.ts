import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const service = readFileSync(join(here, "kalshi-smart-exit-service.ts"), "utf8");
const database = readFileSync(join(here, "kalshi-smart-exit-db.ts"), "utf8");

test("collector prewarms every supported underlying at startup and remains active while Smart Exit is off", () => {
  assert.match(service, /const PREWARMABLE_COINS = CRYPTO_COINS;/);
  assert.match(service, /getKalshiPythValueEvidence/);
  assert.match(service, /getKalshiCfBenchmarksValueEvidence/);
  assert.match(service, /readCfBenchmarks/);
  const init = service.slice(
    service.indexOf("export async function initSmartExit"),
    service.indexOf("export function getSmartExitConfig"),
  );
  assert.match(init, /Promise\.allSettled\(PREWARMABLE_COINS\.map/);
  assert.ok(init.indexOf("Promise.allSettled") < init.indexOf("startScheduler()"));

  const cycle = service.slice(
    service.indexOf("async function runCycle"),
    service.indexOf("function stopScheduler"),
  );
  const offBranch = cycle.slice(
    cycle.indexOf("!config.enabled || config.mode === \"off\""),
    cycle.indexOf("const regular"),
  );
  assert.match(offBranch, /void collectSlowEvidence/);

  const stop = service.slice(
    service.indexOf("function stopScheduler"),
    service.indexOf("function startScheduler"),
  );
  assert.doesNotMatch(stop, /collector\.(?:clear|stop)\(/);
});

test("active slow evidence is collected before inactive prewarming and both owners use the hot lane", () => {
  const merge = service.slice(
    service.indexOf("function mergeHotSpotWithSlowEvidence"),
    service.indexOf("function collectHotSpot"),
  );
  assert.match(merge, /source: hot\.source/);
  assert.match(merge, /spotSourceSequence: hot\.spotSourceSequence/);
  assert.match(merge, /spotTrajectoryAtSeconds: hot\.spotTrajectoryAtSeconds/);
  assert.match(merge, /failureReason: hot\.failureReason/);

  const slowCycle = service.slice(
    service.indexOf("async function runCycle"),
    service.indexOf("async function runHotCycle"),
  );
  assert.ok(slowCycle.indexOf("await Promise.all(entries.map") >= 0);
  assert.ok(slowCycle.indexOf("await Promise.all(entries.map") < slowCycle.indexOf("inactivePrewarmable"));
  assert.match(slowCycle, /void collectSlowEvidence\(coin\.symbol, coin\.product\)/);

  const hotCycle = service.slice(
    service.indexOf("async function runHotCycle"),
    service.indexOf("function stopScheduler"),
  );
  assert.match(hotCycle, /cachedScalperPositions\.filter/);
  assert.match(hotCycle, /collectHotSpot\(entry\.symbol, definition\.product\)/);
  assert.match(hotCycle, /scalperSnapshot\(raw as Record<string, unknown>, evidence\)/);
  assert.doesNotMatch(hotCycle, /definition\.category === "commodity"/);
});

test("commodity Smart Exit uses the same final revalidation and authenticated book path", () => {
  const execute = service.slice(
    service.indexOf("async function executeAuthorizedExit"),
    service.indexOf("async function recordLifecycleTrigger"),
  );
  assert.doesNotMatch(execute, /definition\.category === "commodity"/);
  assert.match(execute, /const hot = await collectHotSpot/);
  assert.match(execute, /await refreshBook\(position\.ticker\)/);
  assert.match(execute, /executionEvidenceReady/);
  assert.match(execute, /requestSmartExitFromOwner/);
});

test("Kalshi settlement health requires both fresh receipt and source publication time", () => {
  const health = service.slice(
    service.indexOf("export function getSmartExitHealth"),
    service.indexOf("export function getSmartExitStatus"),
  );
  assert.match(health, /const settlementSourceFresh/);
  assert.match(health, /item\.source === "kalshi-cfbenchmarks"/);
  assert.match(health, /nowSeconds - item\.spotReceivedAtSeconds <= config\.maxEvidenceAgeSeconds/);
  assert.match(health, /nowSeconds - item\.spotObservedAtSeconds <= config\.maxEvidenceAgeSeconds/);
  assert.match(health, /ready = item\.ready && settlementSourceFresh/);
});

test("evidence recovery cannot create a duplicate owner exit request", () => {
  const execute = service.slice(
    service.indexOf("async function executeAuthorizedExit"),
    service.indexOf("async function recordLifecycleTrigger"),
  );
  const claim = execute.indexOf("claimSmartExitRequest");
  const ownerRequest = execute.indexOf("requestSmartExitFromOwner");
  assert.ok(claim >= 0 && claim < ownerRequest);
  assert.match(execute.slice(claim, ownerRequest), /if \(!claim\.claimed\)/);

  assert.match(
    database,
    /CREATE TABLE IF NOT EXISTS kalshi_smart_exit_requests[\s\S]*?UNIQUE \(owner, position_id\)/,
  );

  const durableClaim = database.slice(
    database.indexOf("export async function claimSmartExitRequest"),
    database.indexOf("export async function resolveSmartExitRequest"),
  );
  assert.match(durableClaim, /ON CONFLICT \(owner,position_id\) DO NOTHING/);
  assert.match(durableClaim, /exit_request_exists/);
});

test("both owner entry baselines require fresh authenticated settlement evidence", () => {
  const regularCapture = service.slice(
    service.indexOf("export function captureSmartExitRegularEntry"),
    service.indexOf("function numeric"),
  );
  assert.match(regularCapture, /smartExitSettlementSpotIsFresh/);
  assert.ok(
    regularCapture.indexOf("smartExitSettlementSpotIsFresh")
      < regularCapture.indexOf("modelWinProbability"),
  );

  const scalper = service.slice(
    service.indexOf("function scalperSnapshot"),
    service.indexOf("function reasonCode"),
  );
  assert.match(scalper, /smartExitSettlementSpotIsFresh/);
  assert.ok(
    scalper.indexOf("smartExitSettlementSpotIsFresh")
      < scalper.indexOf("modelWinProbability"),
  );
});