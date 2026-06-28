import app from "./app";
import { logger } from "./lib/logger";
import { fetchAllMarkets } from "./lib/markets";
import { startPredictionTracker } from "./lib/crypto";
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
  startPredictionTracker();
  logger.info("Prediction tracker started");
});
