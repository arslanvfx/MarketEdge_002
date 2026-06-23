---
name: Crypto market data source
description: Which live crypto price API works from this Replit environment and how to test the api-server from the shell
---

# Live crypto price data

- **Use Coinbase Exchange API** (`https://api.exchange.coinbase.com`) for live crypto prices/candles — it is US-friendly and needs no key. **Binance.com is geo-blocked** from this environment and will fail.
  - candles: `/products/{ID}/candles?granularity=60` → `[time,low,high,open,close,vol]` newest-first, ~300+ rows.
  - stats: `/products/{ID}/stats` → `{open(24h),high,low,last,volume}`.
  - Always send a `User-Agent` header or requests can be rejected.
  - Product IDs: `BTC-USD, ETH-USD, SOL-USD, XRP-USD, LINK-USD, DOGE-USD`.

# Testing the api-server from the shell

**Why:** `curl "$REPLIT_DEV_DOMAIN/api/..."` returns `HTTP:000` (connection fails) from the sandbox shell even for known-working endpoints — it's a TLS/proxy quirk, NOT a real bug. The browser reaches `/api` fine through the in-browser proxy.

**How to apply:** Hit the api-server directly at `http://localhost:8080/api/...` when verifying backend endpoints from bash. Reserve `$REPLIT_DEV_DOMAIN` checks for the browser/screenshot.

# Eastern Time labeling

- When the user asks for "EST" times, render the abbreviation dynamically from `America/New_York` via `Intl.DateTimeFormat(..., {timeZoneName:"short"})` so it shows EST in winter and EDT during daylight saving, rather than hardcoding "EST".
