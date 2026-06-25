---
name: Crypto candle live-price patch
description: Why the last candle must be patched with the live ticker price before computing indicators for Claude.
---

## Rule
Always patch the live ticker price into the last candle (close, and adjust high/low) before running `analyzeCoin()` indicator calculations. **Never compute RSI, MACD, Bollinger, trend regression, or build candle rows from raw Coinbase candles when a live ticker price is available.**

**Why:** Coinbase REST candles only emit *closed* 1-min candles — the most recent candle is always up to 60 seconds stale. The live ticker (2s TTL, from Kraken for BTC, Coinbase for others) reflects the true current price. Without the patch, the Claude prompt contains a direct contradiction:
- `Current price: $106,200` (live ticker)
- Last candle close: `$104,400` + RSI neutral + MACD flat (all from stale close)

Claude, reasoning with deep extended thinking, treats the live price as a noisy outlier and trusts the indicator consensus — calling the wrong direction even when price has just surged.

**How to apply:** In `analyzeCoin()`, when `geckoPrice` is provided and `|geckoPrice - last.c| / last.c > 0.0001`:
```ts
patchedCandles = [...candles.slice(0, -1), {
  ...last,
  c: geckoPrice,
  h: Math.max(last.h, geckoPrice),
  l: Math.min(last.l, geckoPrice),
}];
```
Use `patchedCandles` for `closes`, all indicator computations, and the `candles` field in the returned `CoinPrediction`. The 5-min candles passed separately to Claude do NOT need patching (they are a structural/trend reference, not the real-time edge).
