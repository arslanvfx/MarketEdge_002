---
name: Minimum-return (payout) gate
description: How the bot's min-return-multiple entry guard works and why it lives in a shared pure helper across all decision modes
---

# Minimum-return (payout multiple) entry gate

The bot can refuse bets whose payout multiple is too low. A Kalshi contract
costing `cost` dollars pays $1, so its return multiple is `1/cost`.
`BET_YES` cost = `yesPrice`; `BET_NO` cost = `1 - yesPrice`. A user example:
"only enter on ≥1.44x returns" → max cost ~69¢.

**Rule:** the guard is a single shared pure helper `checkMinReturnGate(action,
yesPrice, minReturnMultiple)` in kalshi-bot-engine-core.ts. Every decision mode
must route through it — classic/ml_gate via the `computeCorePairDecision`
wrapper, and consensus/unanimous explicitly at their actionable returns in
kalshi-bot-engine.ts.

**Why:** the original attempt put the gate only inside `computeCorePairDecision`,
which silently skipped the consensus/unanimous modes (they return before the
wrapper) — so the config promise "only enter above threshold" was false in those
modes. Any future mode-specific early-return that produces a BET must call the
helper too, or it bypasses the guard.

**Null-price policy (CRITICAL — do NOT revert to blocking):** when `yesPrice` is
null the decision-time helper returns `blocked:false` (does NOT skip). The
decision-time price comes from the short-lived kalshiTargetCache which is null on
the vast majority of live ticks (thin/late-publishing orderbook early in a
window) — this is verifiable in prod: live decision rows almost never carry a
non-null `signals.yesPrice`, including rows for bets that DID fill and win.
Blocking on null therefore skips essentially every live bet. A floor ≤ 1 still
disables the gate.

**Two-layer enforcement — the authoritative layer is execution-time, not the
decision gate:** because decision-time price can't be trusted, the real floor is
enforced when the order is placed. `computeMarketableLimitPrice(bookSide,
yesPrice, minReturnMultiple)` in kalshi-trader.ts caps the marketable-limit
price so cost can never exceed `1/minReturnMultiple` (bid/YES: `price ≤ maxCost`;
ask/NO: `price ≥ 1 - maxCost`). Orders are `fill_or_kill`, so a book that can't
meet the cap is killed → the bot skips. `_runBotTick` passes
`config.minReturnMultiple` into `placeOrderWithRetry` (buys only). The
decision-time `checkMinReturnGate` remains as early telemetry/skip only when a
price happens to be known.

**How to apply:** config field `minReturnMultiple` (default 1.44, range 1–10;
1 = off). Stored in the `bot_config` JSON blob, so no migration; it auto-activates
in prod because `loadBotConfigFromDB` merges `{...DEFAULT_BOT_CONFIG, ...saved}`
and old rows lack the field. Any new decision mode = add a `checkMinReturnGate`
call at its bet-producing return AND ensure its order path passes
`minReturnMultiple` to `placeOrder`.
