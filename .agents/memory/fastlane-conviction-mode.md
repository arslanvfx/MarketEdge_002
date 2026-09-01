---
name: FastLane Conviction mode
description: Durable strategy and execution boundaries for the isolated price-only FastLane mode.
---

FastLane is a separate decision mode. A fresh current-window YES or NO ask inside the configured conviction floor/cap is its sole strategy authorization; it must not inherit model, confidence, stability, trajectory, or authenticated-book gates. This applies identically to crypto and commodities. Strike-proximity and Freefall are operator-controlled exceptions: FastLane enforces either guard only when its shared toggle is on.

**Why:** The mode exists to remove pre-entry processing latency without changing or weakening the established Conviction mode. Operators explicitly chose to retain optional proximity and Freefall protection without adding network waits. Kalshi order submission remains authenticated even though a separate authenticated order-book read is intentionally absent.

**How to apply:** Authorize entries from current-window public price alone, then apply enabled proximity and Freefall guards at the final pre-submit boundary using already-collected fresh samples. Never add a commodity-only quote, depth, or authenticated-book check. Disabled guards must short-circuit without evidence work, requests, or sleeps. Preserve exact market identity, monetary safety, per-position ownership, signed execution, and durable reconciliation.

Do not apply legacy Conviction’s gross daily-spend throttle to FastLane. FastLane keeps canonical daily-loss, actual-balance, reservation, ownership, and reconciliation protections instead.

**Why:** Development Conviction had the legacy gross-spend cap disabled, while production FastLane inherited a stale positive value that silently blocked valid price-triggered entries before intent creation.

**How to apply:** Any Conviction-specific throttle must explicitly require `decisionMode === "conviction"`; shared execution-safety boundaries continue to apply to both modes.

FastLane’s emergency close is only a one-time bad-fill safeguard. After a valid fill is persisted, the position must use the same configured stop-loss module as every other decision mode.

**Why:** Entry-time fill validation and ongoing market-risk protection have different lifecycles; treating emergency validation as the only exit protection can leave valid fills unmanaged.

**How to apply:** Keep bad-fill evaluation at entry, then manage every active position with the shared floor, activation-minute, and suppression parameters regardless of entry decision mode.

Price-triggered modes have one authoritative entry timer: the global Conviction Min Entry Wait is a hard floor, and per-market waits may only delay entry further. The legacy model-driven early-window lockout must not also apply. The extreme-price bypass belongs with that timer and is available only to legacy Conviction; FastLane always respects its configured wait. Risk controls must likewise display only the field the active mode actually enforces: Conviction uses its dedicated daily-loss limit, while FastLane uses the canonical shared daily-loss limit and never shows Conviction’s gross-spend cap.

**Why:** Showing overlapping timers and mode-inapplicable loss/spend inputs made operators believe hidden or ignored values controlled FastLane, while stale legacy values could contradict the visible slider.

**How to apply:** Keep price-triggered timing and bypass UI together, keep legacy lockout UI exclusive to non-price-triggered modes, and condition risk controls by their real backend decision-mode scope.

Revalidate the effective wait from the current configuration at the exact live exchange boundary and after all asynchronous paper previews. Global-wait-only updates must validate the complete stored per-market map, not just fields included in the request. When preserving Conviction's explicit bypass, compare a per-contract side cost; aggregate order cost is the wrong unit.

**Why:** A tick can begin under an older wait and remain in flight while the operator raises it. Separately, validating only submitted overrides can leave stale lower values hidden in storage, and aggregate multi-contract cost incorrectly disables an otherwise valid bypass.

**How to apply:** Use the current global/per-market maximum immediately before submission or synthetic fill, reject stale lower stored overrides whenever timing config is saved, and keep FastLane ineligible for the Conviction-only bypass.

FastLane emergency-close distance supports a per-market override with the global gap as fallback. The operator-facing value is the winning-side fill price at or below which the position is immediately closed; internally it is stored as a cent gap below that market's effective entry floor.

**Why:** Commodity books can price-improve far below the public quote and need different emergency tolerances from tighter crypto books. A display-only derived value prevented operators from expressing that risk preference.

**How to apply:** Snapshot the effective per-market gap before submission, normalize YES and NO fills to winning-side cost, persist the confirmed fill, then immediately close when the fill is at or below the derived threshold. Blank overrides must fall back to the global gap.

If an authoritative fill breaches the snapshotted emergency threshold, record the entry before beginning the emergency exit. Normalize NO fills to winning-side cost. Full exits finalize through an idempotent durable lifecycle; unknown or partial exits remain blocked with residual exposure visible, and recovery must work across pauses and restarts without another broker order.

**Why:** A buy limit caps the worst price but cannot impose a lower execution bound. Immediate post-fill mitigation reduces abnormal price-improvement exposure, while durable exit identity prevents a timeout or partial sell from causing an oversell or silently dropping residual contracts.

For FastLane, the shared Freefall duration means a trailing sequence of favorable authoritative publications: YES rises and NO falls throughout the configured span. Flat or adverse publications reset it; an endpoint bounce never qualifies.

**Why:** The saved consecutive-seconds setting expresses sustained directional confirmation, not net movement between two endpoints.

**How to apply:** Count distinct upstream publications, ignore duplicate local polls, and let every distinct publication participate in reset accounting. Re-read the current setting before submission; a durable revocation failure retains ownership.