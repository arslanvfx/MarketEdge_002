import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SCALPER_EXIT_CONFIG,
  computeScalperExitExecutableDepth,
  evaluateScalperExit,
  isScalperExitEvidenceFetchFresh,
  type ScalperExitInput,
  type ScalperExitSample,
} from "./kalshi-scalper-smart-exit-policy.ts";
import {
  advanceScalperExitSamples,
  AbortableRequestRegistry,
  ScalperExitPriorityGate,
  ScalperHotCadenceTracker,
  selectScalperHotCandidates,
} from "./kalshi-scalper-smart-exit-scheduler.ts";
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
      { atMs: 7_750, price: 102.2 },
      { atMs: 8_500, price: 102.0 },
      { atMs: 9_250, price: 101.5 },
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
    valuePreservingExecutableQuantity: 10,
    valuePreservingWinningProbability: 0.81,
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
      { atMs: 7_750, price: 97.8 },
      { atMs: 8_500, price: 98.0 },
      { atMs: 9_250, price: 98.5 },
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
      { atMs: 7_750, price: 100.7 },
      { atMs: 8_500, price: 101.0 },
      { atMs: 9_250, price: 101.4 },
      { atMs: 10_000, price: 101.9 },
    ],
  })).disposition, "watch");
  assert.equal(evaluateScalperExit(input({
    executableQuantity: 9,
    depthAtFloor: false,
  })).disposition, "blocked");
});

test("projection rejects gaps and source timestamp freshness/order failures", () => {
  assert.equal(evaluateScalperExit(input({
    samples: [
      { atMs: -40_000, price: 102.2 }, { atMs: -20_000, price: 102.0 },
      { atMs: -10_000, price: 101.5 }, { atMs: 10_000, price: 100.7 },
    ],
  })).disposition, "blocked");
  const sourced = [
    { atMs: 7_750, price: 102.2, sourceAtMs: 7_740 },
    { atMs: 8_500, price: 102.0, sourceAtMs: 8_490 },
    { atMs: 9_250, price: 101.5, sourceAtMs: 9_240 },
    { atMs: 10_000, price: 100.7, sourceAtMs: 9_990 },
  ];
  assert.equal(evaluateScalperExit(input({ samples: sourced })).disposition, "exit");
  assert.equal(evaluateScalperExit(input({
    samples: sourced.map((sample, index) => ({ ...sample, sourceAtMs: index === 3 ? 9_000 : sample.sourceAtMs })),
  })).disposition, "blocked");
  assert.equal(evaluateScalperExit(input({
    samples: sourced.map((sample, index) => ({ ...sample, sourceAtMs: index === 3 ? 10_001 : sample.sourceAtMs })),
  })).disposition, "blocked");
  assert.equal(evaluateScalperExit(input({
    samples: sourced.map((sample, index) => ({ ...sample, sourceAtMs: index === 3 ? 7_000 : sample.sourceAtMs })),
  })).disposition, "blocked");
  assert.equal(evaluateScalperExit(input({
    requireSourceTimestamps: true,
    samples: sourced.map((sample, index) => index === 2
      ? { atMs: sample.atMs, price: sample.price }
      : sample),
  })).disposition, "blocked");
  assert.equal(evaluateScalperExit(input({
    samples: sourced,
    nowMs: 20_000,
    quoteAtMs: 20_000,
    bookAtMs: 20_000,
    expiresAtMs: 20_000,
  })).disposition, "blocked");
});

test("clock-controlled hot cadence and contention stay bounded without starving the oldest sample", () => {
  const cadence = new ScalperHotCadenceTracker(3);
  cadence.recordTick(1_000);
  cadence.recordTick(1_250);
  cadence.recordTick(1_500);
  cadence.recordTick(2_200);
  cadence.recordTick(2_450);
  assert.deepEqual(cadence.snapshot(), {
    latestGapMs: 250,
    worstRecentGapMs: 700,
    tickCount: 5,
  });
  const candidates = [
    { id: "new", lastSampleAtMs: 1_900 },
    { id: "old", lastSampleAtMs: 1_000 },
    { id: "busy", lastSampleAtMs: 500 },
    { id: "middle", lastSampleAtMs: 1_500 },
  ];
  const selected = selectScalperHotCandidates(candidates, new Set(["busy"]), 3);
  assert.deepEqual(selected.selected.map((row) => row.id), ["old", "middle"]);
  assert.equal(selected.coalescedCount, 2);
});

