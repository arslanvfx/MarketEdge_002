---
name: Dashboard 2 shared operations
description: Defines which mature execution modules Dashboard 2 reuses instead of owning.
---

Dashboard 2 owns the new regular-bet workflow, but it should surface the existing High-Value Scalper, regular Smart Exit/stop-loss, High-Value Scalper Fast Smart Exit, Smart Quiet Hours, and per-coin pause/max-bet controls directly.

**Why:** The user considers these modules perfected and explicitly wants the same canonical services and controls available from both dashboards. Cloning them would reinvent working logic and create competing execution paths or conflicting configuration.

**How to apply:** Reuse the existing frontend modules, APIs, configuration, lifecycle state, ledgers, reservations, and schedulers. Dashboard 2 may provide another control surface, but must not create Bot 2-specific copies. Its regular-entry runtime must enforce canonical Smart Hours and per-coin controls before sizing/reservation and again at final live placement.