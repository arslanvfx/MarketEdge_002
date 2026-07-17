---
name: Kalshi ticker window drift
description: Kalshi pre-publishes the next 15-min window market ~10 min into the current window; fetchKalshiTarget switches tickers prematurely — affects both orderbook checks AND actual order placement.
---

## The problem
`fetchKalshiTarget(sym, undefined, true)` (the forceRefresh path used by the conviction poller)
begins returning the **next** window's ticker ~10 min into the current window because Kalshi
pre-publishes upcoming markets early.  Any code that reads `kalshiTargetCache[sym].ticker`
after that point gets the wrong ticker.

**Two failure modes confirmed:**
1. Orderbook fetch: wrong ticker → timeout → fail-closed → no bets fire.
2. Order placement: `kalshiTicker` (from cache) drifted to next window while gate's
   `expectedTicker` was correct → order landed on next window's market → completely different
   price (e.g. YES 9¢ instead of 91¢ on a NO conviction bet) → large loss.

The July 17 2026 XRP incident: bot was in 21:30 window, gate checked `KXXRP15M-26JUL171730-30`
(correct), but order went to `KXXRP15M-26JUL171745-45` (next window, already published).
NO fill at 90¢ NO on the wrong market; XRP rose toward target; closed for $0.18 on a $1.97 bet.

## The ticker format (observed)
`KX${SYM}15M-${YY}${MON}${DD}${HHMM}-${MM}`
- `YY MON DD` — date in **EDT (UTC-4)**
- `HHMM` — window **start time** in EDT
- `MM` — start-minute of the window (00, 15, 30, or 45)

Examples:
- windowKey "2026-07-17T00:15" (UTC) → EDT 20:15 July 16 → `KXBTC15M-26JUL162015-15`
- windowKey "2026-07-17T00:30" (UTC) → EDT 20:30 July 16 → `KXBTC15M-26JUL162030-30`
- windowKey "2026-07-17T04:00" (UTC) → EDT 00:00 July 17 → `KXBTC15M-26JUL170000-00`

## The fix
Compute the ticker **deterministically from `windowKey`** — never read it from the cache:
```typescript
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const windowOpenUtc = new Date(windowKey + ":00Z");
const windowOpenEdt = new Date(windowOpenUtc.getTime() - 4 * 60 * 60 * 1000);
const tyy  = String(windowOpenEdt.getUTCFullYear()).slice(-2);
const tmon = MONTHS[windowOpenEdt.getUTCMonth()];
const tdd  = String(windowOpenEdt.getUTCDate()).padStart(2, '0');
const thh  = String(windowOpenEdt.getUTCHours()).padStart(2, '0');
const tmm  = String(windowOpenEdt.getUTCMinutes()).padStart(2, '0');
const expectedTicker = `KX${sym}15M-${tyy}${tmon}${tdd}${thh}${tmm}-${tmm}`;
```
Use `expectedTicker` for BOTH the orderbook fetch AND the actual order placement call.
In kalshi-bot-tick.ts conviction path: all 6 uses of `kalshiTicker` in the order block
(placeOrderWithRetry, emergency-close persistence ×2, OpenPosition record, persistBetRecord)
must use `expectedTicker`, NOT `kalshiTicker`.

**Why:** Cache switches to next window mid-window. Reading it for order placement sends the
order to a different market entirely — wrong price, wrong window, guaranteed loss if market
moves before that next window's close.

**How to apply:** Every conviction-mode code path that places orders or fetches orderbook
data must derive the ticker from `windowKey` via EDT conversion, never from cache.
