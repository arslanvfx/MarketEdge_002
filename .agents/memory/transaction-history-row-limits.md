---
name: Transaction history row limits
description: Why dashboard history queries must separate bet lifecycles from high-volume skip telemetry before applying limits.
---

Transaction history queries must filter by record kind before applying pagination or row limits. Bet lifecycle rows and high-volume gate-skip telemetry cannot share one limited result set and then be separated only in the browser.

**Why:** In production, thousands of skip rows accumulated within hours and consumed the entire backend result limit. Dozens of valid regular live settlements still existed in the database but disappeared from Transaction History, making the regular bot look inactive.

**How to apply:** Any history endpoint or dashboard refactor must keep transaction and skip views independently queryable. Apply mode, archive, reset-boundary, and record-kind filters in SQL before ordering, limiting, or offsetting.