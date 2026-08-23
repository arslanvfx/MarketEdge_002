---
name: Scalper shadow-study isolation
description: Safety and timing invariants for counterfactual earlier-entry research.
---

Earlier-entry shadow research must remain observational: it runs for disabled and operator-paused Scalper symbols, uses only existing cached Kalshi identity/quote data plus the shared underlying sample lane, and never affects execution or real performance.

**Why:** Conditioning the study on execution enablement makes coverage incomplete, while extra exchange polling, shared reservations, or blocking persistence could distort or slow the live path. Cached quotes also cannot prove that an IOC order would have filled.

**How to apply:** Anchor every variant's opening time, guard warmup, and reported time remaining to the expected 15-minute close. Preserve configured timing precision exactly, including fractional seconds. Use cached close time only for identity validation. Schedule bounded best-effort persistence after live work, and keep settlement/reporting in isolated shadow storage. In reports, mark an individual row as current only when its timing matches that symbol's effective override-aware timing; the global setting is only a comparison for overridden symbols.