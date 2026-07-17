---
name: Kalshi ticker window drift
description: Kalshi pre-publishes the next 15-min window market ~10 min into the current window; fetchKalshiTarget switches tickers prematurely, breaking orderbook checks.
---

## The problem
`fetchKalshiTarget(sym, undefined, true)` (the forceRefresh path used by the conviction poller)
begins returning the **next** window's ticker ~10 min into the current window because Kalshi
pre-publishes upcoming markets early.  Any code that reads `kalshiTargetCache[sym].ticker`
after that point gets the wrong ticker → orderbook fetch times out → fail-closed.

## The ticker format (observed)
`KX${SYM}15M-${YY}${MON}${DD}${HHMM}-${MM}`
- `YY MON DD` — date in **EDT (UTC-4)**
- `HHMM` — window **start time** in EDT
- `MM` — start-minute of the window (00, 15, 30, or 45)

Examples:
- windowKey "2026-07-17T00:15" (UTC) → EDT 20:15 July 16 → `KXBTC15M-26JUL162015-15`
- windowKey "2026-07-17T00:30" (UTC) → EDT 20:30 July 16 → `KXBTC15M-26JUL162030-30`
- windowKey "2026-07-17T04:00" (UTC) → EDT 00:00 July 17 → `KXBTC15M-26JUL170000-00`

## The fix (kalshi-bot-tick.ts conviction gate)
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
Then call `fetchOrderbookPrices(expectedTicker)` — bypasses cache entirely.

**Why:** The cache switches to the next window mid-window; reading it means the orderbook
fetch targets a ticker with no resting orders → timeout → fail-closed → no bets ever fire.

**How to apply:** Any conviction-mode code that needs the CURRENT window's orderbook or
ticker should use this computation, not `freshData.ticker` or `getKalshiCachedData(sym).ticker`.
Also applies if you need to validate whether the cache has drifted to the next window.