test("provider-native sparse cadence stays continuous but excessive gaps reset the projection window", () => {
  let history: ScalperExitSample[] = [
    { atMs: 1_000, price: 102, sourceAtMs: 990, sourceSequence: "a" },
    { atMs: 1_250, price: 101.8, sourceAtMs: 1_240, sourceSequence: "b" },
  ];
  history = advanceScalperExitSamples(
    history,
    { atMs: 12_500, price: 101.5, sourceAtMs: 12_490, sourceSequence: "c" },
  );
  assert.equal(history.length, 3);
  history = advanceScalperExitSamples(history, { atMs: 28_000, price: 101.2, sourceAtMs: 27_990, sourceSequence: "d" });
  assert.equal(history.length, 1);
  history = advanceScalperExitSamples(history, { atMs: 28_250, price: 100.9, sourceAtMs: 28_240, sourceSequence: "e" });
  history = advanceScalperExitSamples(history, { atMs: 28_500, price: 100.6, sourceAtMs: 28_490, sourceSequence: "f" });
  assert.equal(history.length, 3);
  assert.deepEqual(
    advanceScalperExitSamples(history, { atMs: 28_750, price: 100.4, sourceAtMs: 28_490, sourceSequence: "f" }),
    history,
  );
  assert.deepEqual(
    advanceScalperExitSamples(history, { atMs: 28_750, price: 100.4, sourceAtMs: null }),
    history,
  );
});

test("August 27 HYPE sparse-feed loss reaches a value-preserving exit", () => {
  const nowMs = 40_000;
  const result = evaluateScalperExit(input({
    target: 83.1047,
    nowMs,
    expiresAtMs: nowMs + 43_870,
    entryWinningProbability: 0.954,
    currentWinningProbability: 0.9934,
    valuePreservingWinningProbability: 0.9934,
    quoteAtMs: nowMs,
    bookAtMs: nowMs,
    samples: [
      { atMs: 18_000, price: 83.16, sourceAtMs: 17_900, sourceSequence: "8920297" },
      { atMs: 21_000, price: 83.15, sourceAtMs: 20_900, sourceSequence: "8920298" },
      { atMs: 30_000, price: 83.04, sourceAtMs: 29_900, sourceSequence: "8920339" },
      { atMs: 30_250, price: 83.03, sourceAtMs: 30_150, sourceSequence: "8920340" },
      { atMs: 40_000, price: 83.05, sourceAtMs: 39_900, sourceSequence: "8920344" },
    ],
    requireSourceTimestamps: true,
  }));
  assert.equal(result.disposition, "exit");
  assert.equal(result.reason, "persistent target breach with value-preserving authenticated depth");
  assert.equal(result.targetBreachConfirmationCount, 3);
  assert.ok((result.targetBreachSpanMs ?? 0) >= 9_000);
  assert.equal(result.quoteLagProtectionEligible, true);
});

test("August 27 ZEC sparse-feed loss reaches a value-preserving exit", () => {
  const nowMs = 20_000;
  const result = evaluateScalperExit(input({
    target: 794.3515,
    nowMs,
    expiresAtMs: nowMs + 49_573,
    entryWinningProbability: 0.966,
    currentWinningProbability: 0.9909,
    valuePreservingWinningProbability: 0.9909,
    quoteAtMs: nowMs,
    bookAtMs: nowMs,
    samples: [
      { atMs: 10_000, price: 794.8, sourceAtMs: 9_900, sourceSequence: "61537080" },
      { atMs: 10_750, price: 794.59, sourceAtMs: 10_650, sourceSequence: "61537081" },
      { atMs: 15_000, price: 794.2, sourceAtMs: 14_900, sourceSequence: "61537085" },
      { atMs: 15_350, price: 793.8, sourceAtMs: 15_250, sourceSequence: "61537092" },
      { atMs: 20_000, price: 793.37, sourceAtMs: 19_900, sourceSequence: "61537096" },
    ],
    requireSourceTimestamps: true,
  }));
  assert.equal(result.disposition, "exit");
  assert.equal(result.targetBreachConfirmationCount, 3);
  assert.equal(result.quoteLagProtectionEligible, true);
});

