---
name: Stock bot risk & AI-gating invariants
description: Durable safety decisions for AI gating and broker order lifecycle in the stock vertical
---

- All stock Claude usage — bot research, scheduled scanner research, tick signals, exit re-checks — must flow through ONE policy: the user's AI toggle AND the platform spend guard must both permit. Guard at the API-calling function itself, not only at call sites.
- **Why:** independently scheduled jobs (scanner) kept spending on Claude after the user disabled AI, and half-gated paths let cached research leak into "AI-off" behavior.
- **How to apply:** AI-off gates fail closed with a recorded SKIP reason; new AI entry points must consult the shared predicate.
- Broker order lifecycle: never abandon an accepted order without a confirmed terminal state. If terminality can't be confirmed (outages, cancel/fill races, thrown confirmations), persist a worst-case tracked position and reconcile it against broker truth each cycle — never mark a row flat (broker 404 proves nothing) while its entry order may still be working.
- Size risk from the worst-case executable price (the submitted limit); anchor stored stop/target levels to the confirmed fill. Stored levels are authoritative for exits; config percentages are legacy fallback only.
- Offline stat-signal replays are relative comparisons only — they don't reproduce the live gate pipeline and Claude isn't backtestable; validate defaults in paper mode.
