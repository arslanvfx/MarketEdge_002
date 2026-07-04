---
name: Kalshi order placement (Trade API v2)
description: How to place a Kalshi order that actually executes — v2 endpoint, bid/ask side, required price, FOK marketable limit, flat response
---

Placing a Kalshi order that actually fills requires the **v2 create-order** contract. The legacy `POST /portfolio/orders` returns `410 deprecated_v1_order_endpoint`.

**Endpoint:** `POST /portfolio/events/orders`

**Everything is quoted from the YES side of the book:**
- `side="bid"` → acquire YES exposure (buy yes, OR sell/close a NO position)
- `side="ask"` → acquire NO exposure (buy no, OR sell/close a YES position)
- A "yes bid at 7¢" == a "no ask at 93¢". So the book side depends on BOTH action and our yes/no side:
  `wantYesExposure = (buy && yes) || (sell && no)` → bid, else ask.

**There is no "market" order type in v2.** A market order = a marketable LIMIT with `time_in_force="fill_or_kill"`. Send an aggressive YES-side price that crosses the spread; FOK fills the whole order at once or kills it (never rests, so no polling/cancel needed on retry).

**Required request fields (CreateOrderV2Request):** `ticker`, `side` (bid/ask), `count` (string), `price` (**required**, FixedPointDollars decimal string e.g. `"0.0100"`, YES-side), `time_in_force` (fill_or_kill|good_till_canceled|immediate_or_cancel), `self_trade_prevention_type` (taker_at_cross|maker). Also send `client_order_id` (UUID). NO `action`/`type`/`yes_price` fields exist in v2.

**Response (CreateOrderV2Response) is FLAT** (not wrapped in `{order:{}}`): `order_id`, `fill_count` (string), `remaining_count` (string), `average_fill_price` (string, YES-side fraction, only present when fill_count>0). **Watch out:** the order-HISTORY GET `/portfolio/orders` uses `_fp`-suffixed names (`fill_count_fp`) — the CREATE response does NOT. Parse `fill_count` / `average_fill_price`.

**Price/P&L convention:** `average_fill_price` is YES-side for both yes and no orders, matching the bot's `entryYesPrice` (stored YES-side for both directions; P&L = yes-side delta). Return it directly as a 0-1 fraction — no conversion.

**Validation without fill risk:** POST the exact body with a nonexistent ticker → Kalshi schema-validates first, so a `404 market_not_found` proves the body shape is accepted; a `side must be bid or ask` / missing-price error means the body is still wrong. Never send a fillable order from dev (dev must never go live). See `scripts/kalshi-endpoint-probe.mjs`.

**Why:** the v1→v2 migration changed four things at once — the path, the side vocabulary (yes/no → bid/ask), made `price` required, and flattened the response — so a partially-updated body fails one field at a time. Signing is NOT the variable to suspect here (message = timestamp+METHOD+path-without-query, RSA-PSS SHA256; authenticated GET returns 200).
