---
name: Claude Pulse two-signal UI
description: Architecture for the "opening call vs live direction" mid-window pull-out signal shown on the Crypto Predictor coin card.
---

## Architecture

**Two signals shown side-by-side for training coins (BTC/ETH/XRP/HYPE/BNB):**

### Opening call — `getTrackerWindowCall(symbol)` (crypto.ts)
- Reads from `historyStore` (in-memory Map), costs nothing
- Finds record where `source === "claude"` and `targetTime === nextBoundary.toISOString()`
- Next boundary = `Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS`
- Returns `TrackerWindowCall { direction, aboveKalshi, predictedPrice, confidence, snappedAt }` or null
- Null until the tracker runs Claude at window open (first 4 min of window)
- Route: `GET /crypto/tracker-snapshot/:symbol` → `{ snapshot: TrackerWindowCall | null }`

### Live re-check — `fetchLiveDirection(symbol)` (crypto.ts)
- Lightweight Claude call: no extended thinking, max_tokens 40, 5-candle context only
- Asks binary `{"above":true,"confidence":70}` for Kalshi coins
- Asks `{"direction":"up","confidence":65}` for non-Kalshi coins
- Cached 5 min per coin in `liveDirectionCache`; `force=true` bypasses cache
- Route: `GET /crypto/live-direction/:symbol` — accepts `?force=1`

### Frontend (`predictor.tsx`)
- `trackerSnapshotQuery` polls `/tracker-snapshot/:selected` every 30s
- `liveDirectionQuery` polls `/live-direction/:selected` every 5 min
- Both enabled when `trainingCoinsSet.has(selected) || claudeEnabledSet.has(selected)`
- Shown only when `kalshiTarget !== null` (Kalshi must be live)
- `showPanel` = `snap !== null || live !== null || liveDirectionLoading`

### Divergence logic
- `flipped = snapAbove !== null && liveAbove !== null && snapAbove !== liveAbove`
- Red border + "⚠ Direction changed" badge + explanation text when flipped
- Green border + "✓ Confirmed" badge when both agree

## Key pitfall
`AboveLabel` must be a **module-level** function, NOT defined inside the render IIFE.
React sees a new component type every render when it's defined inside an IIFE → unmounts/remounts on each render.
Extracted it just before `CoinDetail` function.

**Why:** React component identity is based on function reference; closures inside render create new references each call.
**How to apply:** Any JSX-returning helper that is used as `<Component />` syntax must be defined outside the render function.
