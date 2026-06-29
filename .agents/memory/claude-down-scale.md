---
name: Claude per-coin down-scale
description: Per-coin data-driven Claude down-call weighting; BNB is inverted (down > up accuracy), fixed 0.70 hurts it
---

## Function: computeClaudeDownScale(symbol) — crypto.ts ~line 1205

Replaces the old hardcoded `claudeDownScale = 0.70` in `computeEnsemble`.

**Formula:** `clamp(claudeDownAcc / claudeUpAcc, 0.5, 1.0)`

Reads from historyStore (in-memory, max ~22 claude records per coin due to MAX_HISTORY=90 across 4 sources). Falls back to 0.85 when either direction has < 5 evaluated records.

**Empirical values (June 2026, from DB, 62+ records/coin):**
| Coin | Claude down acc | Claude up acc | Computed scale |
|---|---|---|---|
| BNB | 70.3% | 42.9% | 1.0 (clamped — down > up, no penalty) |
| BTC | 45.8% | 63.2% | ~0.72 |
| ETH | 38.5% | 66.7% | ~0.58 (stronger than old 0.70) |
| HYPE | 50.0% | 80.0% | ~0.63 |
| XRP | 56.5% | 60.0% | ~0.94 (near-equal, almost no penalty) |
| SOL | 66.7% | 100.0% | ~0.67 |

**Why:** BNB's Claude model calls "down" on the majority of windows (37 down, 7 up) and is MORE accurate for down calls. The fixed 0.70 was actively redistributing weight away from BNB's stronger signal toward a weaker one.

**How to apply:** The clamp upper bound is 1.0 — we never up-weight down calls beyond equal weighting, even if down_acc > up_acc. The clamp lower bound is 0.5 so stat always retains a meaningful voice. This self-corrects as more data accumulates without any code changes.
