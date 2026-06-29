import app from "./app";
import { logger } from "./lib/logger";
import { fetchAllMarkets } from "./lib/markets";
import { startPredictionTracker } from "./lib/crypto";
import { runThresholdAnalysis, formatThresholdReport } from "./lib/backtest";
import { runMLBackfillIfNeeded } from "./lib/ml-backfill";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Run any additive schema migrations that are safe to apply at startup.
// Using IF NOT EXISTS / ADD COLUMN IF NOT EXISTS makes these idempotent.
async function runStartupMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE prediction_records
        ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
    `);
    // raw_confidence was originally INTEGER but ML stores a 0-1 probability
    // float — this widens the column to DOUBLE PRECISION (idempotent if already
    // that type; Postgres allows ALTER COLUMN TYPE to same-or-wider numeric).
    await client.query(`
      ALTER TABLE prediction_records
        ALTER COLUMN raw_confidence TYPE DOUBLE PRECISION
          USING raw_confidence::DOUBLE PRECISION
    `);
    // Window Monitor outcome tracking table — records each locked BET/STAY AWAY
    // signal and fills in the actual ABOVE/BELOW result at window close so
    // accuracy of the thresholds can be measured over time.
    await client.query(`
      CREATE TABLE IF NOT EXISTS window_monitor_outcomes (
        id                  TEXT PRIMARY KEY,
        symbol              TEXT NOT NULL,
        window_key          TEXT NOT NULL,
        target_time         TEXT NOT NULL,
        recommendation      TEXT NOT NULL,
        factors             JSONB NOT NULL,
        kalshi_target       NUMERIC(16,6),
        stat_predicted_above BOOLEAN,
        actual_above        BOOLEAN,
        outcome             TEXT,
        locked_at           TIMESTAMPTZ NOT NULL,
        evaluated_at        TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS wmo_symbol_locked
        ON window_monitor_outcomes (symbol, locked_at DESC)
    `);
  } finally {
    client.release();
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Apply additive schema migrations before initialising app state.
  runStartupMigrations()
    .catch((err) => logger.warn({ err }, "Startup migrations failed (non-fatal)"));

  // Pre-warm the market cache so the first user request is instant.
  fetchAllMarkets()
    .then((markets) => logger.info({ count: markets.length }, "Market cache warmed"))
    .catch((err) => logger.warn({ err }, "Market cache warm-up failed (non-fatal)"));

  // Start the prediction accuracy tracker: snaps model predictions at each
  // 15-min boundary and evaluates them against actual prices once the window closes.
  // The onInitComplete callback runs after initMLFromDB() resolves — backfill
  // runs at that point so it sees the true post-hydration warming status.
  startPredictionTracker(() => {
    runMLBackfillIfNeeded(96)
      .catch((err) => logger.warn({ err }, "[ml-backfill] startup backfill failed (non-fatal)"));
  });
  logger.info("Prediction tracker started");

  // Daily threshold analysis: runs once at midnight UTC then every 24h.
  // Fetches 96 windows (~24h) of historical candles, buckets hit rates by
  // pre-window efficiency ratio, and logs suggested threshold updates when
  // the data-derived optimum drifts from the current hardcoded values.
  const runDailyThresholdLog = () => {
    runThresholdAnalysis({ windows: 96 })
      .then((report) =>
        logger.info({ summary: formatThresholdReport(report) }, "[threshold-analysis] daily"),
      )
      .catch((err) =>
        logger.warn({ err }, "[threshold-analysis] daily run failed (non-fatal)"),
      );
  };
  const msUntilMidnightUTC = (): number => {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    return next.getTime() - now.getTime();
  };
  setTimeout(() => {
    runDailyThresholdLog();
    setInterval(runDailyThresholdLog, 24 * 60 * 60 * 1_000);
  }, msUntilMidnightUTC());
});
