import app from "./app";
import { logger } from "./lib/logger";
import { fetchAllMarkets } from "./lib/markets";
import { startPredictionTracker, fetchCryptoPredictions } from "./lib/crypto";
import { runThresholdAnalysis, formatThresholdReport } from "./lib/backtest";
import { runMLBackfillIfNeeded } from "./lib/ml-backfill";
import { runBotLoopTick, runWindowOpenPrefetch, loadBotConfigFromDB, loadDailyPnlFromDB, loadCoinDailyLossFromDB, loadCoinStreakStateFromDB, loadOpenPositionFromDB, loadPaperBalanceFromDB, loadWindowBetCountsFromDB, getBotState, runAutoTuneJob, fixLiveExpiredPnlHistorical, reEvaluateSettledBets } from "./lib/kalshi-bot";
import { pool, startPoolPinger } from "@workspace/db";
import { loadConfigFromDB as loadStockConfig } from "./lib/stock/config";
import { initStockMLFromDB } from "./lib/stock/ml";
import { runScan as runStockScan, initLastScanAt, lastScanTime } from "./lib/stock/scanner";
import { runStockNewsCheck } from "./lib/stock/bot";
import { initResearchFromDB } from "./lib/stock/research";
import { runBotCycle as runStockBotCycle, initDecisionLogFromDB } from "./lib/stock/bot";
import { alpacaConfigured } from "./lib/stock/alpaca";
import { initAiSpend } from "./lib/ai-spend";

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
    // Direct binary ABOVE/BELOW from fetchLiveDirection, recorded at the
    // initial "stat snap ready" trigger.  Used as the authoritative AT OPEN
    // call for Claude/ensemble accuracy evaluation — avoids the
    // price-prediction-to-binary boundary rounding error near the strike.
    await client.query(`
      ALTER TABLE prediction_records
        ADD COLUMN IF NOT EXISTS live_direction_above BOOLEAN
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
    // Per-symbol intra-window timing snapshots — records price-vs-strike
    // direction at 1,3,6,9,12-minute marks so we can measure when the call
    // reliably "locks in" to the final outcome for each coin.
    await client.query(`
      CREATE TABLE IF NOT EXISTS window_timing_snapshots (
        id                 TEXT PRIMARY KEY,
        symbol             TEXT NOT NULL,
        window_key         TEXT NOT NULL,
        target_time        TIMESTAMPTZ NOT NULL,
        minute_mark        INTEGER NOT NULL,
        price_above        BOOLEAN,
        kalshi_target      NUMERIC(16,6),
        current_price      NUMERIC(16,6),
        kalshi_yes_price   NUMERIC(8,4),
        stat_above         BOOLEAN,
        ensemble_above     BOOLEAN,
        actual_above       BOOLEAN,
        correct            BOOLEAN,
        evaluated_at       TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS wts_symbol_window
        ON window_timing_snapshots (symbol, window_key)
    `);
    // Bot entry timing snapshots — composite ML Gate direction at each minute (0–14)
    // for all active coins, tagged with the final window outcome so we can compute
    // per-minute accuracy and return-ratio curves.
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_entry_timing_snapshots (
        id                   TEXT PRIMARY KEY,
        coin                 TEXT NOT NULL,
        window_key           TEXT NOT NULL,
        minute_mark          INTEGER NOT NULL,
        mode                 TEXT NOT NULL,
        stat_above           BOOLEAN,
        claude_above         BOOLEAN,
        ml_above             BOOLEAN,
        composite_direction  BOOLEAN,
        composite_confidence REAL,
        yes_price            REAL,
        final_result         BOOLEAN,
        composite_correct    BOOLEAN,
        evaluated_at         TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS bets_coin_window
        ON bot_entry_timing_snapshots (coin, window_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS bets_evaluated_at
        ON bot_entry_timing_snapshots (evaluated_at)
    `);
    // Kalshi auto-betting bot bets log table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_bot_bets (
        id                       TEXT PRIMARY KEY,
        symbol                   TEXT NOT NULL,
        window_key               TEXT NOT NULL,
        ticker                   TEXT,
        direction                TEXT,
        action                   TEXT NOT NULL,
        mode                     TEXT NOT NULL,
        signals                  JSONB,
        entry_price              NUMERIC(8,4),
        exit_price               NUMERIC(8,4),
        contract_count           INTEGER,
        bet_amount               NUMERIC(10,4),
        pnl                      NUMERIC(10,4),
        exit_reason              TEXT,
        phase2_activated         BOOLEAN DEFAULT FALSE,
        phase2_recovered_amount  NUMERIC(10,4),
        outcome                  TEXT,
        kalshi_target            NUMERIC(16,6),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        exited_at                TIMESTAMPTZ,
        evaluated_at             TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS kbb_symbol_created
        ON kalshi_bot_bets (symbol, created_at DESC)
    `);
    // Single-row bot config store — survives server restarts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        id          TEXT PRIMARY KEY,
        config      JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Add crypto_price columns to kalshi_bot_bets if not yet present
    // (added after the table was first created; idempotent).
    await client.query(`
      ALTER TABLE kalshi_bot_bets
        ADD COLUMN IF NOT EXISTS crypto_price_at_entry NUMERIC(16,2),
        ADD COLUMN IF NOT EXISTS crypto_price_at_exit  NUMERIC(16,2)
    `);
    // Soft-archive column: allows clearing display history without deleting
    // rows the bot needs for operational queries (momentum seeding, border guard).
    await client.query(`
      ALTER TABLE kalshi_bot_bets
        ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
    `);
    // Auto-tune mutation log: records every parameter change applied by the
    // self-learning performance analytics job.
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_auto_tune_log (
        id             SERIAL PRIMARY KEY,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rule_name      TEXT NOT NULL,
        old_value      TEXT,
        new_value      TEXT,
        trigger_reason TEXT NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS bat_log_created
        ON bot_auto_tune_log (created_at DESC)
    `);
    // Source column: "bot" for automated bets, "manual" for dashboard-placed orders.
    // Historical rows (null) are treated as "bot" in the UI.
    await client.query(`
      ALTER TABLE kalshi_bot_bets
        ADD COLUMN IF NOT EXISTS source TEXT
    `);
    // Decision mode per bet: "classic" | "ml_gate" | "consensus" | "ml_primary".
    await client.query(`
      ALTER TABLE kalshi_bot_bets
        ADD COLUMN IF NOT EXISTS decision_mode TEXT
    `);
    // Max-bet flag: true when the stability gate + probability roll upgraded the bet.
    await client.query(`
      ALTER TABLE kalshi_bot_bets
        ADD COLUMN IF NOT EXISTS is_max_bet BOOLEAN DEFAULT FALSE
    `);
  } finally {
    client.release();
  }
}

