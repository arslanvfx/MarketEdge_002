import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("transaction history filters in SQL before applying the row limit", () => {
  const analytics = readFileSync(
    new URL("./kalshi-bot-analytics.ts", import.meta.url),
    "utf8",
  );
  assert.match(analytics, /kind === "transactions"/);
  assert.match(
    analytics,
    /action\} IN \('bet', 'exit', 'late_recovery_exit', 'expired'\)/,
  );
  assert.match(analytics, /kind === "skips"/);
  assert.match(analytics, /action\} = 'skip'/);
});

test("all-history route accepts transaction and skip views with 500 rows", () => {
  const route = readFileSync(
    new URL("../routes/kalshi-bot.ts", import.meta.url),
    "utf8",
  );
  const historyRoute = route.slice(
    route.indexOf('router.get("/crypto/bot/all-history"'),
    route.indexOf('router.get("/crypto/bot/stats"'),
  );
  assert.match(historyRoute, /Math\.min\(500/);
  assert.match(historyRoute, /req\.query\.kind === "transactions"/);
  assert.match(historyRoute, /getBotAllHistory\(limit, offset, mode, resetAt, kind\)/);
});