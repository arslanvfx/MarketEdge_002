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
- `?symbol=SYM` added to `/crypto/bot/quiet-hours-analysis` endpoint (both primary and DOW breakdown queries).

## Calibration-takes-effect invariants (2026-08 fix — do not regress)
1. **Calibration MUST write `enabled`** — both recompute fns persist `enabled: current[sym]?.enabled ?? true` (preserve explicit user `false`). Without it the resolver silently ignores calibrated entries and users see "calibrate does nothing".
2. **PUT config route MERGES `perSymbolQuietHours`, never replaces** — submitted symbols merge per-field over stored (`getBotState().config`); absent symbols/fields keep stored values. Wholesale replace let any UI save wipe all calibrated schedules.
3. **`calibratedAt` is a staleness stamp** — if the stored entry's `calibratedAt` is newer than the submitted one, calibration-owned fields (`silencedByDow`, `dataGatheringByDow`, `silencedUtcHours`, `calibratedAt`) keep the STORED values; the client echoed a pre-calibration snapshot. User-owned fields (`enabled`, `reducedByDow`, dg overrides, auto-tune settings) still take submitted values.
4. **Scheduled bulk calibration** — `index.ts` polls every 30 min; when `quietHoursMode === 'per_market'` and ≥4 h since last run, calls `recomputeAllSymbolQuietHours()`. Fixes the catch-22 where calibration only fired from bet evaluation, which never happens while the bot is silenced.
5. Symbol deletion from the map is intentionally impossible via PUT; `enabled: false` is the supported opt-out. Config writes are still full-row last-writer-wins JSONB — no cross-actor serialization yet.
