---
name: Kalshi ticker window drift
description: Kalshi tickers use the CLOSE time (not open time); expectedTicker must use windowKey+15min → EDT. Old open-time formula gives market_not_found 404 on every order.
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

## CRITICAL: Kalshi tickers use CLOSE time, not open time
`KX${SYM}15M-${YY}${MON}${DD}${HHMM}-${MM}`
- `YY MON DD` — date in **EDT (UTC-4)**
- `HHMM` — window **CLOSE time** in EDT (= window open + 15 min)
- `MM` — close-minute of the window (15, 30, 45, or 00)

**Why close time?** `fetchKalshiTarget` matches markets by `close_time`. For `windowKey="2026-07-18T00:15"`,
the pipeline found `KXNEAR15M-26JUL172030-30` = 20:30 EDT close = 00:30 UTC close. Using open time
(20:15 EDT → `...2015-15`) gives `market_not_found` 404 on every single order. Confirmed in production
July 2026: zero bets placed despite coins being in zone, all 404 from wrong ticker.

Examples (windowKey UTC → close UTC → EDT close → ticker):
- `2026-07-18T00:00` → close 00:15 UTC → EDT 20:15 July 17 → `KXDOGE15M-26JUL172015-15`
- `2026-07-18T00:15` → close 00:30 UTC → EDT 20:30 July 17 → `KXBTC15M-26JUL172030-30`
- `2026-07-18T00:30` → close 00:45 UTC → EDT 20:45 July 17 → `KXBTC15M-26JUL172045-45`
- `2026-07-18T04:00` → close 04:15 UTC → EDT 00:15 July 18 → `KXBTC15M-26JUL180015-15`

## The fix
Compute the ticker **deterministically from `windowKey` using the CLOSE time** — never read from cache:
```typescript
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const windowCloseUtc = new Date(new Date(windowKey + ":00Z").getTime() + 15 * 60 * 1000); // close = open + 15 min
const windowCloseEdt = new Date(windowCloseUtc.getTime() - 4 * 60 * 60 * 1000); // EDT = UTC-4
const tyy  = String(windowCloseEdt.getUTCFullYear()).slice(-2);
const tmon = MONTHS[windowCloseEdt.getUTCMonth()];
const tdd  = String(windowCloseEdt.getUTCDate()).padStart(2, '0');
const thh  = String(windowCloseEdt.getUTCHours()).padStart(2, '0');
const tmm  = String(windowCloseEdt.getUTCMinutes()).padStart(2, '0');
const expectedTicker = `KX${sym}15M-${tyy}${tmon}${tdd}${thh}${tmm}-${tmm}`;
```
Use `expectedTicker` for BOTH the orderbook fetch AND the actual order placement call.
In kalshi-bot-tick.ts conviction path: all uses of `kalshiTicker` in the order block
(placeOrderWithRetry, emergency-close persistence, OpenPosition record, persistBetRecord)
must use `expectedTicker`, NOT `kalshiTicker`.

**Why:** Cache switches to next window mid-window. Reading it for order placement sends the
order to a different market entirely — wrong price, wrong window, guaranteed loss if market
moves before that next window's close.

**How to apply:** Every conviction-mode code path that places orders or fetches orderbook
data must derive the ticker from `windowKey` via close-time EDT conversion, never from cache.
