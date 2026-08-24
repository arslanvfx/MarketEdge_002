---
name: Contrarian strict reversal profile
description: Safety contract separating rare Contrarian reversals from broad normal Scalper guard blocks.
---

Contrarian Spike owns an independent final-120-second monitor across every supported market. A setup can proceed only when the authenticated opposite-side ask is 1–3¢ and fresh target-specific evidence shows repeated adverse movement plus either an actual target crossing or a projection credibly reachable before close.

**Why:** Normal Scalper guard blocks are intentionally broad and protective. Treating every guard block as a contrarian opportunity produced misleading evidence and exposed the experimental lane to generic volatility, stale identity, weak movement, and prices outside the intended 1–3¢ asymmetric payoff.

**How to apply:** Keep normal Scalper policy unchanged. Do not reuse its candidate filters or enablement toggles for Contrarian monitoring. Revalidate quote, market identity, target, timing, repeated movement, and crossing/reachability after refresh and again at the synchronous pre-submit boundary; fail closed on any mismatch. Continue to route qualified setups through the existing isolated Contrarian caps, reservations, exposure checks, breaker, settlement, and paper/live lifecycle.