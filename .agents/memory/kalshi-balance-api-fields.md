---
name: Kalshi balance API response fields
description: Confirmed field mapping for GET /portfolio/balance; balance=cash, portfolio_value=positions.
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

**Key insight:** `balance` = cash only (NOT total portfolio). Total portfolio = `balance + portfolio_value`. The Kalshi app shows "Portfolio $446.78" = cash $379.52 + positions $65.89 ≈ $445.41.

**Why this matters:** Earlier code treated `balance` as total portfolio (showed $447 instead of $379.52 available cash). Balance guards (`minAccountBalance`, bet-size checks) must use `balance` (cash), not `balance + portfolio_value`.

**How to apply:** `getBalance()` in kalshi-trader.ts reads `balance` → `availableBalance`; `balance + portfolio_value` → `totalBalance`. `getCachedKalshiBalance()` returns `availableBalance`. Do not change this mapping.
