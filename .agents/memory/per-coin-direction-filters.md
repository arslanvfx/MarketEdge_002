---
name: Per-coin direction filters
description: Data-driven coin/direction blocks in Phase 3 of the bot loop, plus startup migration from ml_gate to classic mode.
---

## The rule
`COIN_YES_BLOCKED = {BTC, ETH, DOGE}` — YES bets blocked entirely for these coins.
`COIN_FULLY_BLOCKED = {SOL}` — all bets blocked (no edge in either direction).
All remaining YES bets require full 3-signal consensus (stat+claude+ml all `=== true`).
NO bets: stat+claude agreement still sufficient (60-70% WR historically).

**Why:** 223 settled production bets (2026-07-03) revealed:
- BTC YES: 20% WR (15 bets), ETH YES: 20% WR (10 bets), DOGE YES: 25% WR (4 bets)
- SOL NO: 22% WR (9 bets), SOL YES: 40% WR (5 bets) → no edge either direction
- Mixed YES bets (any signal not aligned): 0-33% WR across all coins
- Full 3-signal NO (ALL-NO): 73.2% WR (gold standard)
- Full 3-signal YES (ALL-YES): 41.7% WR — even consensus YES is weak vs NO

**How to apply:** Gate lives in Phase 3 of `runBotWindow` in `kalshi-bot.ts`, after the NO-gate and before the window-doubt filter. Uses `COIN_YES_BLOCKED` and `COIN_FULLY_BLOCKED` module-level `ReadonlySet<string>` constants. When removing/changing blocks, update the data-driven comment with new WR evidence.

## Startup migration (ml_gate → classic)
`loadBotConfigFromDB` automatically migrates `decisionMode: "ml_gate"` → `"classic"` on startup.
**Why:** ml_gate pins every bet at exactly 65% effectiveConfidence (ML only vetos, never boosts). Classic (PATH A/B/C) lets ML conviction differentiate signal quality to 80%+. Production data showed all 223 bets entered at identical 65%, with no differentiation.

## To revert
Config snapshot: `.local/config-snapshots/pre-task-abc-2026-07-03.json`
Remove the `if (config.decisionMode === "ml_gate")` migration block in `loadBotConfigFromDB`.
Remove `COIN_YES_BLOCKED`, `COIN_FULLY_BLOCKED`, and the Phase-3 gate block.
Update `decisionMode` in production bot config UI to `ml_gate`.
