---
name: Conviction empty-book fallback
description: Why the authenticated Kalshi orderbook is consistently empty in conviction mode and how to handle it safely
---

# Conviction empty-book fallback

## The rule
When `fetchOrderbookPrices(expectedTicker)` authenticates successfully but returns `{yesBid: null, yesAsk: null}`, do NOT fail-close. Instead, use the conviction poller's fresh price (≤1 s old) for zone re-verification, then proceed with the FOK at the configured lock price.

Only fail-close when `obPrices == null` (network/auth/timeout failure — we can't verify anything).

**Why:** Kalshi market makers post prices via the public API, not as resting book orders. The authenticated `orderbook_fp` endpoint is consistently empty for ALL coins throughout the entire window. Fail-closing on an empty book = zero bets for the entire window.

**How to apply:**
1. `obPrices == null` → release lock, restore max-bet token, return (fail closed — real outage)
2. `obPrices` returns but `{yesBid:null, yesAsk:null}` → get `getConvictionLivePrice(sym)` for zone re-verify with ±0.5¢ tolerance, then proceed
3. If poller also has no price → fail-close (nothing to verify against)
4. If poller price is out of zone → release lock for retry (price moved since dispatch)
5. FOK at lock price — only fills if real counterparty exists; safely rejected if market moved

## Why the poller is safe here (unlike the XRP 88¢ fill)
The XRP fill happened because the poller pointed at the NEXT window's market (Kalshi pre-publishes ~10 min early). The expectedTicker is now computed **deterministically from windowKey** (EDT UTC-4, `KX${SYM}15M-YYMONDD-HHMM-MM`) rather than read from the cache that had pre-switched. The poller is used only for zone re-verification, not for order pricing — the FOK limit is always the configured lock price.

## Distinction from the ticker drift issue
- Ticker drift: `freshData.ticker` (hub cache) switches to next window ~10 min early → fixed by deterministic `expectedTicker`
- Empty book: `expectedTicker` is correct, auth succeeds, but both sides null → fixed by this fallback
These are two separate failure modes that coexisted and both required fixes.
