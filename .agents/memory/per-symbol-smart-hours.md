---
name: Per-symbol smart hours architecture
description: Durable invariants for per-market Smart Hours calibration, sparse cells, operator limits, and persistence
---

## The rule
Per-market Smart Hours must make a successfully committed current-hour calibration a prerequisite for new entries, without delaying exits or erasing operator-owned restrictions.

**Why:** A best-effort timer can miss or overlap an hourly run while stale prior-hour cells keep blocking entries. Calibration failures must never strand open positions, and concurrent automatic/manual runs must not drop the operator’s threshold.

**How to apply:**
- Schedule the next exact UTC boundary rather than anchoring a fixed interval to callback time. Recalculate after every run so event-loop delays do not create permanent drift.
- Treat the durable UTC-hour marker as authoritative. Backstop the timer from the recurring loop, and defer only new entries while the marker is stale; exits, expiry, and protective management must continue.
- Serialize every automatic/manual/startup calibration through one promise queue. Preserve each caller’s threshold option and completion promise; collapse redundant automatic work only after the target-hour marker is committed.
- Use one threshold everywhere: zero, one, or two settled bets are data-gathering; the third settled bet makes a cell eligible for win-rate calibration.
- Generate a safe all-hours data-gathering schedule for a market with no history; never skip the market merely because its history is sparse.
- Calibration owns only the computed silence/data-gathering classification and timestamp. Preserve enablement, percentage reductions, dollar overrides, and auto-tune preferences from the freshest config.
- A percentage chosen while a cell is data-gathering remains enforced after that cell becomes active. A dollar data-collection cap remains stored but only applies while the cell is sparse.
- Polling may refresh calibration-owned fields, but must not clear unsaved operator drafts. Use the calibration timestamp to prefer newer server classification while retaining local operator fields.
- Serialize persistence of the shared full-JSON bot config row. Snapshot current in-memory config only when an ordered write begins so an older slow write cannot finish last and erase a newer manual edit.
- The global Smart Hours enable flag is the visible master for per-market enforcement. Master off means every symbol is active; master on applies only that symbol's enabled schedule. Missing/disabled symbols never fall back to global or legacy schedules.
- Loop-level global schedule shortcuts must not run in per-market mode; only symbol-level placement checks may block or reduce entries there. UI status summaries must obey the same master state.
- Calibration is preparation only: manual refresh, startup recovery, hourly recalibration, and auto-tune must never enable the master or force-enable a disabled symbol. Only the explicit authenticated master-switch update may activate enforcement.
- When the master is off, the entire per-market UI uses neutral prepared-plan semantics—never active OFF/reduced badges—and sizing must ignore stale loop snapshots in favor of the fresh resolver.
- The operator-selected calibration win-rate threshold is durable shared configuration, not component-local state. Manual Apply persists it before computing; hourly and restart catch-up runs reuse that exact saved value.
- Calibration thresholds intentionally support 40%–90% in 0.5-point steps; server config and manual-apply validation must accept the same lower bound as the UI.
