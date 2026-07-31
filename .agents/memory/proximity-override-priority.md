---
name: Proximity threshold override priority
description: Conviction proximity calibration must beat per-coin overrides; wasted-FOK skip pattern
---
Rule 1: in conviction mode, `convictionStrikeProximityMinPct` takes priority over per-coin `strikeProximityMinPctOverrides` (per-coin applies only in non-conviction paths or when the conviction value is unset).

**Why:** Original helper checked per-coin overrides first, so the operator's conviction calibration knob silently no-oped for any coin with an override — SOL NO at 83¢ (inside zone) was blocked repeatedly by its 0.19% override. This suppressed bet volume right after the calibration shipped.

Rule 2: before placing a conviction FOK, `isConvictionFokFillable` (engine-core, pure) checks whether the strict lockPriceCap-pinned limit can execute against the fresh book (YES: limit ≥ ask; NO/YES-sell: limit ≤ yes-bid). If unfillable, skip WITHOUT charging `windowFailedFills`, release `convictionFiredThisWindow`, restore max-bet token — mirrors the belowFloor/aboveCap abort paths.

**Why:** Trigger buffers (capBuffer) pass prices past the strict cap, but the FOK limit is pinned to the cap → guaranteed-kill orders exhausted retries and locked the coin out for the whole window.

**How to apply:** Any layered-config helper (global → mode-specific → per-coin) must document and test its priority order. Any trigger-vs-limit asymmetry must be fillability-checked before charging failure penalties.
