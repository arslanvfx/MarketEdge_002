import { test } from "node:test";
import assert from "node:assert/strict";
import {
  overlayTickAbortReasons,
  recordTickAbort,
  clearTickAbort,
  type TickAbortMap,
  type EvalRowLike,
} from "./kalshi-bot-eval-overlay.ts";

// Integration-style coverage for the abort-reason lifecycle contract used by
// _runBotTick: dispatch clears the previous reason, each abort category
// records its own current reason, and the dashboard overlay always shows the
// LATEST tick's exact block — never a stale reason from an earlier tick.

const WK = "2026-08-15T20:00";

function row(overrides: Partial<EvalRowLike> = {}): EvalRowLike {
  return {
    symbol: "ETH",
    windowKey: WK,
    reason: "price in zone — monitoring",
    action: "BET_YES",
    selected: true,
    ...overrides,
  };
}

/** Simulates one _runBotTick dispatch: clear first, then maybe abort. */
function simulateTick(map: TickAbortMap, abortReason: string | null) {
  clearTickAbort(map, "ETH", WK); // step 1 of the lifecycle contract
  if (abortReason !== null) recordTickAbort(map, "ETH", WK, abortReason);
}

test("lifecycle: a newer tick abort REPLACES the previous tick's reason on the dashboard", () => {
  const map: TickAbortMap = new Map();
  // Tick 1 aborts in the sizing gate…
  simulateTick(map, "sizing: $10.00 budget cannot buy 1 contract at 99¢ ask");
  // …tick 2 aborts in a different category (risk/balance).
  simulateTick(map, "safety abort: account balance $3.10 below $5 minimum");
  const [out] = overlayTickAbortReasons([row()], map);
  assert.equal(out.reason, "safety abort: account balance $3.10 below $5 minimum");
  assert.equal(out.action, "SKIP");
});

test("lifecycle: each major abort category overwrites whatever came before", () => {
  const map: TickAbortMap = new Map();
  const categories = [
    "smart hours: current hour is silenced — new entries blocked",                 // quiet hours
    "per-coin bet cap reached (1/1 this window)",                                  // caps
    "sizing: $10.00 budget cannot buy 1 contract at 99¢ ask",                      // sizing
    "daily spend cap: $48.00 spent + $9.00 bet > $50 cap",                         // spend
    "safety abort: computed bet $22.00 exceeds $15 max-bet cap",                   // max-bet safety
    "safety abort: open exposure $40.00 + $9.00 bet exceeds $45 cap",              // exposure
    "hard late-entry floor: only 91s left in window (< 180s floor) at order time", // late-entry
    "completeness gate: missing price reference — trade cancelled",                // completeness
    "order placement failed: 429 rate-limited",                                    // placement error
    "order returned 0 fills after 10 attempts — book empty at our price; blocked for rest of window", // zero-fill
  ];
  for (const reason of categories) {
    simulateTick(map, reason);
    const [out] = overlayTickAbortReasons([row()], map);
    assert.equal(out.reason, reason, `overlay must show current category: ${reason}`);
    assert.equal(out.action, "SKIP");
    assert.equal(out.selected, false);
  }
});

test("lifecycle: a tick that passes all gates clears the previous abort — loop reason shows through", () => {
  const map: TickAbortMap = new Map();
  simulateTick(map, "proximity guard: 0.01% from strike — need 0.05% (late)");
  // Next dispatch makes it past every gate (no abort recorded).
  simulateTick(map, null);
  const [out] = overlayTickAbortReasons([row()], map);
  assert.equal(out.reason, "price in zone — monitoring", "stale abort must not survive a clean dispatch");
  assert.equal(out.action, "BET_YES");
});

test("lifecycle: successful fill clears the abort so the placed bet row is never overridden", () => {
  const map: TickAbortMap = new Map();
  simulateTick(map, "return floor: fill cost 72¢ → return 1.39× < 1.45× minimum");
  // Fill path: clearTickAbort runs after the order fills.
  clearTickAbort(map, "ETH", WK);
  const placed = row({ betPlacedThisWindow: true, reason: "bet placed", action: "BET_YES" });
  const [out] = overlayTickAbortReasons([placed], map);
  assert.equal(out.reason, "bet placed");
  assert.equal(out.selected, true);
});

test("lifecycle: aborts are per coin+window — another coin's abort never bleeds over", () => {
  const map: TickAbortMap = new Map();
  recordTickAbort(map, "BTC", WK, "daily loss cap: $3.00 lost today ≥ $3 cap");
  const [out] = overlayTickAbortReasons([row()], map);
  assert.equal(out.reason, "price in zone — monitoring");
});
