---
name: Multi-position bot architecture
description: openPositions Map replaces single openPosition; each coin manages its own slot independently; Phase 2 iterates all, Phase 4 no break.
---

## The rule
`openPositions: Map<string, OpenPosition>` (keyed by symbol) — each coin has its own position slot. All coins can have simultaneous open bets in the same window.

**Why:** The old `openPosition: OpenPosition | null` global slot meant only one coin could be active at a time. `maxBetsPerWindow` only enabled sequential re-entries on the same coin, not parallel entries on different coins.

## How to apply

**_runBotTick (per-coin)**:
- `const pos = openPositions.get(sym); if (pos) { ...manage exit... return; }`  
- No cross-symbol guard needed — each coin only sees its own slot.
- On close: `openPositions.delete(sym)`.
- On entry: `const newPosition = {...}; openPositions.set(sym, newPosition)`.

**runBotLoopTick orchestration**:
- Phase 2: iterate `Array.from(openPositions.entries())` to manage all open positions; do NOT return early — fall through to Phase 3/4 so coins without positions can still enter.
- Phase 4 entry loop: NO `break` after bet placement. Direction-count tracking uses `hadPositionBefore = openPositions.has(sym)` before the tick, checks `openPositions.has(sym)` after.
- Window-expiry: `for (const [posSymbol, stalePos] of Array.from(openPositions.entries()))`.

**loadOpenPositionFromDB**: No `.limit(1)` — loads all open bets, iterates, restores each into the map (skips expired windows).

**BotStateSnapshot**:
- `openPositions: OpenPositionDisplay[]` (array, not single nullable).
- `OpenPositionDisplay extends OpenPosition` adds `currentYesPrice`, `unrealizedPnl`, `guardStates`, `guardReason` — populated live in `getBotState()`.
- Removed: `openPosition`, `openPositionCurrentYesPrice`, `openPositionUnrealizedPnl`, `lastGuardStates`, `lastGuardReason`.

**Guard diagnostics**: `lastGuardStatesMap: Map<string, GuardStates>` and `lastGuardReasonMap: Map<string, string>` — per-symbol, updated in the exit block, read back in `getBotState()`.

**Dashboard**: `openPosList = status?.openPositions ?? []`, mapped to individual cards; shows "N Positions Open" badge when N > 1.
