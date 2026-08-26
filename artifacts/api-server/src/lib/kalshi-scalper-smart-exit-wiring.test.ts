import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const service = readFileSync(join(here, "kalshi-scalper-smart-exit-service.ts"), "utf8");
const database = readFileSync(join(here, "kalshi-scalper-smart-exit-db.ts"), "utf8");
const exchange = readFileSync(join(here, "kalshi-scalper-exchange.ts"), "utf8");
const route = readFileSync(join(here, "../routes/kalshi-scalper-smart-exit.ts"), "utf8");

test("Scalper Smart Exit is isolated from regular and Contrarian close ownership", () => {
  const executableSource = service.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(executableSource, /\bclosePosition\b/);
  assert.doesNotMatch(executableSource, /from\s+["'][^"']*contrarian[^"']*["']/i);
  assert.match(service, /placeScalpExitOrderStrict/);
  assert.match(service, /getUnsettledScalpOrders/);
});

test("live activation requires one authenticated request with mode and enabled", () => {
  assert.match(route, /requireOperator/);
  assert.match(service, /patch\.mode === "live-exit"/);
  assert.match(service, /patch\.enabled !== true/);
});

test("reconciliation and settlement continue while execution is disabled", () => {
  const monitor = service.slice(service.indexOf("async function monitor"));
  assert.ok(monitor.indexOf("reconcilePendingRequests()") < monitor.indexOf("!config.enabled"));
  assert.ok(monitor.indexOf("finalizeSettledScalperExitLifecycles()") < monitor.indexOf("!config.enabled"));
});

test("successful live submit responses remain unresolved until authenticated history", () => {
  const liveSubmit = service.slice(
    service.indexOf("const result = await placeScalpExitOrderStrict"),
    service.indexOf("} catch (error)", service.indexOf("const result = await placeScalpExitOrderStrict")),
  );
  assert.match(liveSubmit, /status: "unknown"/);
  assert.doesNotMatch(liveSubmit, /status: "filled"/);
  assert.doesNotMatch(liveSubmit, /status: "partial"/);
  assert.doesNotMatch(liveSubmit, /status: "zero_fill"/);
});

test("paper exit uses the converted executable proceeds price", () => {
  const execute = service.slice(
    service.indexOf("async function executeExit"),
    service.indexOf("async function processOrder"),
  );
  assert.match(execute, /winningPrice: prepared\.executablePrice/);
  assert.match(execute, /computeScalperExitExecutableDepth\(/);
  assert.doesNotMatch(execute, /side === "yes" \? book\.yesDepth : book\.noDepth/);
});

test("dedicated live exit transport is all-or-nothing fill-or-kill", () => {
  assert.match(exchange, /time_in_force: "fill_or_kill"/);
  assert.doesNotMatch(
    exchange.slice(
      exchange.indexOf("export function buildScalpExitOrderBody"),
      exchange.indexOf("export async function placeScalpExitOrderStrict"),
    ),
    /immediate_or_cancel/,
  );
});

test("a pre-submit revalidation block releases ownership before any request attempt", () => {
  const execute = service.slice(
    service.indexOf("async function executeExit"),
    service.indexOf("async function processOrder"),
  );
  const finalDecision = execute.indexOf("const finalDecision = evaluateScalperExit");
  const requestClaim = execute.indexOf("const request = await claimScalperExitRequest");
  const brokerSubmit = execute.indexOf("const result = await placeScalpExitOrderStrict");
  assert.ok(finalDecision >= 0 && finalDecision < requestClaim);
  assert.ok(requestClaim < brokerSubmit);
  assert.match(execute.slice(0, requestClaim), /releaseScalperExitLifecycle/g);
  assert.doesNotMatch(execute.slice(0, requestClaim), /resolveScalperExitRequest/);
  assert.equal((execute.match(/placeScalpExitOrderStrict\(/g) ?? []).length, 1);
});

test("global reducing ownership is row-locked and mode-independent", () => {
  const claim = database.slice(
    database.indexOf("export async function claimScalperExitLifecycle"),
    database.indexOf("export async function claimScalperExitRequest"),
  );
  assert.match(claim, /kalshi_scalp_orders WHERE id=\$1 FOR UPDATE/);
  const unresolvedQuery = claim.slice(
    claim.indexOf("const unresolved"),
    claim.indexOf("if (unresolved.rows[0])"),
  );
  assert.match(unresolvedQuery, /l\.status IN \('requested','unknown'\)/);
  assert.doesNotMatch(unresolvedQuery, /JOIN kalshi_scalper_exit_requests/);
  assert.doesNotMatch(unresolvedQuery, /\bmode\s*=/);
  assert.match(claim, /expectedRemaining/);
  assert.match(claim, /quantity_mismatch/);
  assert.match(claim, /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(claim, /uq_scalper_exit_lifecycle/);
});

test("bounded retry allows at most two durable request attempts per lifecycle", () => {
  const claim = database.slice(
    database.indexOf("export async function claimScalperExitRequest"),
    database.indexOf("export async function resolveScalperExitRequest"),
  );
  assert.match(claim, /priorAttempt >= 2/);
  assert.match(claim, /status IN \('requested','unknown'\)/);
  assert.match(claim, /SET status='requested'/);
});