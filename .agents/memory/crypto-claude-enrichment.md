---
name: Crypto Claude enrichment
description: How Claude AI is integrated into the Crypto Predictor prediction pipeline
---

# Crypto Predictor — Claude AI Enrichment

## Rule
`enrichWithClaude()` in `artifacts/api-server/src/lib/crypto.ts` is called after `analyzeCoin()` for each coin in `fetchCryptoPredictions()`. It sends 20 recent candles + all indicators to Claude (sonnet-4-6) and overlays the response onto the statistical predictions by position index.

**Why:** The statistical model uses fixed weights and can't detect chart patterns or synthesise signals contextually. Claude adds per-forecast direction, confidence, and a one-sentence reasoning shown in the UI.

## How to apply
- Cache key: coin symbol, TTL: 2.5 min (`CLAUDE_TTL = 150_000`).
- Matching: by array position (analysis[0] → predictions[0]), NOT by minutesAhead.
- Fallback: any Claude error is caught silently; statistical model values are kept.
- Model: `claude-sonnet-4-6` with no temperature param (deprecated on newer models).
- Frontend: `reasoning?: string` on `Prediction` interface; displayed below confidence bar with a `Brain` icon.
- No DB storage — purely in-memory cache; reasoning resets on server restart.
