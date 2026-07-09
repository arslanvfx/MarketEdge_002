import { test } from "node:test";
import assert from "node:assert/strict";
import { smaSeries, rsiSeries, rsi } from "./indicators.ts";

test("smaSeries: nulls during warmup, rolling averages after", () => {
  const out = smaSeries([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test("smaSeries: returns all nulls when not enough data", () => {
  assert.deepEqual(smaSeries([1, 2], 3), [null, null]);
  assert.deepEqual(smaSeries([1, 2, 3], 0), [null, null, null]);
  assert.deepEqual(smaSeries([], 3), []);
});

test("smaSeries: last value matches simple average of last window", () => {
  const values = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 5);
  const period = 21;
  const out = smaSeries(values, period);
  assert.equal(out.length, values.length);
  const expected =
    values.slice(-period).reduce((a, b) => a + b, 0) / period;
  assert.ok(Math.abs((out[out.length - 1] as number) - expected) < 1e-9);
  for (let i = 0; i < period - 1; i++) assert.equal(out[i], null);
  for (let i = period - 1; i < out.length; i++) assert.notEqual(out[i], null);
});

test("rsiSeries: nulls through warmup, values in [0,100] after", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 4);
  const out = rsiSeries(closes, 14);
  assert.equal(out.length, closes.length);
  for (let i = 0; i <= 13; i++) assert.equal(out[i], null);
  for (let i = 14; i < out.length; i++) {
    const v = out[i];
    assert.notEqual(v, null);
    assert.ok((v as number) >= 0 && (v as number) <= 100);
  }
});

test("rsiSeries: monotonic uptrend pins RSI at 100, downtrend near 0", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const upOut = rsiSeries(up, 14);
  assert.equal(upOut[upOut.length - 1], 100);

  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const downOut = rsiSeries(down, 14);
  assert.ok((downOut[downOut.length - 1] as number) < 1);
});

test("rsiSeries: too little data returns all nulls", () => {
  assert.deepEqual(rsiSeries([1, 2, 3], 14), [null, null, null]);
});

test("rsiSeries: uptrend series reads bullish (>50), downtrend bearish (<50)", () => {
  const closes: number[] = [100];
  for (let i = 1; i < 60; i++) {
    closes.push(closes[i - 1] + (i % 4 === 0 ? -0.5 : 1));
  }
  const out = rsiSeries(closes, 14);
  assert.ok((out[out.length - 1] as number) > 50);

  const falling = closes.map((_, i) => 200 - closes[i] + 100);
  const outDown = rsiSeries(falling, 14);
  assert.ok((outDown[outDown.length - 1] as number) < 50);
});

test("rsi (point) and rsiSeries agree on direction for the same data", () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.8 + Math.sin(i) * 2);
  const point = rsi(closes, 14);
  const series = rsiSeries(closes, 14);
  const last = series[series.length - 1] as number;
  assert.ok(point > 50);
  assert.ok(last > 50);
});
