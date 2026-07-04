---
name: Paper/Live mode full isolation
description: How paper and live bot modes are isolated across positions, streak state, decision mode preference, and stats queries
---

# Paper/Live Mode Full Isolation

## Rule
Four aspects of bot state are fully isolated between paper and live mode. Treat them independently — never aggregate or share them across modes.

## What is isolated

### 1. Open positions (`getBotState`)
`getBotState()` filters `openPositions` to only return entries where `pos.entryMode === botMode`. Positions opened in paper are invisible while in live mode and vice versa.

### 2. Coin streak state (consecutive losses / pauses)
Two separate `Map<string, CoinStreakEntry>` instances: `paperCoinStreakState` and `liveCoinStreakState`. Accessors:
- `activeCoinStreakState()` — returns the map for the current `botMode`
- `coinStreakStateForMode(mode)` — returns map for a specific mode
- `streakStoreForMode(mode)` — returns the DB store for a specific mode

DB rows: `coin_streak_state_paper` and `coin_streak_state_live` (stored in `bot_config` table by id).

`closePosition()` and `evalClosedBets()` use `pos.entryMode` / `row.mode` (not the live global `botMode`) to select the correct streak map. `clearAllPauses()` only clears `activeCoinStreakState()`.

`setBotMode()` triggers `loadCoinStreakStateFromDB()` (fire-and-forget) to reload the correct mode's streaks on switch.

### 3. Decision mode preference per mode
`BotConfig` has `paperDecisionMode?` and `liveDecisionMode?` fields.
- `updateBotConfig()`: when `decisionMode` changes, saves it as the mode-specific preference (`paper/liveDecisionMode`)
- `setBotMode()`: restores the saved mode-specific `decisionMode` on switch

### 4. Stats / history queries
- `getBotLogicPerformance(filterMode?)` accepts an optional mode filter applied as a SQL WHERE clause
- Route `/crypto/bot/logic-performance` passes `?mode=` query param
- Frontend passes `activeMode` in the React Query key for both `logicPerfData` and `perfReportData` so they refetch on switch

**Why:** performance-report backend cache is NOT yet mode-split — it still returns combined paper+live data (Task #235 deferred this).

## How to apply
Whenever adding new per-bot state (counters, maps, caches), check whether it needs to be split by mode using the same pattern: two Maps + `activeX()` helper + mode-keyed DB rows.
