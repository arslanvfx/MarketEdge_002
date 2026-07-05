---
name: FOK fill cooldown
description: windowFailedFills Set prevents the bot from retrying an empty order book every tick within the same window
---

## Rule
After `placeOrderWithRetry` exhausts all attempts and returns `filledCount === 0`, add the coin to `windowFailedFills` (`${sym}:${windowKey}:${botMode}`). Phase 3 checks this set before any other evaluation and pushes the coin to `filteredByNewGuards` + SKIP, so it never appears in `betSymbols` for the rest of that window.

**Why:** Without this, the bot retried all 4 coins every ~30s tick for an entire 15-min window after a failed fill (observed nightly ~11PM ET when Kalshi books are empty). Each retry consumed a full retry budget (Phase1 + Phase2 escalation) hitting the Kalshi API repeatedly.

**How to apply:** `windowFailedFills` is a `Set<string>` declared at module level alongside `windowBetDetails`. Clear it in the window-transition block (`windowDirectionCounts.clear()` — add `windowFailedFills.clear()` immediately after). The Phase 3 guard must add to `filteredByNewGuards` so the coin is also excluded from `skipSymbols` (which filters out `filteredByNewGuards` members).
