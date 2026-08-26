---
name: Kalshi shard funding semantics
description: Balance units, crypto-shard collateral allocation, and the balance-free Scalper execution rule.
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

**Rule:** `balance` is aggregate available cash in cents; `balance_breakdown[].balance` is a fixed-point dollar string per exchange shard. Before the entry window, the High-Value Scalper must move enough internal cash to keep 90% on the single force-refreshed crypto shard. Once entry eligibility begins, the IOC path performs no balance read or local insufficient-funds gate and always submits the full configured fee-safe size. Kalshi's definitive insufficient-funds rejection decides when cash is exhausted.

**Why:** Kalshi moved crypto markets to exchange shard 2 and requires collateral preallocation there. Aggregate cash can be sufficient while that shard is nearly empty. Per-order balance checks then blocked valid candidates, while cash-based downsizing created misleading $1–$3 scraps. Funding preparation belongs before the narrow entry window; the hot path must remain quote → final guards → full IOC.

**How to apply:** Derive the destination only from a successful force refresh whose close time matches the current target. Never allocate 90% independently to multiple shards. Internal transfers are non-idempotent: claim durable window/source/destination ownership before POST, retain ambiguous claims across restarts, and reconcile Kalshi's pending transfer history. Enforce a hard pre-entry deadline at the transfer sink. Keep the submitted order's `exchange_index` pinned to the refreshed market identity, but never fetch balance in the eligible execution path and never shrink configured order size to remaining cash.
