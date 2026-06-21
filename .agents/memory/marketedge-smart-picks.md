---
name: MarketEdge Smart Picks value analysis
description: How the AI-vetted Smart Picks parlay generator avoids nonsense/misleading combos
---

# Smart Picks must stay trustworthy

The original Smart Picks surfaced near-50% novelty combos ("X before GTA VI") as if
they were good bets. Three properties keep it honest now — break any one and nonsense
returns:

1. **No synthetic odds.** Market parsers MUST return null (and be filtered out) when no
   real live price exists. Never default an odds field to 0.5 — that exact default was the
   original "fake odds" bug.
   **Why:** a 0.5 placeholder reads as a genuine coin-flip market and pollutes the pool.

2. **Confidence shrinkage before computing edge.** Blend the AI's raw trueProbabilityYes
   toward the live market price by a confidence weight (low~0.45 / med~0.65 / high~0.85)
   BEFORE computing edge = trueProb - price.
   **Why:** raw AI estimates are overconfident; multiplying several overconfident edges
   into a parlay produced fantasy numbers (saw +42000% EV). Shrinkage keeps edges credible.

3. **Correlation guard inside a combo.** Reject any combo containing two legs from the same
   market "family" (normalize the title by stripping numbers/percentages/months/years; legs
   sharing a normalized key are treated as correlated, e.g. CPI threshold ladders).
   **Why:** parlay math multiplies leg probabilities assuming independence; correlated legs
   (multiple CPI-threshold markets for the same/adjacent months) violate that and inflate
   edge. **How to apply:** in optimizer combo generation, dedupe legs by family key.

# EV math (core scoring metric)
A parlay is positive-EV iff Π(trueProb / price) > 1. edgePercent = (that product - 1)*100.
expectedValue = stake * (jointTrueProb * payoutMultiplier - 1).

# AI analysis reliability
analyzeMarkets batches Claude per chunk. Per-chunk processor must let rate-limit errors
propagate (so batchProcess retries) but degrade ALL other errors to fallback
(plausible:false) analyses — otherwise one chunk failure 500s the whole endpoint and the
user sees no picks.
