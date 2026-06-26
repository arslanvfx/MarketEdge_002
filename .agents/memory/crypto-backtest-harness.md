---
name: Crypto statistical-model backtest harness
description: How the offline accuracy backtest replays past windows and scores the live stat model
---

# Crypto backtest harness

`runBacktest` (api-server `lib/backtest.ts`) replays historical 1-min Coinbase candles over past 15-min windows and scores the **live** statistical model via `analyzeCoinAt` (exported from `crypto.ts`). Exposed at `GET /api/crypto/backtest` and `POST /api/crypto/backtest/compare`.

**Why it scores the real model:** `analyzeCoinAt(coin, candlesUpToOpen, openPrice, windowOpen)` builds the private `CoinStats` internally and calls the real `analyzeCoin` with `geckoPrice=openPrice`. Never copy the model into the harness — call `analyzeCoinAt` so the harness can't drift from production.

**Scoring rules (mirror live tracker):**
- Synthetic strike = the window-open price (Kalshi sets strike to RTI at open). `hit` = predicted side of strike === actual side at +15min.
- Settlement price = the `.o` of the candle at `open+900s`.
- Input candles = `t < open && t >= open-90min`; skip window if <30 candles or open/settle candle missing.
- Segments: regime via efficiency ratio (spikeFlag→spike; ER≥0.55 trending; ≥0.25 drifting; else choppy) and confidence bands; plus Brier + signed/abs error.

**Reproducible compares:** pass `endTime` (ISO) to pin the SAME window set across two runs (before/after a model change). Identical pinned runs → all deltas 0 (verified). Without `endTime` the window set shifts with wall-clock time, so before/after isn't apples-to-apples.

**Claude is NOT backtested** — its prompt needs the live order book + ticker, which can't be reconstructed historically. Evaluate Claude via the live accuracy log only.

Test against `http://localhost:8080/api/...` (routes mounted under `/api`), NOT `$REPLIT_DEV_DOMAIN`.
