---
name: Live direction aboveKalshi null
description: Why fetchLiveDirection returns aboveKalshi:null mid-window, and how autoPilotAbove must incorporate the live direction signal.
---

## The rule
`fetchLiveDirection` internally calls `fetchKalshiTarget(symbol)` (no boundary arg), which has a 12-second TTL cache (`KALSHI_TARGET_LIB_TTL`). Between polls the cache can expire → returns null → Claude gets a prompt with no strike price → responds with `{direction:"up"}` format → `aboveKalshi` stays null. The autopilot must not silently fall back to the window-open snapshot in this case.

## Fix applied (fetchLiveDirection — crypto.ts)
After `fetchKalshiTarget` returns null, fall back to the raw `kalshiTargetCache` entry directly (bypassing TTL) as long as `closeTime` hasn't passed. The Kalshi strike is fixed for the whole 15-min window, so any entry from this window is valid.

```typescript
let kalshiTargetVal = kalshiTargetFresh;
if (kalshiTargetVal == null && KALSHI_SERIES[coin.symbol]) {
  const stale = kalshiTargetCache.get(coin.symbol.toUpperCase());
  if (stale?.value != null) {
    const ct = stale.closeTime;
    if (!ct || new Date(ct).getTime() > Date.now()) kalshiTargetVal = stale.value;
  }
}
```

## Fix applied (autoPilotAbove — predictor.tsx)
`autoPilotAbove` was using `claudeAbove` (opening call) → `trackerSnapshot?.aboveKalshi` (also opening) — both locked at window start. The live direction result (`liveDirection`) was passed into the component but never consulted.

New priority order (both active/stat modes):
1. `liveDirection?.aboveKalshi` — current mid-window Claude re-check
2. `claudeAbove` — opening Claude call
3. `livePrice >= kalshiTarget` — current price position (never stale opening snapshot)

**Why:** With 10+ min elapsed and price well below target, showing the window-open opinion ("ABOVE") as the autopilot recommendation misleads the user into a wrong bet.

**How to apply:** Any new signal that computes a mid-window direction should be wired into `autoPilotAbove` with the highest priority. Opening snapshots are useful for "at open" display only — they must NOT dominate mid-window autopilot decisions.
