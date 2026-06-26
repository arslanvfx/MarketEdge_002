---
name: Stat+Claude ensemble & abstention
description: How the adaptive ensemble blends stat+Claude, when it abstains, and the consistency rules between server and client
---

# Adaptive ensemble + smart abstention (crypto predictor)

The headline "Combined Call" is a regime-weighted blend of the stat baseline and
Claude, with an explicit no-bet abstention.

## Direction must be price-derived, never the raw model string
**Rule:** When deciding ensemble direction-disagreement (abstention trigger), each
model's direction MUST be derived from `(predictedPrice - referencePrice)` with the
±0.05% threshold — NOT the raw `direction` string from Claude's JSON, and not the
stat model's stored `direction`.
**Why:** Claude's emitted `direction` text can contradict its own `predictedPrice`;
trusting it makes the persisted abstention disagree with the DISPLAYED up/down calls
and diverge from the client mirror. (Caught in code review.)
**How to apply:** In the tracker's ensemble-record creation (crypto.ts) compute
`dirFromPrice(p)` against `analysis.price` before calling `computeEnsemble`. The
client `computeCombinedCall` already derives dirs from livePrice the same way.

## Server/client mirror
`computeEnsemble` (server, crypto.ts) and `computeCombinedCall` (client,
predictor.tsx) must stay in lockstep: same weights, same `confidence <
ENSEMBLE_ABSTAIN_MIN_CONF` low-conf rule, same conflict rule, same ±0.05% dir
threshold. The client receives `ensembleWeights`/`abstainMinConf` from the
ai-predict payload so the on-screen headline matches what the server persists.

## Abstention quality semantics
For an abstained+evaluated ensemble record: `correct === false` = **avoided loss**
(good skip); `correct === true` = **missed win** (bad skip). The analytics
`avoidedLoss` counts `correct === false`. Any UI tooltip/label must follow this —
it is easy to invert.

## Records per window
Tracker stores `stat` (always) + `claude` + `ensemble` (when Claude ran), each with
id `${sym}-${targetTime}-${source}`. Ensemble accuracy (bySource/byRegime) covers
BET windows only — abstentions excluded. The prediction-history route returns ONE
headline row per window (ensemble › claude › stat) plus a `sourceSummary` rollup.
