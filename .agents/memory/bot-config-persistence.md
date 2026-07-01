---
name: Bot config persistence
description: Why bot_config DB saves were silently failing and the stale-draft UI bug
---

## Drizzle onConflictDoUpdate was silently failing

`updateBotConfig` and `_persistModeToConfig` in `kalshi-bot.ts` used Drizzle's
`.onConflictDoUpdate({ target: botConfigTable.id, ... })` — this silently threw
on every call. The `try/catch` swallowed it (logged as WARN, never surfaced).
Result: `bot_config` table was always empty, every restart used hardcoded defaults.

**Why:** Raw SQL upsert works perfectly; the Drizzle ORM call does not for this table.
Other tables (`kalshi_bot_bets`, `bot_auto_tune_log`) use plain INSERT and are unaffected.

**Fix:** Both functions now use `db.execute(sql\`INSERT ... ON CONFLICT (id) DO UPDATE ...\`)`.
Error level raised to ERROR so future failures are visible in logs.

## Stale draft masked real backend config in UI

`merged = { ...cfg, ...configDraft }` — if the user had pending local edits
and the server restarted (reverting to defaults), `cfg` updated correctly
but `configDraft` kept overriding it. The user saw their old settings while
the backend ran different ones. Clicking "Reset" (which calls `setConfigDraft({})`)
cleared the draft and revealed the gap — users mistakenly thought Reset *caused*
the backend change.

**Fix:** `useEffect` in `bot-dashboard.tsx` watches `status?.config`; when it
changes (JSON diff), calls `setConfigDraft({})` to drop stale draft immediately.
