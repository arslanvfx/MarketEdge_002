---
name: Per-symbol smart hours scheduler guard
description: The hourly auto-calibration scheduler had a guard that bailed when quietHoursMode!=="per_market", causing it to silently skip every hour even when the user had per-symbol schedules configured.
---

# Per-symbol smart hours scheduler guard

## The rule
The scheduler in `index.ts` (`scheduleAtTopOfEveryUtcHour`) must run whenever EITHER:
- `quietHoursMode === "per_market"`, OR
- `Object.keys(config.perSymbolQuietHours ?? {}).length > 0`

Do NOT gate it on `quietHoursMode !== "per_market"` alone.

## Why
The production DB had `quietHoursMode = "global"` while the user had manually calibrated per-symbol schedules stored in `perSymbolQuietHours`. The old guard:
```js
if (getBotState().config.quietHoursMode !== "per_market") return;
```
caused the scheduler to bail every single hour, so per-symbol schedules were never updated automatically. The manual "Calibrate and Apply All" button worked because it calls `recomputeAllSymbolQuietHours()` directly without the mode check.

## How to apply
Fixed guard in `artifacts/api-server/src/index.ts`:
```js
const hasPerSymbol = Object.keys(cfg.perSymbolQuietHours ?? {}).length > 0;
if (cfg.quietHoursMode !== "per_market" && !hasPerSymbol) return;
```

This means: skip calibration only when both conditions are true (mode is not per_market AND no per-symbol data exists). As soon as the user has ever run a manual calibration, the hourly auto-calibration will keep those schedules fresh.
