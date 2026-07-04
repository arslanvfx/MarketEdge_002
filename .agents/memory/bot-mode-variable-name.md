---
name: Bot mode variable naming — botMode vs mode
description: runBotLoopTick uses module-level botMode; only helper functions that accept mode as a parameter have a local `mode`.
---

`kalshi-bot.ts` has a module-level `let botMode: BotMode = "paper"`. Most functions in the file read this directly as `botMode`.

Only a handful of small helper functions take `mode` as a **parameter** (e.g. `coinDailyLossForMode(mode)`, `coinStreakStateForMode(mode)`). These have a local `mode` in scope.

`runBotLoopTick()` and `_runBotTick()` do NOT have a local `mode` — they use `botMode` directly.

**Why:** When adding mode-aware Map keys inside these functions, always use `botMode`, not `mode`. Using `mode` will throw `ReferenceError: mode is not defined` at runtime (not caught at build time because esbuild strips types without checking).

**How to apply:** Before writing `${mode}` in any Map key or condition inside `runBotLoopTick` or `_runBotTick`, grep for `const mode` in that function scope first. If absent, use `botMode`.
