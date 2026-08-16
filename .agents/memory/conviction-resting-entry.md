---
name: Conviction resting GTC entry
description: Real-book conviction entries use one full-size resting GTC order; ambiguity must fail closed; limit price is only an upper bound
---

# Conviction resting GTC entry

**Rule:** Real-book conviction entries place ONE `good_till_canceled` limit order for the FULL contract count and let it rest. Never IOC/FOK-slicing for entries — an instant book snapshot routinely fills 1 of 9 contracts.

**Why:** Kalshi 15-min crypto books are made by reactive market makers with little standing depth; they complete resting orders within seconds but IOC produced tiny partial positions ($0.83 fill on an $8 bet).

**How to apply:**
- Kalshi v2 accepts `"good_till_canceled"` (one L); `"gtc"` / two-L spelling 400. Always send an integer Unix-seconds `expiration_time` backstop so the order cannot outlive a process crash.
- **Ambiguity fails closed.** A placement POST error may occur AFTER Kalshi accepted the order — reconcile by caller-owned `client_order_id`; only a confirmed-absent lookup may report a clean 0-fill. Terminal confirmation comes ONLY from a post-cancel order read showing cancelled/filled/404 — a successful DELETE alone is NOT proof (final fill count is unknown; fills can land between last poll and cancel). Anything unconfirmed → block the coin for the window and carry the order id on the position (including any temporary emergency-close position) so every exit path cancels-before-sell.
- **Crash safety.** A provisional `resting_pending` DB row (with client_order_id) is written BEFORE placement and deleted only on confirmed-terminal; startup recovery reconciles pending rows against the exchange (cancel + confirm, adopt fills that landed while down) and runs BEFORE position restore. Ambiguous rows stay pending — never resolved on ambiguity.
- **Restore-on-failure.** Every `openPositions.delete` + `closePosition` pair must restore the position on close failure (window-expiry included) — dropping it strands a possibly-live entry order with no retry path.
- **The GTC limit is only an UPPER price bound.** A resting YES bid at the zone cap CAN fill below the zone floor if the market moves through it between polls. The post-fill zone check (Layer 3 emergency close) must stay active for resting entries — never assume "resting fills are always in zone".
- Record positions by ACTUAL filled count + weighted-average price, never the requested count.
- Empty-book poller-fallback entries stay FOK all-or-nothing (FOK triggers reactive MM matching; a resting order on a truly empty book just sits).
