---
name: Prediction snap race condition
description: Why duplicate chips appeared in the accuracy log and how the snapInFlight guard fixes it
---

## Rule
Any async snap operation inside a `setInterval` loop must hold a synchronous in-flight lock (added before the first `await`, released in `finally`) to prevent concurrent ticks from double-writing the same window.

## Why
`setInterval` fires every 30s without awaiting the previous invocation. When Claude extended thinking takes >30s, two ticks run concurrently. Both read `alreadySnapped = records.some(r => r.targetTime === targetISO)` before either one pushes records — both see `false` and both proceed to snap. The DB stays clean (`onConflictDoNothing`) but the in-memory `historyStore` array accumulates 2× copies of every source record. `windowGroups` renders all of them as chips, producing visually doubled Combined/Claude/Stat/ML badges per window.

## How to apply
In `crypto.ts` tracker: module-level `const snapInFlight = new Set<string>()` keyed by `${sym}:${targetISO}`. Guard condition: `!snapInFlight.has(snapKey)`. Add key synchronously before first `await`; remove in `finally` so failures still allow a retry on the next tick.
