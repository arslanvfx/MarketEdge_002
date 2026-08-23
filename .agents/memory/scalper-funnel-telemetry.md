---
name: Scalper funnel telemetry
description: Observability rules for durable Scalper funnel stages and retry behavior.
---

Funnel stages must describe their real boundary: “eligible” means an authenticated, two-sided quote passed the pinned side and band checks, not merely a cached candidate or successful reservation claim. Funnel writes are non-blocking execution telemetry, but each event needs bounded retry independent of whether its trading attempt retries; timers must not keep controlled test processes alive.

**Why:** Cached candidates and reservations overstate execution eligibility during order-book churn. Detached database work also caused controlled execution tests to stay alive after their assertions completed.

**How to apply:** Keep candidate discovery, authenticated eligibility, and final-quote loss as distinct append-only stages. Route attempt-stage telemetry through the injected execution runtime so controlled runtimes remain I/O-free. Use coalesced, bounded, unref’d retry delivery; never let telemetry alter safety gates, claims, cap accounting, or broker submission.