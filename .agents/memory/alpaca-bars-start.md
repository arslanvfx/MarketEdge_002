---
name: Alpaca bars default start pitfall
description: Alpaca /v2/stocks/bars defaults start to today; multi-day requests silently return 1 bar unless explicit start + sort=desc are sent
---

Alpaca's `/v2/stocks/{sym}/bars` endpoint defaults `start` to the beginning of
the current trading day. Any request for multi-day history (e.g. 250 daily
bars) that omits `start` silently returns only today's bar(s) — no error.
This silently broke scanner MA alignment, swing/long analysis modes, and the
detail chart until fixed.

**Why:** limit alone does not extend the lookback window; Alpaca truncates to
[start, end] first, then applies limit.

**How to apply:** `getBars()` in `stock/alpaca.ts` now computes an explicit
`start` from `limit` (trading days → calendar days × 1.6 + 5 slack) and sends
`sort=desc`, reversing the response to ascending. `sort=desc` is essential:
with a far-back start and ascending order, Alpaca returns the *oldest* N bars
and drops the most recent ones. Never add a new Alpaca bars call that bypasses
this helper.
