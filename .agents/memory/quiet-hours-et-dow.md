---
name: Quiet hours byDow keyed by ET day
description: Smart Quiet Hours V2 per-day rules are keyed by (ET day, UTC hour); enforcement must resolve "today" in America/New_York, never getUTCDay()
---

**Rule:** `silencedByDow` / `reducedByDow` keys are ET days (matching the UI's day tabs), while the inner keys are UTC hours. Any code reading these maps must resolve the current day with `getEtDow()` (America/New_York), not `Date.getUTCDay()`.

**Why:** The UI grid shows day tabs in ET but stores UTC hour keys. A rule set on "Sunday 9PM ET" is stored as dow=0, hour=1 UTC — but 1:00 UTC is already Monday in UTC. Using getUTCDay() made every ET-evening rule (8PM–midnight ET = UTC hours 0–4) land under the wrong day and silently never fire — user's 50% reduced-bet hour was ignored and bets placed at 100%.

**How to apply:** Use `resolveQuietHoursV2State(qhv2, now)` from kalshi-bot-engine-core — shared by the loop enforcement and both status endpoints so display and enforcement can never disagree. DOW-first semantics: a day with its own byDow entry ignores the flat lists entirely. Note the analytics SQL (kalshi-bot-db) already buckets bets by ET dow, so auto-tune writes are consistent with this.

Also: the quiet-hours reduced-bet % cap in kalshi-bot-tick must be applied AFTER the bet randomizer (randomizer overrides all sizing, but the quiet-hours % must still reduce the randomized amount).
