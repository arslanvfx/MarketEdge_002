---
name: Confidence-based dynamic bet sizing
description: How the bot scales bet size with confidence, and the barrel-export gotcha that breaks the build
---

# Confidence-based dynamic bet sizing

`computeDynamicBetSize(confidence, config)` linearly interpolates the dollar bet
between `betSize` (at `minConfidence`) and `maxBetSize` (at
`dynamicSizingMaxConfidence`). Off by default (`enableDynamicSizing`); when off it
returns `betSize` unchanged.

**Rule:** dynamic sizing runs BEFORE the hard `maxBetSize` safety cap, so the cap
always guards against oversized orders regardless of the sizing math. Any new sizing
logic must preserve that ordering and must never emit a non-finite / oversized count.

## Barrel-export gotcha (cost a build break)
**Rule:** `kalshi-bot.ts` imports engine helpers from the `./kalshi-bot-engine`
re-export barrel, NOT from `./kalshi-bot-engine-core`. Any exported helper added to
core that `kalshi-bot.ts` (or routes) needs must ALSO be threaded through the barrel
(both the import-from-core block and the `export { ... }` block), or esbuild fails
with "No matching export ... for import".
**Why:** the barrel is the only public surface; core is private. Easy to miss because
the symbol exists and typechecks in core — only the bundler catches it.
