---
name: Scalper paper/live parity
description: Requirements for valid comparisons between development paper runs and production live runs.
---

Paper and live Scalper outcomes are comparable only when their global entry window, per-market timing overrides, and every guard toggle/threshold match. Equal formulas do not produce an equivalent test if one environment becomes eligible earlier.

**Why:** A paper run admitted several NO entries from flat five-second traces, while production evaluated the same contracts later after upward movement toward the target and correctly rejected them. The apparent security-guard mismatch was caused by environment configuration drift and different observation times.

**How to apply:** Before diagnosing a paper/live decision discrepancy, compare effective window seconds and the full guard profile first. Preserve mode-specific budgets and caps, but align timing and security inputs when paper is intended to replay production behavior.