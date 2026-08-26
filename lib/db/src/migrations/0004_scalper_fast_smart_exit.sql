-- Dedicated High-Value Scalper Smart Exit ledger.
-- This migration is additive and does not alter regular bot or Contrarian tables.

CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_config (
  id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_lifecycles (
  id TEXT PRIMARY KEY,
  scalp_order_id TEXT NOT NULL REFERENCES kalshi_scalp_orders(id),
  mode TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ticker TEXT NOT NULL,
  window_key TEXT NOT NULL,
  side TEXT NOT NULL,
  remaining_quantity NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL,
  trigger_reason TEXT,
  evidence JSONB,
  executable_quantity NUMERIC(12,2),
  executable_price NUMERIC(12,8),
  exit_fill_quantity NUMERIC(12,2),
  exit_winning_price NUMERIC(12,8),
  proceeds NUMERIC(16,8),
  exit_pnl NUMERIC(16,8),
  entry_winning_price NUMERIC(12,8),
  entry_stake NUMERIC(16,8),
  settlement_result TEXT,
  hold_value NUMERIC(16,8),
  hold_pnl NUMERIC(16,8),
  value_saved NUMERIC(16,8),
  verdict TEXT,
  sold_at TIMESTAMPTZ,
  config_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT ck_scalper_exit_lifecycle_mode
    CHECK (mode IN ('shadow','paper-exit','live-exit')),
  CONSTRAINT ck_scalper_exit_lifecycle_side
    CHECK (side IN ('yes','no')),
  CONSTRAINT ck_scalper_exit_lifecycle_quantity
    CHECK (remaining_quantity > 0),
  CONSTRAINT ck_scalper_exit_lifecycle_prices
    CHECK (
      (executable_price IS NULL OR executable_price > 0 AND executable_price < 1)
      AND (exit_winning_price IS NULL OR exit_winning_price > 0 AND exit_winning_price < 1)
      AND (entry_winning_price IS NULL OR entry_winning_price > 0 AND entry_winning_price < 1)
    )
);

CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_requests (
  id TEXT PRIMARY KEY,
  lifecycle_id TEXT NOT NULL REFERENCES kalshi_scalper_exit_lifecycles(id),
  attempt_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  reason TEXT,
  exchange_order_id TEXT,
  fill_quantity NUMERIC(12,2),
  winning_price NUMERIC(12,8),
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT ck_scalper_exit_request_attempt CHECK (attempt_no BETWEEN 1 AND 2),
  CONSTRAINT ck_scalper_exit_request_status
    CHECK (status IN ('requested','unknown','filled','partial','zero_fill','blocked')),
  CONSTRAINT ck_scalper_exit_request_fill
    CHECK (
      (fill_quantity IS NULL OR fill_quantity >= 0)
      AND (winning_price IS NULL OR winning_price > 0 AND winning_price < 1)
    ),
  CONSTRAINT uq_scalper_exit_request_attempt UNIQUE (lifecycle_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_evaluations (
  id TEXT PRIMARY KEY,
  scalp_order_id TEXT NOT NULL REFERENCES kalshi_scalp_orders(id),
  mode TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ticker TEXT NOT NULL,
  window_key TEXT NOT NULL,
  side TEXT NOT NULL,
  remaining_quantity NUMERIC(12,2) NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_scalper_exit_evaluation_side CHECK (side IN ('yes','no')),
  CONSTRAINT ck_scalper_exit_evaluation_quantity CHECK (remaining_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scalper_exit_active_owner
  ON kalshi_scalper_exit_lifecycles (scalp_order_id)
  WHERE status IN ('requested','unknown');

CREATE UNIQUE INDEX IF NOT EXISTS uq_scalper_exit_advisory_identity
  ON kalshi_scalper_exit_lifecycles
    (scalp_order_id, mode, ticker, side, remaining_quantity)
  WHERE status='advisory';

CREATE INDEX IF NOT EXISTS scalper_exit_request_pending
  ON kalshi_scalper_exit_requests (status, created_at)
  WHERE status IN ('requested','unknown');

CREATE INDEX IF NOT EXISTS scalper_exit_eval_order_created
  ON kalshi_scalper_exit_evaluations (scalp_order_id, created_at ASC);