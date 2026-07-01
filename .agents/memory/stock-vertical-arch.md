---
name: Stock trading vertical architecture
description: How the Alpaca stock vertical stays isolated from crypto/Kalshi, and its broker-vs-DB position invariant
---

# Stock trading vertical

A second, fully independent trading vertical living beside the crypto/Kalshi
system in the same api-server. Code under `artifacts/api-server/src/lib/stock/`,
routes in `routes/stocks.ts` (mounted under `/api/stocks/*`).

## Isolation invariant (hard requirement)
The stock vertical must NEVER touch crypto/Kalshi tables, ML models, or code.
- Separate DB tables, all prefixed `stock_*` (migrations in `runStockMigrations()`
  in `index.ts`, distinct from `runStartupMigrations()`).
- Separate ML: its own logistic regression with `STOCK_N_FEATURES` (21) in
  `lib/stock/ml.ts` and `stock_ml_*` tables — different feature length than the
  crypto model (19) so a mixed-up feature vector fails loudly instead of silently
  training on the wrong model.
- `startStockVertical()` is wired to never crash the crypto tracker/Kalshi bot:
  every stock startup step is `.catch()`-guarded and the whole thing runs after
  the crypto init inside a non-fatal wrapper.
- **Why:** the two systems have completely different market dynamics; cross
  contamination of training data or shared config would corrupt both.

## Broker-vs-DB position invariant
`exitPosition()` in `lib/stock/bot.ts` must confirm the Alpaca close succeeded
before marking the `stock_bot_bets` row exited.
- `closePosition()` in `alpaca.ts` treats a 404 as success (broker already flat)
  but re-throws any other error.
- `exitPosition()` re-throws on close failure; `managePositions()` catches
  per-position so one failed exit doesn't abort the others — the failed row stays
  open and is retried next cycle.
- **Why:** DB is the source of truth for open positions. If the DB said "flat"
  while the broker still held the position, the bot would stop managing real,
  unhedged live exposure (no stop-loss / target watching). Never mark flat on an
  unconfirmed close.

## Graceful idle
Without `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`, `alpacaConfigured()` is
false and both scanner and bot log "idle" and no-op. Scanner is also market-hours
gated via `getClock()` (clock-fetch failure is non-fatal → scan anyway, so it
never silently stops forever).

## Deployment note
Single-run guards (`running`/`scanning` booleans) are process-local only. A
multi-replica deployment would need a DB lease/advisory lock to enforce
single-run semantics for the bot/scanner. Not implemented — Replit runs a single
instance, so this is deliberately deferred.
