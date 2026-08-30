---
name: FastLane Conviction mode
description: Durable strategy and execution boundaries for the isolated price-only FastLane mode.
---

FastLane is a separate decision mode. A fresh current-window YES or NO ask inside the configured conviction floor/cap is its sole strategy authorization; it must not inherit model, confidence, stability, trajectory, proximity, freefall, or authenticated-book gates.

**Why:** The mode exists to remove pre-entry processing latency without changing or weakening the established Conviction mode. Kalshi order submission remains authenticated even though a separate authenticated order-book read is intentionally absent.

**How to apply:** Authorize entries from current-window public price alone, while preserving exact market identity, monetary safety, per-position ownership, signed execution, and durable reconciliation. Keep FastLane’s latency choices isolated from legacy Conviction behavior.

Do not apply legacy Conviction’s gross daily-spend throttle to FastLane. FastLane keeps canonical daily-loss, actual-balance, reservation, ownership, and reconciliation protections instead.

**Why:** Development Conviction had the legacy gross-spend cap disabled, while production FastLane inherited a stale positive value that silently blocked valid price-triggered entries before intent creation.

**How to apply:** Any Conviction-specific throttle must explicitly require `decisionMode === "conviction"`; shared execution-safety boundaries continue to apply to both modes.

If an authoritative fill breaches the snapshotted emergency threshold, record the entry before beginning the emergency exit. Normalize NO fills to winning-side cost. Full exits finalize through an idempotent durable lifecycle; unknown or partial exits remain blocked with residual exposure visible, and recovery must work across pauses and restarts without another broker order.

**Why:** A buy limit caps the worst price but cannot impose a lower execution bound. Immediate post-fill mitigation reduces abnormal price-improvement exposure, while durable exit identity prevents a timeout or partial sell from causing an oversell or silently dropping residual contracts.