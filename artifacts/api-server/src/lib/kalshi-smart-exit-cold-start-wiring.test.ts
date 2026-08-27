import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const service = readFileSync(join(here, "kalshi-smart-exit-service.ts"), "utf8");
const database = readFileSync(join(here, "kalshi-smart-exit-db.ts"), "utf8");

test("collector prewarms every supported crypto at startup and remains active while Smart Exit is off", () => {
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
  assert.ok(cycle.indexOf("await collector.collect") < cycle.indexOf("!config.enabled || config.mode === \"off\""));

  const stop = service.slice(
    service.indexOf("function stopScheduler"),
    service.indexOf("function startScheduler"),
  );
  assert.doesNotMatch(stop, /collector\.(?:clear|stop)\(/);
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