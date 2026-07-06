---
name: Kalshi market API price format change
description: Kalshi changed their /markets API to return NO-side dollar strings instead of YES-side integer cents; how to parse them correctly
---

## Rule
When fetching prices from the Kalshi public markets API (`/trade-api/v2/markets`), read `no_ask_dollars` and `no_bid_dollars` (decimal dollar strings, 0–1 scale) — NOT the old `yes_ask`/`yes_bid` (integer cents) which are no longer returned.

YES and NO are complements:
- `yes_ask = 1 - parseFloat(no_bid_dollars)`
- `yes_bid = 1 - parseFloat(no_ask_dollars)`
- `last_price = parseFloat(last_price_dollars)` (also a dollar string now)

Keep a backward-compat `toFrac(v)` fallback for legacy integer-cent fields in case other endpoints still use them.

**Why:** Kalshi silently changed the response format at some point in mid-2026. The old fields `yes_ask`, `yes_bid`, `last_price` (integer cents) are gone from the public `/markets` endpoint. The new fields are `no_ask_dollars`, `no_bid_dollars`, `last_price_dollars` (string, 0–1 decimal). This caused `yesPrice=null` for every coin on every window, aborting all bets at the pre-bet completeness gate ("SAFETY ABORT — noPrice=true"). All apparent "liquidity issues" were this one parsing failure.

**How to apply:** Any code that reads YES price from the public Kalshi markets API must use `parseDollar(m.no_bid_dollars)` to get `yes_ask` and `parseDollar(m.no_ask_dollars)` to get `yes_bid`. Check for `no_ask_dollars` in the response to confirm format. The authenticated `/orderbook` endpoint may use a different format — verify separately.