test("quote-lag protection rejects one print, recovery, and value below entry", () => {
  const baseSamples: ScalperExitSample[] = [
    { atMs: 6_000, price: 101, sourceAtMs: 5_900, sourceSequence: "a" },
    { atMs: 7_000, price: 100.8, sourceAtMs: 6_900, sourceSequence: "b" },
    { atMs: 8_000, price: 99.8, sourceAtMs: 7_900, sourceSequence: "c" },
    { atMs: 10_000, price: 99.7, sourceAtMs: 9_900, sourceSequence: "d" },
  ];
  assert.notEqual(evaluateScalperExit(input({
    samples: baseSamples.slice(0, 3).concat({ atMs: 10_000, price: 100.2, sourceAtMs: 9_900, sourceSequence: "d" }),
    currentWinningProbability: 0.99,
    entryWinningProbability: 0.95,
    valuePreservingWinningProbability: 0.99,
    requireSourceTimestamps: true,
  })).disposition, "exit");
  assert.notEqual(evaluateScalperExit(input({
    samples: baseSamples,
    currentWinningProbability: 0.955,
    entryWinningProbability: 0.95,
    valuePreservingWinningProbability: 0.955,
    requireSourceTimestamps: true,
  })).disposition, "exit");
  assert.notEqual(evaluateScalperExit(input({
    samples: baseSamples,
    currentWinningProbability: 0.99,
    entryWinningProbability: 0.95,
    valuePreservingExecutableQuantity: 9,
    valuePreservingWinningProbability: 0.99,
    requireSourceTimestamps: true,
  })).disposition, "exit");
});

test("quote-lag target-breach protection is symmetric for NO positions", () => {
  const result = evaluateScalperExit(input({
    side: "no",
    target: 100,
    samples: [
      { atMs: 6_000, price: 99.4, sourceAtMs: 5_900, sourceSequence: "a" },
      { atMs: 7_000, price: 99.8, sourceAtMs: 6_900, sourceSequence: "b" },
      { atMs: 8_000, price: 100.2, sourceAtMs: 7_900, sourceSequence: "c" },
      { atMs: 9_000, price: 100.4, sourceAtMs: 8_900, sourceSequence: "d" },
      { atMs: 10_000, price: 100.6, sourceAtMs: 9_900, sourceSequence: "e" },
    ],
    currentWinningProbability: 0.98,
    entryWinningProbability: 0.95,
    valuePreservingWinningProbability: 0.98,
    requireSourceTimestamps: true,
  }));
  assert.equal(result.disposition, "exit");
  assert.equal(result.targetBreachConfirmationCount, 3);
  assert.equal(result.quoteLagProtectionEligible, true);
});

test("Pyth whole-second timestamps accept distinct authoritative updates without fabricating duplicates", () => {
  const pythSamples: ScalperExitSample[] = [
    { atMs: 9_250, price: 102.2, sourceAtMs: 9_000, sourceSequence: "9000:10220:10" },
    { atMs: 9_500, price: 102.0, sourceAtMs: 9_000, sourceSequence: "9000:10200:10" },
    { atMs: 9_750, price: 101.5, sourceAtMs: 9_000, sourceSequence: "9000:10150:10" },
    { atMs: 10_000, price: 100.7, sourceAtMs: 9_000, sourceSequence: "9000:10070:10" },
  ];
  assert.equal(evaluateScalperExit(input({
    samples: pythSamples,
    requireSourceTimestamps: true,
  })).disposition, "exit");
  assert.equal(
    advanceScalperExitSamples(
      pythSamples,
      { atMs: 10_250, price: 100.7, sourceAtMs: 9_000, sourceSequence: "9000:10070:10" },
    ).length,
    pythSamples.length,
  );
});

