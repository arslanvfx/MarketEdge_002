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

**Null-price policy:** when the floor is > 1 and there is no `yesPrice` to verify
the return, the helper BLOCKS (skips) rather than betting blind. A floor ≤ 1
disables the gate.

**How to apply:** config field `minReturnMultiple` (default 1.44, range 1–10;
1 = off). Stored in the `bot_config` JSON blob, so no migration; it auto-activates
in prod because `loadBotConfigFromDB` merges `{...DEFAULT_BOT_CONFIG, ...saved}`
and old rows lack the field. Any new decision mode = add a `checkMinReturnGate`
call at its bet-producing return.
