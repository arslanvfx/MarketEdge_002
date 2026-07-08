---
name: calcROI NO-bet block
description: calcROI() used cents format (100-p)/p but yesPrice is 0-1 dollars — silently blocked every NO bet via MIN_ROI_PCT gate
---

## Rule
`calcROI` in `kalshi-bot-engine.ts` MUST use 0-1 dollar format:
- YES: `(1 - yesPrice) / yesPrice * 100`
- NO: `yesPrice / (1 - yesPrice) * 100`

The guard condition must be `yesPrice > 0 && yesPrice < 1`, not `< 100`.

## Why
When yesPrice=0.52 (dollars) was passed to the old cents formula:
- NO ROI = `0.52 / (100 - 0.52) * 100 ≈ 0.52%` — always below MIN_ROI_PCT=1.4% → every NO blocked
- YES ROI = `(100 - 0.52) / 0.52 * 100 ≈ 19,131%` — always passed

All other gate functions (computeEV, computeEVForDirection, checkMinReturnGate) already used 0-1 format correctly. Only calcROI was wrong.

## How to apply
If NO bets stop appearing again, check `calcROI` first. Also confirm the ROI guard is `yesPrice < 1` not `yesPrice < 100`.
