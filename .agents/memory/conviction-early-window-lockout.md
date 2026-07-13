---
name: Conviction early-window lockout zone & live-price gate
description: Two compounding bugs that blocked all conviction entries in the 88-92% YES zone
---

## The two bugs

### Bug 1 — Early-window bypass threshold too narrow
`minWindowEntryMinutes=9` had a hardcoded bypass for "extreme" prices (≥92¢ or ≤8¢).
Coins at 88–91¢ YES (or 9–12¢ NO) were correctly inside the conviction zone but held
by the timing gate for the first 9 minutes — the most common entry window.

**Fix:** bypass threshold in conviction mode uses `yesPrice >= lockPrice-0.02 || yesPrice <= 1-(lockPrice-0.02)` (= ≥0.88 or ≤0.12 for lockPrice=0.90).

### Bug 2 — Live-price gate lockPriceCap too tight (the bigger bug)
`lockPriceCap = gateTarget + 0.02 = 0.92`. When Kalshi shows "Up 90–92%", the live
orderbook YES ask is **93–95¢** due to the bid-ask spread (`no_bid=6–8¢ → yes_ask=92–94¢`).
Every valid conviction entry was aborted with "price moved outside window".

Evidence from logs: ETH freshYesAsk=0.932, HYPE=0.9345, BNB=0.9535 — all aborted (lockPriceCap=0.92).

**Fix:** `lockPriceCap = gateTarget + 0.05 = 0.95` in both:
- `kalshi-bot-tick.ts` (live-price gate before order placement)
- `kalshi-bot-engine.ts` (computeConvictionDecision trigger)

**Why:** The displayed mid and the actual orderbook ask differ by 1–3¢ on Kalshi. +0.02
covers the mid range but not the ask. +0.05 covers realistic asks when market shows 88–92%.

**How to apply:** If conviction bets stop firing with "price moved outside window", check
`freshYesAsk` in the log — it will exceed `lockPriceCap`. Raise lockPriceCap (+0.05 from
gateTarget is the calibrated value). Order limit is still hard-capped at lockPriceCap so
fills can never exceed 5¢ minimum return per contract.
