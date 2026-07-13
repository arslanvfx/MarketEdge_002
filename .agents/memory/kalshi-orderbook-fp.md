---
name: Kalshi authenticated orderbook — orderbook_fp format
description: Kalshi replaced the integer-cent `orderbook` field with `orderbook_fp` (string-dollar arrays, ascending). Parser rules and the silent-null failure mode.
---

Kalshi's authenticated GET /markets/{ticker}/orderbook response now returns
`orderbook_fp` instead of the old `orderbook` field:
- Prices are **string dollars** (e.g. "0.79"), not integer cents.
- Each side is an array of [price, size] levels sorted **ascending** — the best
  bid is the **LAST** element, not the first.
- Only `yes` and `no` bid ladders are provided; asks are complements:
  `yesAsk = 1 − bestNoBid`, `yesBid = bestYesBid`.

Parser lives in crypto-kalshi.ts (~169-224) with legacy `orderbook` fallback +
warn logs when the legacy path fires.

**Why this matters:** when the field name changed, the old parser silently
returned null 100% of the time. Any caller that falls back to public/cached
prices on null will trade on stale data — this caused real-money fills 10-15¢
below the displayed price. Order-placement paths must FAIL CLOSED on a null
orderbook (abort + retry next tick), never fall back.

**How to apply:** any new Kalshi book consumer must go through the shared
parser; treat this as part of the broader Kalshi API drift pattern (see
kalshi-api-type-drift.md, kalshi-api-price-format.md) — verify field names
against a live response before trusting a parser.
