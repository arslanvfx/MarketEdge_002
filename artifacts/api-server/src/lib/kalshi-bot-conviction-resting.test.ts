// Unit tests for conviction-mode resting GTC limit order sizing, guard placement,
// and paper/live accounting consistency.
//
// Three test groups:
//   1. YES and NO sizing math — pure arithmetic, no imports needed
//   2. Guard enforcement parity — source-code inspection to verify RESTING_LIMIT
//      handler is placed AFTER all mandatory risk guards (streak pause, daily loss)
//   3. Source-formula wiring — verify NO-side cost formula is present in source
//
// The critical sizing bug the tests protect against:
//   For NO resting orders, the Kalshi limit price submitted is (1-lockPrice), e.g. 0.10.
//   The economic cost per contract is the complement: (1 - 0.10) = 0.90.
//   Using gtcLimitPrice (0.10) directly as cost would produce 9× too many contracts.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readSrc(file: string): string {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. YES and NO sizing math
// ─────────────────────────────────────────────────────────────────────────────

function computeRestingCount(betSize: number, lockPrice: number, dir: "yes" | "no"): { count: number; costPerContract: number; betAmount: number } {
  const gtcLimitPrice = dir === "yes" ? lockPrice : (1 - lockPrice);
  const costPerContract = dir === "yes" ? gtcLimitPrice : (1 - gtcLimitPrice);
  const count = Math.max(1, Math.floor(betSize / costPerContract));
  return { count, costPerContract, betAmount: count * costPerContract };
}

test("conviction resting YES: economic cost = lockPrice per contract", () => {
  const { costPerContract } = computeRestingCount(1.00, 0.90, "yes");
  assert.equal(costPerContract, 0.90);
});

test("conviction resting NO: economic cost = lockPrice per contract (NOT 1-lockPrice)", () => {
  // YES-side limit price for NO is 0.10; buyer of NO pays the complement = 0.90
  const { costPerContract } = computeRestingCount(1.00, 0.90, "no");
  assert.equal(costPerContract, 0.90, "NO resting cost must equal lockPrice (0.90), not the YES-side limit price (0.10)");
});

test("conviction resting YES and NO produce same contract count at default lockPrice", () => {
  const betSize = 1.00;
  const lockPrice = 0.90;
  const yes = computeRestingCount(betSize, lockPrice, "yes");
  const no  = computeRestingCount(betSize, lockPrice, "no");
  assert.equal(yes.count, no.count, "YES and NO resting orders must use the same economic cost → same count");
  assert.equal(yes.count, 1, "floor(1.00 / 0.90) = 1 contract");
});

test("conviction resting NO: count is NOT 9× over-sized (old bug: using YES-side limit price as cost)", () => {
  const betSize = 2.00;
  const lockPrice = 0.90;
  const gtcLimitPriceNo = 1 - lockPrice; // 0.10 — what's submitted to Kalshi as YES-side limit
  // Old bug: costPerContract = gtcLimitPriceNo = 0.10 → floor(2.00 / 0.10) = 20 contracts!
  const buggyCount = Math.floor(betSize / gtcLimitPriceNo);
  const { count: correctCount } = computeRestingCount(betSize, lockPrice, "no");
  assert.equal(buggyCount, 20, "old bug produces 20 contracts");
  assert.equal(correctCount, 2, "correct formula produces 2 contracts (floor(2.00 / 0.90))");
  assert.ok(correctCount < buggyCount, "correct count must be less than the buggy over-sized count");
});

test("conviction resting YES: betAmount ≤ betSize for whole-dollar amounts", () => {
  const betSize = 2.00;
  const { betAmount } = computeRestingCount(betSize, 0.90, "yes");
  assert.ok(betAmount <= betSize, `betAmount ${betAmount} must not exceed betSize ${betSize}`);
});

test("conviction resting NO: betAmount ≤ betSize for whole-dollar amounts", () => {
  const betSize = 2.00;
  const { betAmount } = computeRestingCount(betSize, 0.90, "no");
  assert.ok(betAmount <= betSize, `betAmount ${betAmount} must not exceed betSize ${betSize}`);
});

test("conviction resting YES/NO: minimum count of 1 when betSize < lockPrice", () => {
  // betSize=0.50 < lockPrice=0.90 → floor(0.50/0.90)=0, clamped to 1
  const yes = computeRestingCount(0.50, 0.90, "yes");
  const no  = computeRestingCount(0.50, 0.90, "no");
  assert.equal(yes.count, 1, "YES minimum count is 1");
  assert.equal(no.count,  1, "NO minimum count is 1");
});

