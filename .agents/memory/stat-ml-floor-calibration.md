---
name: stat_ml floor calibration
description: Correct floor values for statMLMinMLConf and statMLMinStatConf; why 67 kills all bets.
---

## Rule
- `statMLMinMLConf` = **57** (not 67, not 62)
- `statMLMinStatConf` = **53**
- Inline fallback `?? 57` in `computeStatMLDecision`, `DEFAULT_BOT_CONFIG`, and `BUILT_IN_MODE_DEFAULTS` in routes must all match the DB value.

**Why:** ML model is a logistic regression calibrated to [50–65%] range. Average ML confidence per coin is 61–67%. Setting the floor at 67 puts it above the model's practical ceiling — zero bets ever pass. 62 was still too high on weak-signal days. 57 matches the lower quartile of ML output and unlocks bets when stat+ML genuinely agree.

**How to apply:** Any time `statMLMinMLConf` is changed, patch all three locations atomically:
1. `kalshi-bot-engine-core.ts` inline fallback (`?? N`)
2. `DEFAULT_BOT_CONFIG.statMLMinMLConf` in same file
3. `BUILT_IN_MODE_DEFAULTS` stat_ml entry in `routes/kalshi-bot.ts`
4. DB: `UPDATE bot_config SET config = jsonb_set(config, '{statMLMinMLConf}', 'N'::jsonb) WHERE id = 'default';`
Then restart the server (DB patch does not update live in-memory S.config).