test("regressing orderable provider sequences are rejected at admission and policy boundaries", () => {
  const history: ScalperExitSample[] = [
    { atMs: 7_000, price: 101, sourceAtMs: 6_900, sourceSequence: "100" },
    { atMs: 8_000, price: 100.8, sourceAtMs: 7_900, sourceSequence: "101" },
  ];
  assert.deepEqual(advanceScalperExitSamples(
    history,
    { atMs: 9_000, price: 99.8, sourceAtMs: 8_900, sourceSequence: "99" },
  ), history);
  assert.deepEqual(advanceScalperExitSamples(
    history,
    { atMs: 9_000, price: 99.8, sourceAtMs: 7_900, sourceSequence: "99" },
  ), history);
  assert.equal(evaluateScalperExit(input({
    requireSourceTimestamps: true,
    samples: [
      { atMs: 7_000, price: 101, sourceAtMs: 6_900, sourceSequence: "100" },
      { atMs: 8_000, price: 100.8, sourceAtMs: 7_900, sourceSequence: "101" },
      { atMs: 9_000, price: 99.8, sourceAtMs: 8_900, sourceSequence: "99" },
      { atMs: 10_000, price: 99.5, sourceAtMs: 9_900, sourceSequence: "102" },
    ],
  })).disposition, "blocked");
  assert.equal(evaluateScalperExit(input({
    side: "no",
    requireSourceTimestamps: true,
    samples: [
      { atMs: 7_000, price: 99, sourceAtMs: 6_900, sourceSequence: "100" },
      { atMs: 8_000, price: 99.4, sourceAtMs: 7_900, sourceSequence: "102" },
      { atMs: 9_000, price: 100.2, sourceAtMs: 7_900, sourceSequence: "101" },
      { atMs: 10_000, price: 100.5, sourceAtMs: 9_900, sourceSequence: "103" },
    ],
  })).disposition, "blocked");
});

test("opaque identities cannot hide a regressing numeric provider cursor", () => {
  const yesHistory: ScalperExitSample[] = [
    { atMs: 7_000, price: 101, sourceAtMs: 6_900, sourceSequence: "100" },
    { atMs: 8_000, price: 100.8, sourceAtMs: 7_900, sourceSequence: "opaque" },
  ];
  assert.deepEqual(advanceScalperExitSamples(
    yesHistory,
    { atMs: 9_000, price: 99.8, sourceAtMs: 8_900, sourceSequence: "99" },
  ), yesHistory);
  for (const side of ["yes", "no"] as const) {
    const prices = side === "yes" ? [101, 100.8, 99.8, 99.5] : [99, 99.2, 100.2, 100.5];
    assert.equal(evaluateScalperExit(input({
      side,
      requireSourceTimestamps: true,
      currentWinningProbability: 0.99,
      entryWinningProbability: 0.95,
      valuePreservingWinningProbability: 0.99,
      samples: prices.map((price, index) => ({
        atMs: 7_000 + index * 1_000,
        price,
        sourceAtMs: 6_900 + index * 1_000,
        sourceSequence: ["100", "opaque", "99", "101"][index]!,
      })),
    })).disposition, "blocked");
  }
});

test("opaque same-timestamp fingerprints cannot fabricate quote-lag persistence", () => {
  const result = evaluateScalperExit(input({
    requireSourceTimestamps: true,
    currentWinningProbability: 0.99,
    entryWinningProbability: 0.95,
    valuePreservingWinningProbability: 0.99,
    samples: [
      { atMs: 6_000, price: 101, sourceAtMs: 5_000, sourceSequence: "5000:10100:10" },
      { atMs: 7_000, price: 100.8, sourceAtMs: 6_000, sourceSequence: "6000:10080:10" },
      { atMs: 9_000, price: 99.8, sourceAtMs: 9_000, sourceSequence: "9000:9980:10" },
      { atMs: 9_500, price: 99.6, sourceAtMs: 9_000, sourceSequence: "9000:9960:10" },
      { atMs: 10_000, price: 99.4, sourceAtMs: 9_000, sourceSequence: "9000:9940:10" },
    ],
  }));
  assert.notEqual(result.reason, "persistent target breach with value-preserving authenticated depth");
  assert.equal(result.targetBreachConfirmationCount, 1);
});

test("aborting a hung coalesced request evicts only that generation and permits an immediate replacement", async () => {
  const registry = new AbortableRequestRegistry<string>();
  let firstAborted = false;
  const first = registry.getOrCreate("BTC", (signal) => new Promise<string>((resolve) => {
    signal.addEventListener("abort", () => {
      firstAborted = true;
      resolve("aborted");
    }, { once: true });
  }));
  assert.equal(registry.getOrCreate("BTC", async () => "unexpected"), first);
  first.abort();
  assert.equal(firstAborted, true);
  const second = registry.getOrCreate("BTC", async () => "fresh");
  assert.notEqual(second, first);
  assert.equal(await second.promise, "fresh");
  assert.equal(await first.promise, "aborted");
  assert.equal(registry.size(), 0);
});

