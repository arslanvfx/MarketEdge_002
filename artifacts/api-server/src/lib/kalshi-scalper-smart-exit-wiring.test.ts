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

test("filled positions use the configured spot product and refresh their exact market before identity checks", () => {
  assert.match(service, /PRODUCT_BY_SYMBOL = new Map\(CRYPTO_COINS/);
  const processOrder = service.slice(
    service.indexOf("async function processOrder"),
    service.indexOf("async function refreshActiveOrders"),
  );
  assert.match(processOrder, /getHotSpotReceipt\(product\)/);
  assert.doesNotMatch(processOrder, /getHotSpotReceipt\(order\.symbol\)/);
  assert.match(processOrder, /getHotTarget\(order, cachedMarket\)/);
  const targetHelper = service.slice(
    service.indexOf("function getHotTarget"),
    service.indexOf("async function withinHotEvidenceDeadline"),
  );
  assert.match(targetHelper, /cachedMarket\?\.ticker === order\.ticker/);
  assert.match(targetHelper, /Promise\.resolve\(cachedMarket\.value\)/);
  assert.match(targetHelper, /fetchKalshiTarget\(/);
});

test("final pre-submit spot validation uses the configured product rather than the display symbol", () => {
  const execute = service.slice(
    service.indexOf("async function executeExit"),
    service.indexOf("async function processOrder"),
  );
  assert.match(execute, /PRODUCT_BY_SYMBOL\.get\(params\.order\.symbol\.toUpperCase\(\)\)/);
  assert.match(execute, /getTickerFreshEvidence\(product, finalEvidenceController\.signal\)/);
  assert.doesNotMatch(execute, /getTickerFreshEvidence\(params\.order\.symbol\)/);
});

test("discovery excludes expired and cross-mode orders before warming the active-order read view", () => {
  const discovery = service.slice(
    service.indexOf("async function refreshActiveOrders"),
    service.indexOf("function noteHotTick"),
  );
  assert.match(discovery, /expiry\(order\.windowKey\) > Date\.now\(\)/);
  assert.match(discovery, /modeIncludesOrder\(order\)/);
  assert.match(discovery, /getScalperExitOrderStates/);
  assert.match(discovery, /hasUnresolvedOwner/);
  assert.match(discovery, /activeOrders\.set/);
});

test("the 250ms hot lane is coalesced per order and bounded independently of maintenance", () => {
  const hot = service.slice(
    service.indexOf("function runHotMonitorPass"),
    service.indexOf("async function flushEvaluationWrites"),
  );
  assert.match(service, /const HOT_SCHEDULER_MS = 250/);
  assert.match(hot, /selectScalperHotCandidates/);
  assert.match(hot, /hotOrdersInFlight\.add/);
  assert.match(hot, /processOrder\(/);
  assert.match(hot, /hotOrdersInFlight\.delete/);
  assert.doesNotMatch(hot, /reconcilePendingRequests|finalizeSettledScalperExitLifecycles|getUnsettledScalpOrders/);
});

test("hot evidence is deadline-bounded and coalesced instead of spawning overlapping provider calls", () => {
  assert.match(service, /const HOT_EVIDENCE_DEADLINE_MS = 700/);
  assert.match(service, /hotSpotRequests\.getOrCreate\(product/);
  assert.match(service, /hotBookRequests\.getOrCreate\(ticker/);
  assert.match(service, /withinHotEvidenceDeadline\(Promise\.all/);
  assert.match(service, /publishHotBlock\([\s\S]*hot evidence exceeded/);
  assert.match(service, /spotRequest\.abort\(\)/);
  assert.match(service, /targetRequest\.abort\(\)/);
  assert.match(service, /bookRequest\.abort\(\)/);
  assert.match(service, /hot-lane capacity exceeded; evaluation deferred/);
});

test("expiry is rechecked before ownership, durable request claim, and broker submission", () => {
  const processOrder = service.slice(
    service.indexOf("async function processOrder"),
    service.indexOf("async function refreshActiveOrders"),
  );
  const execute = service.slice(
    service.indexOf("async function executeExit"),
    service.indexOf("async function processOrder"),
  );
  assert.match(processOrder, /market expired before ownership claim/);
  assert.match(execute, /market expired before final revalidation/);
  assert.match(execute, /market expired during final evidence fetch/);
  assert.match(execute, /market expired before durable request claim/);
  assert.match(execute, /market expired after durable request claim, before broker submit/);
  const finalBoundary = execute.indexOf("market expired at final broker boundary");
  const brokerSubmit = execute.indexOf("placeScalpExitOrderStrict");
  assert.ok(finalBoundary >= 0 && finalBoundary < brokerSubmit);
});

test("live activation requires one authenticated request with mode and enabled", () => {
  assert.match(route, /requireOperator/);
  assert.match(service, /patch\.mode === "live-exit"/);
  assert.match(service, /patch\.enabled !== true/);
});

test("reconciliation and settlement continue while execution is disabled", () => {
  const maintenance = service.slice(
    service.indexOf("async function runMaintenance"),
    service.indexOf("export async function initScalperSmartExit"),
  );
  assert.match(maintenance, /reconcilePendingRequests\(\)/);
  assert.match(maintenance, /finalizeSettledScalperExitLifecycles\(\)/);
  assert.doesNotMatch(maintenance, /!config\.enabled/);
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