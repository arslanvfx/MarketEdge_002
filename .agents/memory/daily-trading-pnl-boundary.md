---
name: Daily trading P&L boundary
description: Defines the authoritative day boundary and eligible sources for the dashboard's daily trading P&L.
---

Daily trading P&L resets only at midnight in `America/New_York`, using the timezone database so EST/EDT transitions are automatic. It is realized P&L from regular bot settlements plus canonical High-Value Scalper settlements only. Manual orders, mirrored legacy Scalper rows, Contrarian experiments, and shadow/observational studies are excluded.

**Why:** A UTC date rollover reset the dashboard at 8 PM Eastern and made an intra-evening regular-bot net result look like a random daily loss. Reusing broad history sources also risks double-counting or including experiments.

**How to apply:** Keep dashboard reporting database-backed and separate from in-memory risk counters. Resolve both day start and next reset in `America/New_York`; filter regular rows to the regular-bot source and Scalper rows to the canonical Scalper order store.