---
name: Daily trading P&L boundary
description: Defines the authoritative day boundary, paper wallet balance, and eligible dashboard trading sources.
---

Daily trading P&L resets only at midnight in `America/New_York`, using the timezone database so EST/EDT transitions are automatic. It is realized P&L from regular bot settlements plus canonical High-Value Scalper settlements only. Manual orders, mirrored legacy Scalper rows, Contrarian experiments, and shadow/observational studies are excluded.

Paper Balance uses the same regular-plus-canonical-Scalper ownership from the configured wallet reset boundary. The dashboard must read that balance from the database-backed P&L response; in-memory bot balance is only a runtime risk counter and can become stale across mode switches or settlement reconciliation.

**Why:** A UTC date rollover reset the dashboard at 8 PM Eastern and made an intra-evening regular-bot net result look like a random daily loss. Later, a stale in-memory balance showed the wallet falling while authoritative daily P&L was positive. Reusing broad history sources also risks double-counting or including experiments.

**How to apply:** Keep dashboard reporting database-backed and separate from in-memory risk counters. Resolve both day start and next reset in `America/New_York`; filter regular rows to the regular-bot source and Scalper rows to the canonical Scalper order store. Reload the runtime paper balance when switching into paper mode.