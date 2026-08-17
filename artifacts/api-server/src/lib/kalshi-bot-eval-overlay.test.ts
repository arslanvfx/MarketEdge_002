import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayTickAbortReasons, type EvalRowLike } from "./kalshi-bot-eval-overlay.ts";

const WK = "2026-08-15T20:00";

function row(overrides: Partial<EvalRowLike> = {}): EvalRowLike {
  return {
    symbol: "NEAR",
    windowKey: WK,
    reason: "price in zone — monitoring",
    action: "BET_NO",
    selected: true,
    ...overrides,
  };
}

test("overlay: tick-time abort reason replaces loop reason for matching coin+window", () => {
  const aborts = new Map([[`NEAR:${WK}`, { reason: "NO cross-check: YES ask 25.0¢ > bounce threshold 23.0¢ — price reversed", at: Date.now() }]]);
  const [out] = overlayTickAbortReasons([row()], aborts);
  assert.equal(out.reason, "NO cross-check: YES ask 25.0¢ > bounce threshold 23.0¢ — price reversed");
  assert.equal(out.action, "SKIP");
  assert.equal(out.selected, false);
});

test("overlay: no abort entry — row passes through unchanged", () => {
  const [out] = overlayTickAbortReasons([row()], new Map());
  assert.equal(out.reason, "price in zone — monitoring");
  assert.equal(out.action, "BET_NO");
  assert.equal(out.selected, true);
});

test("overlay: abort from a DIFFERENT window key does not apply", () => {
  const aborts = new Map([[`NEAR:2026-08-15T19:45`, { reason: "stale abort from previous window", at: Date.now() }]]);
  const [out] = overlayTickAbortReasons([row()], aborts);
  assert.equal(out.reason, "price in zone — monitoring");
});

test("overlay: abort for a different coin does not apply", () => {
  const aborts = new Map([[`DOGE:${WK}`, { reason: "doge abort", at: Date.now() }]]);
  const [out] = overlayTickAbortReasons([row()], aborts);
  assert.equal(out.reason, "price in zone — monitoring");
});

test("overlay: betPlacedThisWindow row is never overridden by a stale abort", () => {
  const aborts = new Map([[`NEAR:${WK}`, { reason: "earlier abort", at: Date.now() }]]);
  const [out] = overlayTickAbortReasons(
    [row({ betPlacedThisWindow: true, reason: "bet placed: NO @ 81¢", action: "BET_NO" })],
    aborts,
  );
  assert.equal(out.reason, "bet placed: NO @ 81¢");
  assert.equal(out.action, "BET_NO");
});

test("overlay: mixed rows — only aborted coin is rewritten", () => {
  const aborts = new Map([[`DOGE:${WK}`, { reason: "strike-proximity re-check: gap 0.008% < 0.040%", at: Date.now() }]]);
  const rows = [
    row({ symbol: "NEAR" }),
    row({ symbol: "DOGE", reason: "price in zone — monitoring" }),
    row({ symbol: "BTC", action: "SKIP", selected: false, reason: "conviction: NO ask at 97% is past the 90% cap — entry window missed" }),
  ];
  const out = overlayTickAbortReasons(rows, aborts);
  assert.equal(out[0].reason, "price in zone — monitoring");
  assert.equal(out[1].reason, "strike-proximity re-check: gap 0.008% < 0.040%");
  assert.equal(out[1].action, "SKIP");
  assert.equal(out[2].reason, "conviction: NO ask at 97% is past the 90% cap — entry window missed");
});

test("overlay: does not mutate input rows", () => {
  const aborts = new Map([[`NEAR:${WK}`, { reason: "abort", at: Date.now() }]]);
  const input = row();
  overlayTickAbortReasons([input], aborts);
  assert.equal(input.reason, "price in zone — monitoring");
  assert.equal(input.action, "BET_NO");
});
