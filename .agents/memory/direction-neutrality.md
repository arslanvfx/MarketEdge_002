---
name: YES/NO direction neutrality
description: Regime filter, contrarian-momentum gate, and momentum override removed from bot loop; philosophy and what remains
---

## The rule
The bot must treat YES and NO as equally valid in every 15-min window. No filter may penalise a direction purely because of historical macro trends or multi-window strike drift.

**Why:** Kalshi 15-min markets are bets on whether price will be above/below a specific strike at window close — not macro directional trades. A coin that has closed "below" strike 70% of the time historically can still close above in the next window. Penalising YES (or NO) based on that history creates a systematic directional bias that hurts P&L when the market shifts.

**What was removed from `kalshi-bot-loop.ts`:**
- Momentum override — blocked bets when multi-window Kalshi strike trend opposed proposed direction
- Regime filter — applied `regimePenalty` (was 15pp) when bet opposed the coin's historical above/below regime
- Contrarian-momentum gate — applied 10pp penalty when bet opposed the recent Kalshi strike trend

**What remains (appropriate for short-term windows):**
- Signal quality gates (Claude says NO vs BET_YES, ML says YES vs BET_NO) — these are current-window signals
- Position-relative NO gate — blocks NO bets when live price >0.1% above strike without ML confirm (7/7 loss data)
- Direction cap (`maxSameDirectionBets`) — limits same-direction bets per window for balance
- Border guard — blocks bets near extreme strike proximity
- Doubt/penalty system — raises confidence floor after a weak recent window

**How to apply:**
Do NOT re-add any filter that uses `S.regimeCache`, `CONTRARIAN_LIVE_REGIME_PENALTY`, or multi-window strike trend to penalise YES or NO direction. The `regime` variable is still computed for display purposes only.
