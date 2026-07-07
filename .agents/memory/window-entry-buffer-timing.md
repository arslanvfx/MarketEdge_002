---
name: Window entry buffer timing
description: Why 120s entry buffer causes missed bets in trending windows, and the correct values
---

## Rule
`windowEntryBufferSeconds` must be **60** (not 120). WM caution bypass requires `signalsAgreeing >= 2` (not 3).

**Why:** In strongly trending 15-min windows, Kalshi prices move from ~40¢ to 1-4¢ within 90 seconds. With a 120s entry buffer, by the time the bot can act, NO contracts cost 96-99¢ (return 1.01-1.04×) — below the 1.40× min-return floor. At 60s, prices are still 35-45¢ (return 1.54-1.82×) and both the EV gate and min-return gate pass.

## How to apply
- `WINDOW_ENTRY_BUFFER_S` in `kalshi-bot-state.ts` — change constant
- `DEFAULT_BOT_CONFIG.windowEntryBufferSeconds` in `kalshi-bot-engine-core.ts` — change default
- **Production DB** `bot_config` row `id='default'` has this value **explicitly stored** — code default change alone is not enough. Run: `UPDATE bot_config SET config = config || '{"windowEntryBufferSeconds": 60}'::jsonb WHERE id='default';`
- WM caution bypass: `kalshi-bot-loop.ts` line ~856 `_peekDec.signals.signalsAgreeing >= 2`

## Context
- At t=43s: only ML signal available (stat/claude not yet computed)
- At t=60-90s: stat often ready (completes within 43-155s at window open)
- At t=120s: stat/claude/WM all ready, but prices already at extremes in fast windows
- All DB `kalshi_bot_bets` records are `mode=paper` — no live-money bets in history
- `action=expired` = paper bet placed and window closed; `action=shadow` = quality-gate probe
