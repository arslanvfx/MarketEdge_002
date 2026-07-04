---
name: Kalshi order endpoint v2 migration
description: POST /portfolio/orders is deprecated (410); v2 path is /portfolio/events/orders and requires client_order_id.
---

**Old (deprecated since ~May 2026, now 410):**
```
POST /trade-api/v2/portfolio/orders
body: { ticker, action, side, type, count, [yes_price] }
```

**New v2:**
```
POST /trade-api/v2/portfolio/events/orders
body: { client_order_id: crypto.randomUUID(), ticker, action, side, type, count, [yes_price] }
```

**Cancel/get order paths are unchanged:**
- `DELETE /portfolio/orders/{order_id}` — still valid
- `GET /portfolio/orders/{order_id}` — still valid

**Why:** Kalshi split their order flow by "events" (exchange-style) in their v2 API. The old path returns `{"error":{"code":"deprecated_v1_order_endpoint",...}}` with HTTP 410. `client_order_id` is a required UUID for idempotency.

**How to apply:** In `kalshi-trader.ts placeOrder()`, always use `/portfolio/events/orders` and always include `client_order_id: crypto.randomUUID()` in the body. This is the only way to actually execute live orders.
