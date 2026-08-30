---
name: FastLane Conviction mode
description: Durable strategy and execution boundaries for the isolated price-only FastLane mode.
---

FastLane is a separate decision mode. A fresh current-window YES or NO ask inside the configured conviction floor/cap is its sole strategy authorization; it must not inherit model, confidence, stability, trajectory, or authenticated-book gates. Strike-proximity and Freefall are operator-controlled exceptions: FastLane enforces either guard only when its shared toggle is on.

**Why:** The mode exists to remove pre-entry processing latency without changing or weakening the established Conviction mode. Operators explicitly chose to retain optional proximity and Freefall protection without adding network waits. Kalshi order submission remains authenticated even though a separate authenticated order-book read is intentionally absent.

**How to apply:** Authorize entries from current-window public price alone, then apply enabled proximity and Freefall guards at the final pre-submit boundary using already-collected fresh samples. Disabled guards must short-circuit without evidence work, requests, or sleeps. Preserve exact market identity, monetary safety, per-position ownership, signed execution, and durable reconciliation.

Do not apply legacy Conviction’s gross daily-spend throttle to FastLane. FastLane keeps canonical daily-loss, actual-balance, reservation, ownership, and reconciliation protections instead.

**Why:** Development Conviction had the legacy gross-spend cap disabled, while production FastLane inherited a stale positive value that silently blocked valid price-triggered entries before intent creation.

**How to apply:** Any Conviction-specific throttle must explicitly require `decisionMode === "conviction"`; shared execution-safety boundaries continue to apply to both modes.

FastLane’s emergency close is only a one-time bad-fill safeguard. After a valid fill is persisted, the position must use the same configured stop-loss module as every other decision mode.

**Why:** Entry-time fill validation and ongoing market-risk protection have different lifecycles; treating emergency validation as the only exit protection can leave valid fills unmanaged.

**How to apply:** Keep bad-fill evaluation at entry, then manage every active position with the shared floor, activation-minute, and suppression parameters regardless of entry decision mode.

If an authoritative fill breaches the snapshotted emergency threshold, record the entry before beginning the emergency exit. Normalize NO fills to winning-side cost. Full exits finalize through an idempotent durable lifecycle; unknown or partial exits remain blocked with residual exposure visible, and recovery must work across pauses and restarts without another broker order.

**Why:** A buy limit caps the worst price but cannot impose a lower execution bound. Immediate post-fill mitigation reduces abnormal price-improvement exposure, while durable exit identity prevents a timeout or partial sell from causing an oversell or silently dropping residual contracts.