// Stock trading vertical tables. Entirely separate from the crypto/Kalshi
// tables above — different prefixes (stock_*), different ML feature length, so
// the two systems can never contaminate each other. Idempotent.
async function runStockMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_watchlist (
        ticker       TEXT PRIMARY KEY,
        company_name TEXT,
        sector       TEXT,
        added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_bot_config (
        id         TEXT PRIMARY KEY,
        config     JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_bot_bets (
        id              TEXT PRIMARY KEY,
        ticker          TEXT NOT NULL,
        sector          TEXT,
        action          TEXT NOT NULL,
        trading_mode    TEXT NOT NULL,
        mode            TEXT NOT NULL,
        side            TEXT NOT NULL DEFAULT 'long',
        qty             NUMERIC(14,4),
        signals         JSONB,
        confidence      NUMERIC(6,2),
        entry_price     NUMERIC(14,4),
        exit_price      NUMERIC(14,4),
        stop_loss       NUMERIC(14,4),
        target_price    NUMERIC(14,4),
        notional        NUMERIC(16,4),
        pnl             NUMERIC(16,4),
        exit_reason     TEXT,
        outcome         TEXT,
        alpaca_order_id TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        exited_at       TIMESTAMPTZ,
        evaluated_at    TIMESTAMPTZ,
        archived_at     TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS stock_bot_bets_open
        ON stock_bot_bets (mode, exited_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_scanner_results (
        ticker         TEXT PRIMARY KEY,
        company_name   TEXT,
        sector         TEXT NOT NULL,
        price          NUMERIC(14,4),
        change_pct     NUMERIC(8,4),
        score          NUMERIC(8,4) NOT NULL,
        direction      TEXT,
        confidence     NUMERIC(6,2),
        news_sentiment TEXT,
        earnings_soon  BOOLEAN DEFAULT FALSE,
        details        JSONB,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_news_cache (
        id              TEXT PRIMARY KEY,
        ticker          TEXT NOT NULL,
        headline        TEXT NOT NULL,
        summary         TEXT,
        url             TEXT,
        source          TEXT,
        sentiment       TEXT,
        magnitude       INTEGER,
        sentiment_score NUMERIC(6,3),
        published_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS stock_news_ticker
        ON stock_news_cache (ticker, published_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_ml_snapshots (
        id          SERIAL PRIMARY KEY,
        ticker      TEXT NOT NULL,
        ref_id      TEXT NOT NULL,
        snapshot_at TIMESTAMPTZ NOT NULL,
        features    JSONB NOT NULL,
        outcome     SMALLINT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS stock_ml_snap_ticker
        ON stock_ml_snapshots (ticker, snapshot_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_research_reports (
        id              SERIAL PRIMARY KEY,
        ticker          TEXT NOT NULL,
        company_name    TEXT,
        sector          TEXT,
        horizon         TEXT NOT NULL,
        confidence      NUMERIC(6,2) NOT NULL,
        summary         TEXT,
        factors_json    JSONB,
        price           NUMERIC(14,4),
        web_search_used BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS stock_research_ticker
        ON stock_research_reports (ticker, created_at DESC)
    `);
    await client.query(`
      ALTER TABLE stock_research_reports ADD COLUMN IF NOT EXISTS stance TEXT
    `);
    await client.query(`
      ALTER TABLE stock_research_reports ADD COLUMN IF NOT EXISTS valuation TEXT
    `);
    await client.query(`
      ALTER TABLE stock_bot_bets ADD COLUMN IF NOT EXISTS peak_price NUMERIC(14,4)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_bot_decisions (
        id         SERIAL PRIMARY KEY,
        ticker     TEXT NOT NULL,
        action     TEXT NOT NULL,
        horizon    TEXT,
        confidence NUMERIC(6,2),
        reason     TEXT NOT NULL,
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS stock_bot_decisions_ts
        ON stock_bot_decisions (ts DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_ml_model_state (
        ticker           TEXT PRIMARY KEY,
        weights          JSONB NOT NULL,
        training_samples INTEGER NOT NULL DEFAULT 0,
        labeled_samples  INTEGER NOT NULL DEFAULT 0,
        last_trained_at  TIMESTAMPTZ NOT NULL,
        val_accuracy     NUMERIC(6,4),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

// Bring up the stock trading vertical: migrate tables, hydrate ML + config, and
// start the market-hours-gated scanner and bot loops. Runs independently of the
// crypto tracker so a failure here never affects the crypto side.
async function startStockVertical(): Promise<void> {
  await runStockMigrations();
  await loadStockConfig().catch((err) =>
    logger.warn({ err }, "[stock] config load failed (non-fatal)"),
  );
  await initStockMLFromDB().catch((err) =>
    logger.warn({ err }, "[stock-ml] init failed (non-fatal)"),
  );
  // Hydrate the decision feed before the Alpaca gate so the dashboard shows
  // history even when broker keys are missing.
  await initDecisionLogFromDB().catch((err) =>
    logger.warn({ err }, "[stock-bot] decision log hydrate failed (non-fatal)"),
  );

  if (!alpacaConfigured()) {
    logger.info("[stock] Alpaca not configured — scanner/bot idle until keys are set");
    return;
  }

  // Restore lastScanAt from DB so the UI shows the existing results immediately.
  await initLastScanAt();
  // Restore today's research reports so the bot can read them right away.
  await initResearchFromDB();

  const scan = () =>
    runStockScan().catch((err) => logger.warn({ err }, "[stock-scanner] scan failed (non-fatal)"));
  const forceScan = () =>
    runStockScan({ force: true }).catch((err) => logger.warn({ err }, "[stock-scanner] scan failed (non-fatal)"));

  // Only redo the full startup scan if results are stale (>30 min old).
  // If we just republished and DB has fresh results from this session, skip the
  // recompute — the scanner/research data already survives across restarts in DB.
  const lastScan = lastScanTime();
  const SCAN_FRESH_MS = 30 * 60_000;
  if (!lastScan || Date.now() - lastScan > SCAN_FRESH_MS) {
    logger.info("[stock] startup: results stale or absent — running force scan");
    forceScan();
  } else {
    logger.info("[stock] startup: results fresh (last scan %s ago) — skipping force scan",
      `${Math.round((Date.now() - lastScan) / 60_000)}min`);
  }

  // Auto-scan every 15 min during market hours (pre-market window included).
  setInterval(scan, 15 * 60_000);

  // News monitor: poll Alpaca news for open positions every 5 min during market hours.
  // Results are consumed per-position inside managePositions via consumeNewsAlert().
  setInterval(() => {
    runStockNewsCheck().catch((err) =>
      logger.warn({ err }, "[stock-news] news check failed (non-fatal)"),
    );
  }, 5 * 60_000);

  setInterval(() => {
    runStockBotCycle().catch((err) =>
      logger.warn({ err }, "[stock-bot] cycle failed (non-fatal)"),
    );
  }, 60_000);

  logger.info("[stock] vertical started (scanner + bot loops active)");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the pool keep-alive pinger immediately so idle connections
  // never go stale between the periodic DB activity bursts.
  startPoolPinger();

  // Pre-warm the market cache so the first user request is instant.
  fetchAllMarkets()
    .then((markets) => logger.info({ count: markets.length }, "Market cache warmed"))
    .catch((err) => logger.warn({ err }, "Market cache warm-up failed (non-fatal)"));

  // Apply additive schema migrations FIRST, then start the prediction tracker.
  // The tracker's initHistoryFromDB queries every column in prediction_records
  // (including live_direction_above) so it must run after ALTER TABLE completes.
  runStartupMigrations()
    .catch((err) => {
      logger.warn({ err }, "Startup migrations failed (non-fatal)");
    })
    .then(async () => {
      // Load persisted bot state before the loop starts so restarts are seamless:
      // 1. config + mode from bot_config table
      // 2. daily P&L reconstructed from today's kalshi_bot_bets rows
      // 3. open position restored if its window is still active
      await initAiSpend().catch((err) =>
        logger.warn({ err }, "[ai-spend] level load failed (non-fatal)"),
      );
      await loadBotConfigFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] config load failed (non-fatal)"),
      );
      await loadDailyPnlFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] daily P&L load failed (non-fatal)"),
      );
      await loadCoinDailyLossFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] per-coin daily loss load failed (non-fatal)"),
      );
      await loadCoinStreakStateFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] coinStreakState load failed (non-fatal)"),
      );
      await loadPaperBalanceFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] paper balance load failed (non-fatal)"),
      );
      await loadOpenPositionFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] open position restore failed (non-fatal)"),
      );
      await loadWindowBetCountsFromDB().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] window bet counts restore failed (non-fatal)"),
      );
      await fixLiveExpiredPnlHistorical().catch((err) =>
        logger.warn({ err }, "[kalshi-bot] historical P&L fix failed (non-fatal)"),
      );

      // Re-evaluate all historical expired bets against Kalshi's authoritative
      // settlement result (RTI).  Corrects any bets that were mis-evaluated
      // using Coinbase candle close prices, which can differ from Kalshi's RTI
      // settlement at the boundary.  Fire-and-forget — non-blocking.
      reEvaluateSettledBets()
        .then((r) => {
          if (r.corrected > 0) {
            logger.warn(
              { checked: r.checked, corrected: r.corrected, details: r.details },
              "[kalshi-bot] startup re-evaluation: CORRECTED mis-evaluated bets",
            );
          } else {
            logger.info(
              { checked: r.checked },
              "[kalshi-bot] startup re-evaluation: all historical bets verified correct",
            );
          }
        })
        .catch((err) => logger.warn({ err }, "[kalshi-bot] startup re-evaluation failed (non-fatal)"));

      // Single consolidated summary so operators can confirm state at a glance.
      const s = getBotState();
      logger.info(
        {
          mode: s.mode,
          dailyPnl: s.dailyPnl,
          dailyLossCount: s.dailyLossCount,
          openPositions: s.openPositions.map(p => ({ symbol: p.symbol, windowKey: p.windowKey, direction: p.direction })),
        },
        "[kalshi-bot] startup state restored",
      );

      // Start the prediction accuracy tracker: snaps model predictions at each
      // 15-min boundary and evaluates them against actual prices once the window closes.
      // The onInitComplete callback runs after initMLFromDB() resolves — backfill
      // runs at that point so it sees the true post-hydration warming status.
      startPredictionTracker(
        () => {
          runMLBackfillIfNeeded(96)
            .catch((err) => logger.warn({ err }, "[ml-backfill] startup backfill failed (non-fatal)"));
          // Second pre-warm pass once ML is ready: by now the stat model has
          // run at least one snap, so this call gets Claude + stat into predCache
          // together before the first bot tick that needs all three signals.
          fetchCryptoPredictions()
            .then(() => logger.info("[startup] prediction cache warmed (post-ML-init pass)"))
            .catch((err) => logger.warn({ err }, "[startup] post-ML-init pre-warm failed (non-fatal)"));
        },
        (windowKey) => {
          // Tracker fires onNewWindow before the bot loop detects the boundary,
          // giving the prefetch a head-start of up to 30s (the bot-loop phase gap).
          runWindowOpenPrefetch(windowKey).catch(() => {});
        },
        // onMLRetrySuccess — called when initMLFromDB eventually succeeds on a
        // background retry (e.g. DB was not ready at startup). Triggers the same
        // backfill check that onInitComplete would have run on a clean start.
        () => {
          runMLBackfillIfNeeded(96)
            .catch((err) => logger.warn({ err }, "[ml-backfill] post-retry backfill failed (non-fatal)"));
        },
      );
      logger.info("Prediction tracker started");

      // Immediate pre-warm: populate predCache for all coins right away so the
      // bot's first tick (fires 2 s from now) finds stat predictions ready.
      // This runs in parallel with initMLFromDB — it only needs candles/stats,
      // not ML state, so the order doesn't matter.
      fetchCryptoPredictions()
        .then(() => logger.info("[startup] prediction cache pre-warmed (immediate pass)"))
        .catch((err) => logger.warn({ err }, "[startup] immediate pre-warm failed (non-fatal)"));

      // Kalshi bot loop — runs every 15 s alongside the main tracker.
      // Reduced from 30 s: the prefetch pipeline now fires an immediate tick
      // on window-open, so the scheduler is mainly a re-evaluation safety net
      // for mid-window scenarios (failed guards, retry candidates).
      // Reads from the cached state that the main tracker populates, so no
      // extra network calls are made when the caches are warm.
      setInterval(() => {
        runBotLoopTick().catch((err) =>
          logger.warn({ err }, "[kalshi-bot] loop tick failed (non-fatal)"),
        );
      }, 2_000);

      // Auto-tune performance analytics: runs every 15 min, aligned to UTC
      // 15-minute window boundaries (00, 15, 30, 45) so the analytics window
      // matches the same cadence as the Kalshi bet windows.
      const msToNext15MinBoundary = (): number => {
        const now = Date.now();
        const boundary = Math.ceil((now + 1) / (15 * 60_000)) * (15 * 60_000);
        return Math.max(5_000, boundary - now); // at least 5s
      };
      const runAutoTune = () =>
        runAutoTuneJob().catch((err) =>
          logger.warn({ err }, "[auto-tune] scheduled job failed (non-fatal)"),
        );
      setTimeout(() => {
        runAutoTune();
        setInterval(runAutoTune, 15 * 60_000);
      }, msToNext15MinBoundary());

      // Bring up the stock trading vertical independently — a failure here must
      // never take down the crypto tracker or Kalshi bot above.
      startStockVertical().catch((err) =>
        logger.warn({ err }, "[stock] vertical startup failed (non-fatal)"),
      );
    });

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

  // Self-ping keepalive: prevents autoscale deployments from scaling to zero
  // when there is no active browser traffic (which would kill the bot loop).
  // Only runs in production; pings the healthcheck endpoint every 4 minutes.
  if (process.env["NODE_ENV"] === "production") {
    const appUrl = process.env["REPLIT_APP_URL"] ?? "https://market-combo-analyzer.replit.app";
    const pingUrl = `${appUrl}/api/healthz`;
    setInterval(() => {
      fetch(pingUrl)
        .then(() => logger.debug("[keepalive] self-ping ok"))
        .catch((err) => logger.warn({ err }, "[keepalive] self-ping failed (non-fatal)"));
    }, 4 * 60_000);
    logger.info({ pingUrl }, "[keepalive] self-ping started (4-min interval)");
  }
});
