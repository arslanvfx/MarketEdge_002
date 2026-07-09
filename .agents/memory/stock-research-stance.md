---
name: Stock research stance lists
description: How Claude stance (buy_now/buy/watch/avoid) flows from research reports to the buy/avoid lists and the stock bot's gates
---

# Stock research stance

Claude research reports carry a `stance` verdict (`buy_now | buy | watch | avoid`) plus a `valuation` fundamentals note, in addition to horizon/confidence.

**Rules:**
- Legacy rows (pre-stance) must be normalized via `normalizeStance(raw, confidence)` — confidence-derived fallback (>=80 buy_now, >=60 buy, >=40 watch, else avoid). Never assume the DB column is populated.
- `topBuys` list = stance buy_now/buy, confidence-sorted, top 20. Do NOT add a confidence floor on "buy" — Claude is deliberately skeptical (most reports land 40-60), a floor can leave the Top-20 list empty.
- Bot integration is stance-driven on BOTH sides: entry loop skips stance=avoid candidates; position manager exits swing/long positions when today's cached report stance flips to avoid (`research_avoid`). Day trades are exempt from the exit (flattened intraday anyway).

**Why:** user wants Claude research feeding the bot in real time and "hates losing money" — the avoid list is a hard veto, not a soft signal.

**AI spend:** level is persisted per-environment in bot_config (`ai_spend` row), so dev=balanced does not affect prod. POST /api/crypto/ai-spend is admin-guarded (Clerk + optional BOT_ADMIN_CLERK_USER_ID) — mutations from curl need a signed-in session.
