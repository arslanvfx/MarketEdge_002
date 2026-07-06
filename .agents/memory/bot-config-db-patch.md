---
name: Bot config DB patch vs in-memory
description: psql patching bot_config only affects the DB; the live server's S.config is unchanged until restart; paperDecisionMode must match decisionMode for mode-switch safety
---

## Rule
Patching `bot_config` via psql (or any out-of-band DB write) does NOT update the running server's in-memory `S.config`. The server loads config once at startup via `loadBotConfigFromDB()` and caches it. To make a DB change take effect, the server must be restarted.

**Why:** `S.config` is an in-memory module-level object. `updateBotConfig()` in the app code updates it atomically (both memory and DB). Direct psql writes bypass the in-memory layer entirely.

**How to apply:**
1. After any manual psql patch to `bot_config`, restart the API server workflow so the fresh config is loaded.
2. When patching `decisionMode`, always also set `paperDecisionMode` (and `liveDecisionMode` if relevant) to the same value. On mode switches, `setBotMode()` restores `decisionMode` from the mode-specific field — if they differ, the effective mode reverts on next mode toggle.
3. Correct patch template:
   ```sql
   UPDATE bot_config
   SET config = config || '{"decisionMode":"ml_gate","paperDecisionMode":"ml_gate"}'::jsonb
   WHERE id = 'default';
   ```
   Then restart the workflow.
