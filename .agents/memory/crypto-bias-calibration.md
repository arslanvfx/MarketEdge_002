---
name: Crypto bias calibration (source-tagged)
description: How signed-bias calibration is safely injected into Claude prompts now that prediction records are tagged by model source.
---

## Rule
`computeSignedBias()` output MAY be injected into Claude's prompt, but ONLY when computed over records the Claude model itself produced. Prediction records carry a `source: "stat" | "claude"` tag for exactly this reason. `computeSignedBias()` filters to `source === "claude"` before computing the signed error, and the on-demand feedback list fed to Claude is filtered the same way.

**Why:** The tracker defaults to the free statistical model; Claude only runs when a coin is explicitly enabled. Before source-tagging, `historyStore` mixed stat + claude records, so a calibration note built from the stat model's errors was applied to Claude. The two models have different bias patterns, so the stat correction caused systematic directional flips (e.g. "shift DOWN 2%" crossing a Kalshi strike and inverting the ABOVE/BELOW call on a clearly-up market). Tagging by source removes the cross-contamination, which is what makes injection safe.

**How to apply:** Any feedback/calibration signal fed into a model's prompt must be derived only from that model's own historical records. New record sources must extend the `source` field and the corresponding filters in `computeSignedBias()` and the prompt's feedback builder. New rows default to `"stat"`; the tracker sets `"claude"` when the prediction was AI-refined. A schema migration backfills pre-existing rows to `"stat"` (correct — Claude was off historically).
