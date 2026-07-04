---
name: Paper/Live mode full isolation
description: How paper and live bot modes are isolated across positions, streak state, daily loss counters, decision mode preference, and stats queries
---

# Paper/Live Mode Full Isolation

## Rule
Five aspects of bot state are fully isolated between paper and live mode. Treat them independently — never aggregate or share them across modes.

## What is isolated and how

### 1. Bot status (getBotState)
`getBotState()` computes `modePositionCount` by filtering `openPositions` to entries where `pos.entryMode === botMode`. Status `position_open` only fires when the CURRENT mode has open positions.

### 2. Open positions display
`getBotState()` filters `openPositionsList` to `pos.entryMode === botMode`. Positions from a different mode are invisible.

### 3. Coin streak state (consecutive losses / pauses)
Two `Map<string, CoinStreakEntry>`: `paperCoinStreakState` and `liveCoinStreakState`.
- `activeCoinStreakState()` — returns map for current `botMode`
- `coinStreakStateForMode(mode)` — returns map for a specific mode
- DB rows: `coin_streak_state_paper` / `coin_streak_state_live`
- `setBotMode()` triggers `loadCoinStreakStateFromDB()` (fire-and-forget)

### 4. Coin daily loss (per-UTC-day loss cap)
Two `Map<string, number>`: `paperCoinDailyLoss` and `liveCoinDailyLoss`.
- `activeCoinDailyLoss()` — returns map for current `botMode`
- `coinDailyLossForMode(mode)` — returns map for a specific mode
- `loadCoinDailyLossFromDB()` populates only the current `botMode`'s map (query filters by `botMode`)
- `closePosition()` uses `coinDailyLossForMode(pos.entryMode)` — writes to the bet's mode, not the live global
- Midnight reset clears **both** maps (new UTC day for everyone)
- Phase 1 entry check uses `activeCoinDailyLoss().get(sym)`

### 5. Decision mode preference
`BotConfig.paperDecisionMode?` and `BotConfig.liveDecisionMode?` — saved on `updateBotConfig()`, restored on `setBotMode()`.

### 6. Stats / queries mode-aware
All key endpoints infer `getBotState().mode` when `?mode=` is absent:
- `/crypto/bot/history` — `getBotHistory(limit, filterMode?)`
- `/crypto/bot/performance-report` — cached as `Map<BotMode, PerformanceReport>`; `runAutoTuneJob` filters DB query by `botMode` and caches per mode
- `/crypto/bot/logic-performance` — `getBotLogicPerformance(filterMode?)`
- `/crypto/bot/coin-guard-state` — `getCoinGuardState(mode?)`

Frontend React Query keys include `activeMode` for all of these so they refetch on mode switch.

## How to apply
Whenever adding new per-bot state (counters, maps, caches), check whether it needs to be split by mode using the same pattern: two Maps + `activeX()` helper + `xForMode(mode)` accessor + DB reload on `setBotMode()`.
