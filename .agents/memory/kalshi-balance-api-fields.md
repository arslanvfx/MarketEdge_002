---
name: Kalshi routed balance semantics
description: Field mapping and exchange-scoping rules for GET /portfolio/balance.
---

**Endpoint:** `GET /trade-api/v2/portfolio/balance`

**Confirmed response shape (2026-07):**
```json
{
  "balance": 37952,              // ← available CASH in cents (what you can bet with)
  "portfolio_value": 6589,       // ← current mark-to-market position value in cents
  "balance_dollars": "379.5260", // ← cash as decimal string (redundant with balance)
  "balance_breakdown": [...],    // ← per-exchange detail
  "updated_ts": 1783152585       // ← unix seconds
}
```

**Rule:** `balance` = cash only (NOT total portfolio), but an unscoped balance request aggregates all exchange indexes. Any order execution guard must query with the exact `exchange_index` that will be submitted and pin both operations to one immutable market-identity snapshot. If that routed cash cannot support the configured budget but can support at least one contract, size down to the largest IOC that fits principal, the upward-rounded fee, and the one-cent safety margin; do not discard the candidate.

**Why:** Aggregate cash can look sufficient while the market's routed exchange lacks collateral, causing avoidable `insufficient_balance` rejections. Re-reading mutable identity state between the balance GET and order POST can also route them to different exchanges. Conversely, requiring the full configured budget at the final boundary turns a partially funded route into a missed narrow-window entry even when a smaller order would execute.

**How to apply:** Keep `balance` as available cash and `balance + portfolio_value` as total portfolio. For every exchange-routed order, pass its pinned `exchange_index` to the final balance read, cache by exchange index, and fail closed if the checked and submitted indexes differ. Reserve the safety cent, size against the lesser of configured budget and routed spendable cash, then submit when at least one fee-inclusive contract fits.
