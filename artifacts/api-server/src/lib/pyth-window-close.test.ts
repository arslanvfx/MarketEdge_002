import assert from "node:assert/strict";
import test from "node:test";

import { selectPythWindowClose } from "./pyth-window-close.ts";

test("requires the exact opening candle when deriving a live target", () => {
  const series = {
    t: [100, 160, 220],
    c: [6.61, 6.62, 6.63],
  };
  assert.equal(selectPythWindowClose(series, 160, true), 6.62);
  assert.equal(selectPythWindowClose(series, 180, true), null);
});

test("preserves the explicit legacy last-candle fallback for settlement reads", () => {
  assert.equal(
    selectPythWindowClose({ t: [100, 160], c: [2.9, 2.91] }, 180, false),
    2.91,
  );
});