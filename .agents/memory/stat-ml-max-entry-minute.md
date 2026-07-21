---
name: stat_ml max-entry-minute silent block
description: statMLMaxEntryMinute defaulted to 8min, silently blocking all bets after server restarts mid-window; fix and DB patch required
---

## Rule

`statMLMaxEntryMinute` in `kalshi-bot-tick.ts` had a hardcoded fallback of `?? 8`.
After any server restart mid-window (window already >8 min old), every `runBotTickForCoin` call silently returned at line ~563 with NO log output.

**Why:** The return had no `logger.*` call, so "best-market selected" appeared in Phase 3 but Phase 4's `runCoin` call vanished with no trace. The only way to detect it was reading the tick source for all silent `return` paths.

**How to apply:** Whenever "best-market selected" is logged but no bet or SKIP appears afterward:
1. Check all silent `return` paths in `_runBotTick` (grep `return;` without a preceding logger call)
2. Especially check the mode-specific entry ceilings (`maxEntryMinutes`, `statMLMaxEntryMinute`)
3. Default for stat_ml ceiling is now `?? 0` (disabled); DB must also be patched (`statMLMaxEntryMinute: 0` in JSONB config at `id='default'`)

**Related:** The live fill-cost gate (`minReturnMultiple`) and the return-floor gate are bypassed for stat_ml when `statMLMinReturnMultiple <= 1` via the `bypassReturnFloor` flag (same pattern as conviction mode).
