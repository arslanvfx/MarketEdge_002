---
name: Kalshi shard funding semantics
description: Balance units, multi-route collateral allocation, and the balance-free Scalper execution rule.
---

**Endpoint:** `GET /trade-api/v2/portfolio/balance`

**Confirmed response shape (2026-08):**
```json
{
  "balance": 37952,              // ← available CASH in cents (what you can bet with)
  "portfolio_value": 6589,       // ← current mark-to-market position value in cents
  "balance_dollars": "379.5260", // ← cash as decimal string (redundant with balance)
  "balance_breakdown": [         // ← per-exchange cash as fixed-point dollars
    { "exchange_index": 2, "balance": "1.0000" }
  ],
  "updated_ts": 1783152585       // ← unix seconds
}
```

**Rule:** `balance` is aggregate available cash in cents; `balance_breakdown[].balance` is a fixed-point dollar string per exchange route. Before the entry window, the High-Value Scalper must allocate whole configured attempts across every force-refreshed active route, including Pyth commodities, without exceeding aggregate cash. Transfer only a source route's surplus above its own funded target. A live symbol may proceed only from a verified current-window permit for its exact refreshed route. Once entry eligibility begins, the IOC path performs no balance network request and always submits the full configured fee-safe size.

**Why:** Aggregate cash does not authorize every exchange route. A fixed 90%-to-crypto policy left GOLD, SILVER, and WTI unable to afford one order even while aggregate cash was ample. Independent destination transfers are also unsafe because a later transfer can drain an earlier route's reserve. Funding preparation belongs before the narrow entry window; the hot path must remain quote → final guards → full IOC.

**How to apply:** Build one aggregate-bounded plan across exact validated routes, assign whole fee-safe budgets deterministically, and preserve each funded route's target while sourcing deficits. Transfer `amount` is integer centicents. Internal transfers are non-idempotent: claim durable window/source/destination ownership before POST, retain ambiguous claims across restarts, and reconcile pending history. Replace permits only from a complete verified balance breakdown; failed, late, or incomplete refreshes preserve the last verified current-window snapshot. Recheck the permit against the final refreshed `exchange_index` before intent/POST without a balance request. Regular and Scalper orders share the authenticated CreateOrderV2 transport. Never shrink configured size to remaining cash.
