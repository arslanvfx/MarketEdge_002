---
name: Per-symbol smart hours architecture
description: Durable invariants for per-market Smart Hours calibration, sparse cells, operator limits, and persistence
---

## The rule
Per-market Smart Hours must recalibrate on exact UTC-hour boundaries without erasing operator-owned restrictions or treating sparse history as meaningful performance evidence.

**Why:** Evaluation-only calibration deadlocks when a market is already silenced, two samples are too noisy for performance decisions, and full-JSON config writes can otherwise let a slow calibration overwrite a newer manual save.

**How to apply:**
- Schedule the next exact UTC boundary rather than anchoring a fixed interval to callback time. Recalculate after every run so event-loop delays do not create permanent drift; skip overlap.
- Use one threshold everywhere: zero, one, or two settled bets are data-gathering; the third settled bet makes a cell eligible for win-rate calibration.
- Generate a safe all-hours data-gathering schedule for a market with no history; never skip the market merely because its history is sparse.
- Calibration owns only the computed silence/data-gathering classification and timestamp. Preserve enablement, percentage reductions, dollar overrides, and auto-tune preferences from the freshest config.
- A percentage chosen while a cell is data-gathering remains enforced after that cell becomes active. A dollar data-collection cap remains stored but only applies while the cell is sparse.
- Polling may refresh calibration-owned fields, but must not clear unsaved operator drafts. Use the calibration timestamp to prefer newer server classification while retaining local operator fields.
- Serialize persistence of the shared full-JSON bot config row. Snapshot current in-memory config only when an ordered write begins so an older slow write cannot finish last and erase a newer manual edit.
- The global Smart Hours enable flag is the visible master for per-market enforcement. Master off means every symbol is active; master on applies only that symbol's enabled schedule. Missing/disabled symbols never fall back to global or legacy schedules.
- Loop-level global schedule shortcuts must not run in per-market mode; only symbol-level placement checks may block or reduce entries there. UI status summaries must obey the same master state.
- Explicit manual “Calibrate & Apply” may enable the master after saving schedules. Automatic hourly recalibration preserves an operator’s intentional master-off choice.
