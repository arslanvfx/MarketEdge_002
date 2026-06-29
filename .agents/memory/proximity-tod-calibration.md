---
name: Proximity & time-of-day calibration
description: Correct proximity thresholds and time-of-day modifiers derived from 62+ evaluated records per coin (BTC/ETH/XRP/HYPE/BNB/SOL)
---

## Proximity thresholds (crypto.ts snap-time modifier, ~line 2875)

Kalshi sets the strike at the current market price when the window opens. Snaps happen 30-90s later, so average proximity is only 0.04-0.09% across all coins. The old thresholds (>0.2% = clear edge, <0.1% = on the line) were wrong by 2-5×, causing the penalty to fire on 40-56 of every 61 records.

**Correct thresholds (empirical, June 2026):**
| Bucket | Threshold | Accuracy (cross-coin) | Action |
|---|---|---|---|
| Clear edge | > 0.1% | 64-83% | +boost, proportional to (pct - 0.1) × 20, cap +6 pts |
| Modal range | 0.03-0.1% | 33-73% (mixed) | no change |
| Coin-flip zone | < 0.03% | 47-57% | -4 pts penalty, floor 50 |

**Why:** The 0.2% threshold was inferred from rare outlier windows (strong pre-existing directional moves). Those are uncommon — the norm is a tiny spread at snap time.

**How to apply:** Only recalibrate thresholds if you have 40+ evaluated records per proximity bucket per coin. Do not revert to 0.2/0.1 without new data.

## Time-of-day modifiers (same block, ~line 2889)

Calibrated from the same 62-record/coin dataset. Cross-coin patterns require n≥4 per hour.

| Hour (UTC) | Cross-coin accuracy | Decision |
|---|---|---|
| UTC 19 (3 PM ET) | 75-100% for all 6 coins | +4 pts boost — kept |
| UTC 17 (1 PM ET) | Insufficient cross-coin data | boost removed |
| UTC 20-22 (4-6 PM ET) | BTC/ETH/XRP 25%; BNB/SOL 75% | reduce removed (coin-specific, not universal) |

**Why:** The UTC 20-22 reduce was helping BTC/ETH but hurting BNB/SOL which have strong accuracy there. Removing it avoids the cross-coin conflict. UTC 19 is the one truly clean cross-coin signal.
