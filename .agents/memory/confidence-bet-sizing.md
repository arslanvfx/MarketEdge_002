---
name: Confidence-based dynamic bet sizing
description: How the bot scales bet size with confidence, and the barrel-export gotcha that broke the build
---

# Confidence-based dynamic bet sizing

`computeDynamicBetSize(confidence, config)` (pure, in `kalshi-bot-engine-core.ts`)
linearly interpolates the target dollar bet between `config.betSize` (minimum, at
`config.minConfidence`) and `config.maxBetSize` (maximum, at
`config.dynamicSizingMaxConfidence`). Below the floor → min; at/above the ceiling → max.

**Config:** `enableDynamicSizing` (default false) and `dynamicSizingMaxConfidence`
(default 85). When disabled, returns `config.betSize` unchanged (legacy behavior).

**Wiring:** used in `placeBet()` to compute `contractCount` BEFORE the existing hard
`maxBetSize` safety cap (`checkMaxBetSizeGuard`) runs — the cap still guards against
oversized orders regardless of sizing.

**Why min-bet fallbacks:** non-finite confidence, inverted range (betSize ≥ maxBetSize),
and degenerate confidence range are all handled to never exceed maxBetSize nor produce
a bogus contractCount.

## Barrel-export gotcha (cost a build break)
`kalshi-bot.ts` imports engine helpers from `./kalshi-bot-engine` (a re-export barrel),
NOT directly from `./kalshi-bot-engine-core`. A new pure helper added to core must ALSO
be added to BOTH the import-from-core block AND the `export { ... }` block in
`kalshi-bot-engine.ts`, or esbuild fails with "No matching export ... for import".

**How to apply:** any time you add an exported function/const to `kalshi-bot-engine-core.ts`
that `kalshi-bot.ts` (or routes) needs, thread it through the barrel too.