test("aborting Smart Exit evidence cannot affect a separately-owned entry request", async () => {
  const exitRegistry = new AbortableRequestRegistry<string>();
  const entryRegistry = new AbortableRequestRegistry<string>();
  let entryAborted = false;
  let finishEntry!: (value: string) => void;
  const entry = entryRegistry.getOrCreate("BTC", (signal) => new Promise<string>((resolve) => {
    finishEntry = resolve;
    signal.addEventListener("abort", () => {
      entryAborted = true;
      resolve("entry-aborted");
    }, { once: true });
  }));
  const exit = exitRegistry.getOrCreate("BTC", (signal) => new Promise<string>((resolve) => {
    signal.addEventListener("abort", () => resolve("exit-aborted"), { once: true });
  }));

  exit.abort();
  assert.equal(await exit.promise, "exit-aborted");
  assert.equal(entryAborted, false);
  assert.equal(entryRegistry.size(), 1);
  finishEntry("entry-finished");
  assert.equal(await entry.promise, "entry-finished");
  assert.equal(entryRegistry.size(), 0);
});

test("Smart Exit DB work is bounded and critical lifecycle work outranks queued telemetry", async () => {
  const gate = new ScalperExitPriorityGate(2);
  const releases: Array<() => void> = [];
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const controlled = (name: string) => gate.run(() => new Promise<string>((resolve) => {
    started.push(name);
    active += 1;
    maxActive = Math.max(maxActive, active);
    releases.push(() => {
      active -= 1;
      resolve(name);
    });
  }), "background");

  const first = controlled("background-1");
  const second = controlled("background-2");
  const third = controlled("background-3");
  const critical = gate.run(async () => {
    started.push("critical");
    return "critical";
  }, "critical");

  assert.deepEqual(started, ["background-1", "background-2"]);
  assert.deepEqual(gate.snapshot(), {
    active: 2,
    queuedCritical: 1,
    queuedBackground: 1,
    maxConcurrency: 2,
  });

  releases.shift()!();
  assert.equal(await critical, "critical");
  await Promise.resolve();
  assert.deepEqual(started, ["background-1", "background-2", "critical", "background-3"]);
  assert.equal(maxActive, 2);

  releases.shift()!();
  releases.shift()!();
  await Promise.all([first, second, third]);
  assert.equal(gate.snapshot().active, 0);
});

test("robust projection rejects an outlier, tiny noise, and deceleration that stops short", () => {
  const outlier = evaluateScalperExit(input({ samples: [
    { atMs: 7_750, price: 102.0 }, { atMs: 8_500, price: 101.8 },
    { atMs: 9_250, price: 101.6 }, { atMs: 10_000, price: 99.0 },
  ] }));
  assert.equal(outlier.disposition, "watch");
  assert.match(outlier.reason, /outlier/);
  assert.equal(evaluateScalperExit(input({ samples: [
    { atMs: 7_750, price: 100.30 }, { atMs: 8_500, price: 100.29 },
    { atMs: 9_250, price: 100.28 }, { atMs: 10_000, price: 100.27 },
  ] })).disposition, "watch");
  const decelerating = evaluateScalperExit(input({ samples: [
    { atMs: 7_750, price: 103.0 }, { atMs: 8_500, price: 102.4 },
    { atMs: 9_250, price: 102.0 }, { atMs: 10_000, price: 101.8 },
  ] }));
  assert.equal(decelerating.disposition, "watch");
  assert.equal(decelerating.projectionState, "decelerates_before_target");
});

test("a harsh but insufficient trajectory does not qualify before reserve deadline", () => {
  const result = evaluateScalperExit(input({
    expiresAtMs: 14_000,
    samples: [
      { atMs: 7_750, price: 104.0 }, { atMs: 8_500, price: 103.5 },
      { atMs: 9_250, price: 103.0 }, { atMs: 10_000, price: 102.5 },
    ],
  }));
  assert.equal(result.disposition, "watch");
  assert.ok((result.projectedCrossingSeconds ?? 0) > 1);
  assert.equal(result.reserveSeconds, 3);
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

test("constant rapid sustained adverse velocity qualifies without acceleration", () => {
  const result = evaluateScalperExit(input({
    samples: [
      { atMs: 7_750, price: 102.2 },
      { atMs: 8_500, price: 101.6 },
      { atMs: 9_250, price: 101.0 },
      { atMs: 10_000, price: 100.4 },
    ],
  }));
  assert.equal(result.disposition, "exit");
});

test("replay sensitivity changes only policy thresholds on the same snapshot", () => {
  const shared = input({
    samples: [
      { atMs: 7_750, price: 102.0 },
      { atMs: 8_500, price: 101.85 },
      { atMs: 9_250, price: 101.55 },
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