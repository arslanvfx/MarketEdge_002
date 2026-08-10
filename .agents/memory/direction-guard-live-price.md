---
name: Conviction direction guard live-price feed
description: The direction guard must read a genuinely live 1s spot price, not the 15s-stale predCache, or it never blocks wrong-way bets
---

# Direction guard live-price feed

The conviction "direction guard" blocks an entry when spot price is moving toward
the strike (net-slope check over the last several seconds via
`computeConvictionDirectionGate`). It reads samples from the
`convictionPriceTicks` map.

**Rule:** `convictionPriceTicks` MUST be populated with a genuinely live spot price
sampled every ~1s. The conviction poller (`kalshi-conviction-poller.ts`) is the
**single writer**, using `getTickerFresh(product)` (crypto-data.ts) which bypasses
the 2s ticker TTL. Do NOT re-populate the map anywhere else.

**Why:** It previously used `getCachedPrediction(sym).price` from the bot loop.
`predCache` refreshes only every ~15s (`PRED_TTL`), and the underlying ticker is
2s-cached, so every "tick" pushed carried the SAME frozen price with a fresh
`Date.now()`. Over the guard's ~7s window `toPrice − fromPrice ≈ 0` → "flat" →
neutral → the guard never blocked. A real declining BTC YES bet passed straight
through and lost while the dashboard graph (which uses a real 3s live refetch)
clearly showed the decline.

**How to apply:**
- Any future writer of `convictionPriceTicks` must use a real live price, never a
  cached prediction snapshot. A second stale writer re-introduces flat samples and
  silently defeats the guard.
- Fail-open is load-bearing: on ticker fetch error or a 0/NaN price, push NOTHING.
  The guard returns `blocked:false` with <2 samples, so a feed outage must not
  fabricate a fake decline (mirrors the "don't fire stop-loss when the feed drops"
  concern).
- The poller only runs in conviction mode, so this adds no Coinbase calls in other
  modes. The candle-fallback path (non-conviction pipeline direction guard) never
  used priceTicks and is unaffected.
