import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SCALPER_EXIT_CONFIG,
  computeScalperExitExecutableDepth,
  evaluateScalperExit,
  isScalperExitEvidenceFetchFresh,
  type ScalperExitInput,
} from "./kalshi-scalper-smart-exit-policy.ts";
import { runClaimedScalperExitLifecycle } from "./kalshi-scalper-smart-exit-lifecycle.ts";
import {
  buildScalpExitOrderBody,
  computeScalpExitYesLimitPrice,
  resolveScalpExitReconciliationEvidence,
} from "./kalshi-scalper-exchange.ts";

function input(overrides: Partial<ScalperExitInput> = {}): ScalperExitInput {
  const nowMs = 10_000;
  return {
    side: "yes",
    target: 100,
    samples: [
      { atMs: 7_000, price: 102.2 },
      { atMs: 8_000, price: 102.0 },
      { atMs: 9_000, price: 101.5 },
      { atMs: 10_000, price: 100.7 },
    ],
    nowMs,
    expiresAtMs: 20_000,
    entryWinningProbability: 0.8,
    currentWinningProbability: 0.55,
    quoteAtMs: nowMs,
    bookAtMs: nowMs,
    executableQuantity: 10,
    remainingQuantity: 10,
    depthAtFloor: true,
    config: {
      ...DEFAULT_SCALPER_EXIT_CONFIG,
      enabled: true,
      mode: "shadow",
      sensitivity: "default",
    },
    ...overrides,
  };
}

test("YES and NO use side-aware adverse acceleration toward target", () => {
  const yes = evaluateScalperExit(input());
  assert.equal(yes.disposition, "exit");
  assert.ok((yes.adverseVelocityPerSecond ?? 0) > 0);
  assert.ok((yes.adverseAccelerationPerSecond2 ?? 0) > 0);

  const no = evaluateScalperExit(input({
    side: "no",
    samples: [
      { atMs: 7_000, price: 97.8 },
      { atMs: 8_000, price: 98.0 },
      { atMs: 9_000, price: 98.5 },
      { atMs: 10_000, price: 99.3 },
    ],
  }));
  assert.equal(no.disposition, "exit");
  assert.ok((no.adverseVelocityPerSecond ?? 0) > 0);
  assert.ok((no.adverseAccelerationPerSecond2 ?? 0) > 0);
});

test("fails closed on stale evidence, target retreat, and insufficient depth", () => {
  assert.equal(evaluateScalperExit(input({
    nowMs: 20_000,
    quoteAtMs: 20_000,
    bookAtMs: 20_000,
    expiresAtMs: 30_000,
  })).disposition, "blocked");
  assert.equal(evaluateScalperExit(input({
    samples: [
      { atMs: 7_000, price: 100.7 },
      { atMs: 8_000, price: 101.0 },
      { atMs: 9_000, price: 101.4 },
      { atMs: 10_000, price: 101.9 },
    ],
  })).disposition, "watch");
  assert.equal(evaluateScalperExit(input({
    executableQuantity: 9,
    depthAtFloor: false,
  })).disposition, "blocked");
});

test("YES exits use converted NO depth and preserve the frozen proceeds floor", () => {
  const safe = computeScalperExitExecutableDepth(
    "yes",
    [[0.99, 100]],
    [[0.30, 4], [0.40, 6]],
    10,
    0.60,
  );
  assert.equal(safe.quantity, 10);
  assert.ok(Math.abs((safe.price ?? 0) - 0.64) < 1e-9);
  assert.ok(Math.abs((safe.price ?? 0) * safe.quantity - 6.4) < 1e-9);
  const unsafe = computeScalperExitExecutableDepth(
    "yes",
    [[0.99, 100]],
    [[0.30, 4], [0.40, 6]],
    10,
    0.65,
  );
  assert.equal(unsafe.quantity, 4);
  assert.ok(Math.abs((unsafe.price ?? 0) - 0.7) < 1e-9);
});

test("NO exits use converted YES depth and block when full floor depth is absent", () => {
  const safe = computeScalperExitExecutableDepth(
    "no",
    [[0.25, 5], [0.35, 5]],
    [[0.99, 100]],
    10,
    0.65,
  );
  assert.equal(safe.quantity, 10);
  assert.ok(Math.abs((safe.price ?? 0) - 0.7) < 1e-9);
  assert.ok(Math.abs((safe.price ?? 0) * safe.quantity - 7) < 1e-9);
  const unsafe = computeScalperExitExecutableDepth(
    "no",
    [[0.25, 5], [0.35, 5]],
    [[0.99, 100]],
    10,
    0.70,
  );
  assert.equal(unsafe.quantity, 5);
  assert.equal(evaluateScalperExit(input({
    side: "no",
    executableQuantity: unsafe.quantity,
    remainingQuantity: 10,
    depthAtFloor: false,
  })).disposition, "blocked");
});

test("final evidence fetch latency fails closed at the configured boundary", () => {
  assert.equal(isScalperExitEvidenceFetchFresh(1_000, 2_999, 2), true);
  assert.equal(isScalperExitEvidenceFetchFresh(1_000, 3_001, 2), false);
  assert.equal(isScalperExitEvidenceFetchFresh(2_000, 1_999, 2), false);
});

test("a blocked final revalidation releases ownership and a later valid trigger submits exactly once", async () => {
  let ownerClaimed = false;
  let shouldBlock = true;
  let releases = 0;
  let submissions = 0;
  async function trigger(): Promise<void> {
    if (ownerClaimed) return;
    ownerClaimed = true;
    await runClaimedScalperExitLifecycle({
      revalidate: async () => shouldBlock
        ? { ready: false as const, reason: "temporary stale evidence" }
        : { ready: true as const, value: { exactRemaining: 2 } },
      release: async () => {
        releases += 1;
        ownerClaimed = false;
      },
      claimRequest: async ({ exactRemaining }) => exactRemaining === 2,
      submit: async () => {
        submissions += 1;
      },
    });
  }
  await trigger();
  shouldBlock = false;
  await trigger();
  await trigger();
  assert.equal(releases, 1);
  assert.equal(submissions, 1);
});

