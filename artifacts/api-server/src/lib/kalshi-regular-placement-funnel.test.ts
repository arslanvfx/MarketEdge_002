import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateRegularPlacementLatency,
  createKalshiRegularPlacementFunnel,
  createRegularPlacementCandidateId,
  regularPlacementCandidateKey,
} from "./kalshi-regular-placement-funnel.ts";

const input = { mode: "live" as const, symbol: "btc", windowKey: "2026-01-01T00:00:00Z", side: "yes" as const };
const here = dirname(fileURLToPath(import.meta.url));

test("candidate identity is stable and sequence suffix prevents collisions", () => {
  assert.equal(regularPlacementCandidateKey(input), "live|BTC|2026-01-01T00:00:00Z|yes");
  assert.equal(createRegularPlacementCandidateId(input, 0), createRegularPlacementCandidateId({ ...input, symbol: "BTC" }, 0));
  assert.notEqual(createRegularPlacementCandidateId(input, 0), createRegularPlacementCandidateId(input, 1));
});

test("computes total, exchange, and exchange-excluded internal latency", () => {
  assert.deepEqual(calculateRegularPlacementLatency({
    identified: 100, final_eligibility: 120, reservation: 140, submit: 200, response: 260, fill: 300,
  }), { totalMs: 200, exchangeMs: 60, internalMs: 140 });
});

test("records full live lifecycle and terminal outcome", () => {
  const funnel = createKalshiRegularPlacementFunnel({ now: () => 1 });
  const candidate = funnel.identify(input, 100);
  funnel.finalEligibility(candidate.id, true, 110);
  funnel.reservation(candidate.id, true, 120);
  funnel.submit(candidate.id, 130);
  funnel.response(candidate.id, 180);
  funnel.fill(candidate.id, 2, 190);
  const result = funnel.terminal(candidate.id, "filled", 190);
  assert.ok(result);
  assert.equal(result.outcome, "filled");
  assert.equal(result.filledCount, 2);
  assert.deepEqual(result.latency, { totalMs: 90, exchangeMs: 50, internalMs: 40 });
  assert.equal(funnel.summary().outcomes.filled, 1);
});

test("paper candidate records advisory live eligibility without claiming or submitting", () => {
  const funnel = createKalshiRegularPlacementFunnel();
  const synthetic = funnel.identify({ ...input, mode: "paper" }, 10);
  const preview = funnel.paperLiveEligibility(synthetic.id, false, "intent preview unavailable");
  assert.ok(preview);
  assert.equal(preview.paperLiveEligible, false);
  assert.equal(preview.paperLiveEligibilityReason, "intent preview unavailable");
  assert.equal(preview.reservationClaimed, null);
  assert.equal(preview.submitted, false);
  const result = funnel.paperSynthetic(synthetic.id, 15);
  assert.ok(result);
  assert.equal(result.paperSynthetic, true);
  assert.equal(result.outcome, "paper_synthetic");
  assert.equal(result.paperLiveEligible, false);
});

test("completed history is bounded while active candidates remain lifecycle-safe", () => {
  const funnel = createKalshiRegularPlacementFunnel({ capacity: 2 });
  const first = funnel.identify(input, 1);
  const second = funnel.identify({ ...input, side: "no" }, 2);
  const third = funnel.identify({ ...input, windowKey: "next" }, 3);
  funnel.terminal(second.id, "intent_denied", 4);
  funnel.terminal(third.id, "zero_fill", 5);
  const fourth = funnel.identify({ ...input, windowKey: "later" }, 6);
  funnel.terminal(fourth.id, "filled", 7);
  assert.deepEqual(funnel.recent().map((x) => x.id), [fourth.id, third.id]);
  assert.equal(funnel.summary().retained, 2);
  assert.equal(funnel.summary().terminal, 2);
  assert.equal(funnel.summary().active, 0);
  assert.equal(funnel.summary().totalRecorded, 4);
  assert.doesNotThrow(() => funnel.submit(first.id, 8));
});

test("terminal recording is exactly-once and later stages cannot rewrite it", () => {
  const funnel = createKalshiRegularPlacementFunnel();
  const candidate = funnel.identify(input, 10);
  const first = funnel.terminal(candidate.id, "unknown", 20, "ambiguous broker response");
  const repeated = funnel.terminal(candidate.id, "definite_error", 30, "must not replace unknown");
  assert.ok(first);
  assert.ok(repeated);
  funnel.fill(candidate.id, 2, 40);
  assert.equal(first.outcome, "unknown");
  assert.equal(repeated.outcome, "unknown");
  assert.equal(funnel.recent(1)[0]?.outcome, "unknown");
  assert.equal(funnel.summary().terminal, 1);
});

test("late paper eligibility telemetry is harmless after terminalization", () => {
  const funnel = createKalshiRegularPlacementFunnel();
  const candidate = funnel.identify({ ...input, mode: "paper" }, 10);
  funnel.paperSynthetic(candidate.id, 20, "synthetic fill");
  const late = funnel.paperLiveEligibility(candidate.id, true, "late preview");
  assert.ok(late);
  assert.equal(late.outcome, "paper_synthetic");
  assert.equal(late.paperLiveEligible, null);
});

test("bot wiring keeps paper preview read-only and unknown live outcomes fail closed", () => {
  const source = readFileSync(join(here, "kalshi-bot-tick.ts"), "utf8");
  const paperPreview = source.slice(
    source.indexOf("Paper never claims a durable intent"),
    source.indexOf("const id = `${sym}:${windowKey}:${Date.now()}`"),
  );
  assert.match(paperPreview, /getCachedKalshiBalance/);
  assert.match(paperPreview, /hasUnresolvedRegularIntent/);
  assert.doesNotMatch(paperPreview, /claimRegularOrderIntent|placeEntryOrderWithSizeFallback/);

  const uncertainBranch = source.slice(
    source.indexOf("const uncertain = isUncertainOrderError"),
    source.indexOf(
      "const boundaryRevocation = exchangeBoundaryFreefallRevocation.value",
    ),
  );
  assert.match(uncertainBranch, /markPlacementTerminal\(\s*"unknown"/);
  assert.match(uncertainBranch, /markRegularOrderIntentUnknown/);
  assert.doesNotMatch(uncertainBranch, /releaseConvictionEntryReservation/);
});

test("authenticated route exposes the bounded funnel snapshot", () => {
  const route = readFileSync(join(here, "..", "routes", "kalshi-bot.ts"), "utf8");
  assert.match(
    route,
    /router\.get\("\/crypto\/bot\/regular-placement-funnel", requireAuth/,
  );
  assert.match(route, /getRegularPlacementFunnelSnapshot\(limit\)/);
});