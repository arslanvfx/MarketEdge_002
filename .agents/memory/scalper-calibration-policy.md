---
name: Scalper calibration policy
description: Durable evidence and operator-control rules for recommending Scalper setting changes.
---

Scalper calibration must remain observational until a signed-in operator explicitly applies a recommendation. Paper and live evidence must never mix, and candidate changes must pass minimum-sample checks plus chronological training/holdout validation.

Only recommend a setting dimension when the collected evidence can support that exact change. Cached/public Shadow Study quotes can support conservative timing comparisons, but they are not proof of an authenticated IOC fill and therefore cannot justify widening price bands or increasing budgets.

Timing calibration should evaluate every collected entry point in the conservative 60–180 second range and may recommend the earliest independently validated timing directly; do not force sequential 30-second changes. Each review must expose per-timing observations, settlements, wins/losses, win rate, hypothetical P&L, and exact training/holdout progress.

Calibration refresh is append-only review generation over the latest 60 days of evidence. It may supersede the visible conclusion, but it must not delete the raw shadow/order ledger, and the UI must not invent unavailable win/loss values for older saved reviews.

Applying and reverting must preserve the exact prior per-market override state, including inheritance from global defaults, and must reject stale recommendations or concurrent manual configuration changes.

**Why:** The goal is to increase qualified Scalper opportunities without weakening final authenticated quotes, IOC limits, direction/freefall guards, circuit breakers, exposure controls, reservations, or unresolved-order handling. Operators need to distinguish genuinely missing timing evidence from sufficient but unprofitable evidence.

**How to apply:** Keep calibration separate from execution policy. Mutate only dimensions supported by evidence and preserve inheritance for every other setting. Treat missing candidate evidence as insufficient rather than “no change,” validate chronologically, label hypothetical evidence clearly, show the full timing matrix, and require explicit audited apply/revert actions.