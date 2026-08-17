---
name: Per-symbol smart hours architecture
description: How the per-market quiet-hours mode works end-to-end — config fields, trigger, DB function, and UI
---

## The rule
`BotConfig.quietHoursMode: 'global' | 'per_market'` (default: global via `?? 'global'`).
`BotConfig.perSymbolQuietHours: Record<string, QuietHoursV2>` stores one V2 schedule per symbol key.

**Why:** Single global schedule treats a coin that always wins at 9 PM the same as one that always loses — per-symbol calibration is more accurate.

## How to apply
- In `resolveEntryQuietHoursDecisionForSymbol` (engine-core.ts), when `quietHoursMode === 'per_market'` AND the symbol has an enabled schedule, it substitutes the per-symbol V2 for the global one before calling `resolveEntryQuietHoursDecision`. Falls through to global in all other cases.
- The barrel (`kalshi-bot-engine.ts`) re-exports `resolveEntryQuietHoursDecisionForSymbol` — keep it there.
- Tick call sites (`kalshi-bot-tick.ts`): all 3 QH enforcement gates call `resolveEntryQuietHoursDecisionForSymbol(S.config, S.botMode, sym)`.
- Auto-calibration trigger: after `evaluated++` in `evalClosedBets`, if `quietHoursMode === 'per_market'`, fires `recomputeSymbolQuietHours(row.symbol)` (fire-and-forget).
- `recomputeSymbolQuietHours` in `kalshi-bot-db.ts`: 5-min per-symbol rate limit; needs ≥10 bets; calls `computeSymbolQuietHoursV2` (pure fn in performance.ts); saves via `updateBotConfig`.
- PATCH route sends **entire** `perSymbolQuietHours` object (client merges on its side using configDraft spread).
- `?symbol=SYM` added to `/crypto/bot/quiet-hours-analysis` endpoint (both primary and DOW breakdown queries).