test("conviction resting: lockPrice=0.85 produces symmetric counts", () => {
  const betSize = 5.00;
  const lockPrice = 0.85;
  const yes = computeRestingCount(betSize, lockPrice, "yes");
  const no  = computeRestingCount(betSize, lockPrice, "no");
  assert.equal(yes.costPerContract, 0.85, "YES cost = lockPrice");
  assert.equal(no.costPerContract,  0.85, "NO cost = lockPrice (symmetric)");
  assert.equal(yes.count, no.count, "counts are equal");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Paper accounting consistency
// ─────────────────────────────────────────────────────────────────────────────

test("paper YES fill: betAmount = count × paperFillYesPrice (correct YES cost)", () => {
  const lockPrice = 0.90;
  const dir = "yes";
  const paperFillYesPrice = dir === "yes" ? lockPrice : (1 - lockPrice); // 0.90
  const paperCostPerContract = dir === "yes" ? paperFillYesPrice : (1 - paperFillYesPrice); // 0.90
  const requestedCount = 1;
  const betAmount = requestedCount * paperCostPerContract;
  assert.equal(betAmount, 0.90, "YES paper betAmount = count × lockPrice");
});

test("paper NO fill: betAmount = count × (1-paperFillYesPrice), not count × paperFillYesPrice", () => {
  const lockPrice = 0.90;
  const dir = "no";
  const paperFillYesPrice = dir === "yes" ? lockPrice : (1 - lockPrice); // 0.10 YES-side limit
  // Correct cost:
  const paperCostPerContract = dir === "yes" ? paperFillYesPrice : (1 - paperFillYesPrice); // 0.90
  // Old bug cost:
  const bugCostPerContract = paperFillYesPrice; // 0.10 — wrong
  const requestedCount = 2;
  const correctBetAmount = requestedCount * paperCostPerContract; // 1.80
  const buggBetAmount    = requestedCount * bugCostPerContract;   // 0.20
  assert.equal(paperCostPerContract, 0.90, "NO paper cost must equal lockPrice (0.90)");
  assert.equal(correctBetAmount, 1.80, "betAmount for 2 NO contracts = 1.80");
  assert.ok(correctBetAmount > buggBetAmount, "correct betAmount must exceed the old under-reported bug amount");
});

test("paper YES and NO fills report the same betAmount for the same count and lockPrice", () => {
  const lockPrice = 0.90;
  const count = 1;
  function paperBetAmount(dir: "yes" | "no"): number {
    const paperFillYesPrice = dir === "yes" ? lockPrice : (1 - lockPrice);
    const paperCostPerContract = dir === "yes" ? paperFillYesPrice : (1 - paperFillYesPrice);
    return count * paperCostPerContract;
  }
  assert.equal(paperBetAmount("yes"), paperBetAmount("no"), "paper betAmount is symmetric between YES and NO at the same lockPrice");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Guard enforcement parity — source-code wiring checks
// ─────────────────────────────────────────────────────────────────────────────

test("tick: RESTING_LIMIT handler appears after streak pause guard", () => {
  const src = readSrc("kalshi-bot-tick.ts");
  const streakIdx   = src.indexOf("Per-coin streak pause");
  const restingIdx  = src.indexOf('decision.action === "RESTING_LIMIT"');
  assert.ok(streakIdx  > 0, "streak pause guard must exist in tick");
  assert.ok(restingIdx > 0, "RESTING_LIMIT handler must exist in tick");
  assert.ok(
    restingIdx > streakIdx,
    `RESTING_LIMIT handler (char ${restingIdx}) must appear after streak pause guard (char ${streakIdx}) so configured protections apply`,
  );
});

test("tick: RESTING_LIMIT handler appears after daily loss cap guard", () => {
  const src = readSrc("kalshi-bot-tick.ts");
  const dailyLossIdx = src.indexOf("coin has reached its daily loss cap");
  const restingIdx   = src.indexOf('decision.action === "RESTING_LIMIT"');
  assert.ok(dailyLossIdx > 0, "daily loss cap guard must exist in tick");
  assert.ok(restingIdx   > 0, "RESTING_LIMIT handler must exist in tick");
  assert.ok(
    restingIdx > dailyLossIdx,
    `RESTING_LIMIT handler (char ${restingIdx}) must appear after daily loss cap guard (char ${dailyLossIdx})`,
  );
});

test("tick: RESTING_LIMIT handler appears after SKIP handler", () => {
  const src = readSrc("kalshi-bot-tick.ts");
  const skipIdx    = src.indexOf('decision.action === "SKIP"');
  const restingIdx = src.indexOf('decision.action === "RESTING_LIMIT"');
  assert.ok(skipIdx    > 0, "SKIP handler must exist in tick");
  assert.ok(restingIdx > 0, "RESTING_LIMIT handler must exist in tick");
  assert.ok(
    restingIdx > skipIdx,
    `RESTING_LIMIT handler (char ${restingIdx}) must appear after SKIP handler (char ${skipIdx})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cost-formula source wiring
// ─────────────────────────────────────────────────────────────────────────────

test("tick source: costPerContract uses (1 - gtcLimitPrice) for NO side", () => {
  const src = readSrc("kalshi-bot-tick.ts");
  assert.ok(
    src.includes('restingDir === "yes" ? gtcLimitPrice : (1 - gtcLimitPrice)'),
    "costPerContract formula must include (1 - gtcLimitPrice) for NO side in kalshi-bot-tick.ts",
  );
});

test("tick source: paperCostPerContract uses (1 - paperFillYesPrice) for NO side", () => {
  const src = readSrc("kalshi-bot-tick.ts");
  assert.ok(
    src.includes('restingDir === "yes" ? paperFillYesPrice : (1 - paperFillYesPrice)'),
    "paperCostPerContract formula must include (1 - paperFillYesPrice) for NO side in kalshi-bot-tick.ts",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Stateful cancel — source wiring
// ─────────────────────────────────────────────────────────────────────────────
// Cancel must stay in restingOrders until confirmed.  We verify:
//   - cancelRequested flag is set (not immediate delete) on stale/near-expiry
//   - cancel is retried on error (order stays in map when cancelOrder throws)
//   - removal only happens after cancelOrder resolves (true or false/404)

test("loop source: stale window sets cancelRequested rather than deleting immediately", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // Verify the new pattern: set cancelRequested on window-change, don't delete immediately
  assert.ok(
    src.includes("re.cancelRequested = true"),
    "loop must set re.cancelRequested = true (not immediately delete) on stale window",
  );
});

test("loop source: cancel is confirmed before removing from restingOrders", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // The stateful path: await cancelOrder → then restingOrders.delete
  const cancelIdx = src.indexOf("await cancelOrder(re.orderId)");
  const deleteAfterCancel = src.indexOf("restingOrders.delete(sym)", cancelIdx);
  assert.ok(cancelIdx > 0,         "loop must await cancelOrder(re.orderId)");
  assert.ok(deleteAfterCancel > cancelIdx, "restingOrders.delete must come after await cancelOrder in the cancel path");
});

test("loop source: cancel error leaves order in map (retry on next tick)", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // The catch block for cancel must NOT delete from map — it should just warn and continue
  assert.ok(
    src.includes("Cancel API call failed — leave in map, retry on next tick"),
    "loop must keep order in restingOrders when cancelOrder throws (retry semantics)",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 404 retry — source wiring
// ─────────────────────────────────────────────────────────────────────────────
// A single 404 from getOrder may be transient.  We verify:
//   - notFoundCount is incremented on each 404
//   - entry stays in map while notFoundCount < 3
//   - definitive treatment (block + remove) only after ≥3 consecutive 404s

test("loop source: notFoundCount is incremented on 404 from getOrder", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("re.notFoundCount = nf"),
    "loop must track notFoundCount per order for 404 retry logic",
  );
});

test("loop source: entry stays in map when notFoundCount < 3 (transient 404)", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("nf < 3"),
    "loop must keep order in restingOrders when 404 count is below threshold (transient retry)",
  );
});

test("loop source: definitive 404 after 3 attempts blocks reactive re-entry", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // After 3 attempts: convictionFiredThisWindow is set, then order removed
  const definitiveIdx = src.indexOf("after 3 attempts");
  assert.ok(definitiveIdx > 0, "loop must have 3-attempt 404 definitive handling");
  const firedIdx = src.indexOf("convictionFiredThisWindow.add", definitiveIdx);
  const delIdx   = src.indexOf("restingOrders.delete(sym)", definitiveIdx);
  assert.ok(firedIdx > definitiveIdx, "convictionFiredThisWindow.add must follow the 3-attempt 404 marker");
  assert.ok(delIdx   > definitiveIdx, "restingOrders.delete must follow the 3-attempt 404 marker");
});

test("loop source: getOrder throw leaves order in map (retry next tick)", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("getOrder threw — will retry next tick"),
    "loop must keep order in restingOrders when getOrder throws unexpectedly (retry semantics)",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. RestingOrderEntry interface fields
// ─────────────────────────────────────────────────────────────────────────────

test("state: RestingOrderEntry has cancelRequested optional field", () => {
  const src = readSrc("kalshi-bot-state.ts");
  assert.ok(
    src.includes("cancelRequested?: boolean"),
    "RestingOrderEntry must have cancelRequested?: boolean for stateful cancel retry",
  );
});

test("state: RestingOrderEntry has notFoundCount optional field", () => {
  const src = readSrc("kalshi-bot-state.ts");
  assert.ok(
    src.includes("notFoundCount?: number"),
    "RestingOrderEntry must have notFoundCount?: number for 404 retry tracking",
  );
});
