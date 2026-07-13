---
name: Conviction mode ROI gate bypass
description: ROI gate in makeBotDecision must be skipped in conviction mode or it silently kills all bets
---

# Conviction mode — ROI gate must be bypassed

## The rule
In `kalshi-bot-engine.ts` `makeBotDecision`, the `roi-too-low` gate that returns SKIP when
`calcROI(action, yesPrice) < MIN_ROI_PCT` must be gated on `config.decisionMode !== "conviction"`.

## Why
In conviction mode the entry signal is the Kalshi yesPrice crossing the 88–92 ¢ lock zone.
When the market strongly prices in a direction (yesPrice ≈ 0.001) the ROI for betting the
OTHER side is near-zero by the market-price formula — even though that's exactly the bet
conviction mode is targeting.  Without the bypass, `makeBotDecision` returns SKIP for EVERY
coin, the tick returns at the SKIP handler (line 649) before the conviction price-zone check
runs, and no bets fire for the entire window.

## How to apply
- The guard: `if (roi < MIN_ROI_PCT && config.decisionMode !== "conviction")`
- The calcROI formula itself is correct: YES ROI = (1-p)/p, NO ROI = p/(1-p) where p=yesPrice
- This is the sole bypass needed — all other SKIP paths in the engine are valid for conviction