test("acceleration is required independently of adverse velocity", () => {
  const result = evaluateScalperExit(input({
    samples: [
      { atMs: 7_000, price: 102.2 },
      { atMs: 8_000, price: 101.6 },
      { atMs: 9_000, price: 101.1 },
      { atMs: 10_000, price: 100.7 },
    ],
  }));
  assert.equal(result.disposition, "watch");
  assert.match(result.reason, /not accelerating/);
});

test("replay sensitivity changes only policy thresholds on the same snapshot", () => {
  const shared = input({
    samples: [
      { atMs: 7_000, price: 102.0 },
      { atMs: 8_000, price: 101.85 },
      { atMs: 9_000, price: 101.55 },
      { atMs: 10_000, price: 101.10 },
    ],
    currentWinningProbability: 0.64,
  });
  const aggressive = evaluateScalperExit({
    ...shared,
    config: { ...shared.config, sensitivity: "more_aggressive" },
  });
  const conservative = evaluateScalperExit({
    ...shared,
    config: { ...shared.config, sensitivity: "less_aggressive" },
  });
  assert.equal(aggressive.disposition, "exit");
  assert.notEqual(conservative.disposition, "exit");
  assert.ok(aggressive.confirmationCount >= conservative.confirmationCount);
});

test("exit limits preserve the original-side proceeds floor", () => {
  assert.equal(computeScalpExitYesLimitPrice("yes", 0.501), 0.51);
  assert.equal(computeScalpExitYesLimitPrice("no", 0.501), 0.49);
});

test("live exit request is bounded full-quantity fill-or-kill on the wire", () => {
  assert.deepEqual(buildScalpExitOrderBody({
    ticker: "KXBTC15M-26AUG261200-00",
    exchangeIndex: 0,
    originalSide: "yes",
    minimumWinningPrice: 0.501,
    count: 10,
    clientOrderId: "scalp-exit-request-fok",
  }), {
    client_order_id: "scalp-exit-request-fok",
    ticker: "KXBTC15M-26AUG261200-00",
    exchange_index: 0,
    side: "ask",
    count: "10.00",
    price: "0.51",
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
  });
});

test("exit reconciliation requires exact identity and opposite reducing direction", () => {
  const base = {
    ticker: "KXBTC15M-26AUG261200-00",
    exchangeIndex: 0,
    originalSide: "yes" as const,
    count: 10,
    yesLimitPrice: 0.5,
    clientOrderId: "scalp-exit-request-1",
    exchangeOrderId: "exchange-1",
    createdAt: new Date("2026-08-26T12:00:00Z"),
  };
  const order = {
    order_id: "exchange-1",
    client_order_id: base.clientOrderId,
    ticker: base.ticker,
    exchange_index: 0,
    outcome_side: "no",
    book_side: "ask",
    initial_count_fp: "10.00",
    yes_price_dollars: "0.50",
    status: "executed",
    fill_count_fp: "10.00",
    remaining_count_fp: "0.00",
    created_time: "2026-08-26T12:00:01Z",
  };
  const fill = {
    fill_id: "fill-1",
    order_id: "exchange-1",
    ticker: base.ticker,
    outcome_side: "no",
    book_side: "ask",
    count_fp: "10.00",
    yes_price_dollars: "0.48",
  };
  const result = resolveScalpExitReconciliationEvidence(base, [order], [fill]);
  assert.equal(result.outcome, "confirmed_fill");
  if (result.outcome === "confirmed_fill") {
    assert.equal(result.winningPrice, 0.48);
    assert.equal(result.proceeds, 4.8);
  }
  assert.equal(resolveScalpExitReconciliationEvidence(base, [
    { ...order, book_side: "bid" },
  ], [fill]).outcome, "ambiguous");
  assert.equal(resolveScalpExitReconciliationEvidence(base, [
    { ...order, client_order_id: "wrong" },
  ], [fill]).outcome, "ambiguous");
});

test("terminal zero is retryable only when authoritative accounting proves no fill", () => {
  const result = resolveScalpExitReconciliationEvidence({
    ticker: "KXETH15M-26AUG261200-00",
    exchangeIndex: 0,
    originalSide: "no",
    count: 5,
    yesLimitPrice: 0.5,
    clientOrderId: "scalp-exit-request-2",
    exchangeOrderId: "exchange-2",
    createdAt: new Date("2026-08-26T12:00:00Z"),
  }, [{
    order_id: "exchange-2",
    client_order_id: "scalp-exit-request-2",
    ticker: "KXETH15M-26AUG261200-00",
    exchange_index: 0,
    outcome_side: "yes",
    book_side: "bid",
    initial_count_fp: "5.00",
    yes_price_dollars: "0.50",
    status: "canceled",
    fill_count_fp: "0.00",
    remaining_count_fp: "0.00",
    created_time: "2026-08-26T12:00:01Z",
  }], []);
  assert.equal(result.outcome, "zero_fill");
});

test("August 26 ETH/DOGE incidents are metadata fixtures, not fabricated replay savings", () => {
  const incidents = [
    { symbol: "ETH", side: "yes", secondsRemaining: 61.85, loss: 98.50 },
    { symbol: "DOGE", side: "yes", secondsRemaining: 64.95, loss: 96.32 },
  ];
  assert.equal(incidents.reduce((sum, row) => sum + row.loss, 0), 194.82);
  assert.ok(incidents.every((row) => !("postEntrySamples" in row)));
});