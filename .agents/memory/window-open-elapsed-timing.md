---
name: Window open time vs ticker confirmation time
description: kalshiWindowStore.openedAt used to be Date.now() at ticker confirmation (T+30-65s into a window), not the actual boundary. This caused minutesElapsed=0 during early ticks.
---

## The Rule
`kalshiWindowStore.set(ticker, { openedAt: getCurrentWindowOpenMs() })` — always use the actual 15-min UTC boundary, not `Date.now()`.

## Why
`getKalshiWindowContext` computes `minutesElapsed = Math.floor((Date.now() - openedAt) / 60_000)`. If `openedAt` was the ticker-confirmation time (e.g. T+65s into the window), then at T+68s `msElapsed=3s → minutesElapsed=0`. This triggered the `minNoEntryMinutes` gate spuriously on the first bot tick, writing a SKIP record and setting `lastDecisionWindowKey`. All subsequent block reasons (candle momentum guard, etc.) were then invisible — no new DB records for the rest of the window.

## How to Apply
Any time `kalshiWindowStore.set(ticker, ...)` is called for a new window entry, use `getCurrentWindowOpenMs()` (defined in `crypto-kalshi.ts`) not `Date.now()`. Both call sites (line 68 in `updateKalshiWindowPrice` and line 339 in `fetchKalshiTarget`) were fixed in July 2026.

## Diagnosed From
SOL 1:00 AM ET window: stat↓↓ Claude↓↓58% ML↓↓88% all agreeing NO, return >1.5x — never bet. Only DB record: `minutesElapsed:0, agreementTarget:null, warmupActive:false` = minNoEntryMinutes gate. After that, all subsequent skips were silent.
