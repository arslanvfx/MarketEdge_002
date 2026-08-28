-- Dashboard 2.0 deliberately does not share legacy bot_config or bet tables.
CREATE TABLE IF NOT EXISTS dashboard2_v2_config (
  mode TEXT PRIMARY KEY CHECK (mode IN ('paper', 'live')),
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dashboard2_v2_control (
  id TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  selected_mode TEXT NOT NULL DEFAULT 'paper' CHECK (selected_mode IN ('paper', 'live')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard2_v2_ledger (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  symbol TEXT NOT NULL,
  window_key TEXT NOT NULL,
  ticker TEXT,
  side TEXT CHECK (side IN ('yes', 'no')),
  status TEXT NOT NULL,
  requested_contracts INTEGER NOT NULL DEFAULT 0,
  filled_contracts INTEGER NOT NULL DEFAULT 0,
  entry_cost NUMERIC(12,8),
  book_version TEXT,
  client_order_id TEXT UNIQUE,
  order_id TEXT,
  reconcile_reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  settled_at TIMESTAMPTZ,
  settlement_value NUMERIC(12,8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mode, symbol, window_key)
);
CREATE INDEX IF NOT EXISTS dashboard2_v2_ledger_history
  ON dashboard2_v2_ledger (mode, created_at DESC);
CREATE INDEX IF NOT EXISTS dashboard2_v2_ledger_open
  ON dashboard2_v2_ledger (mode, settled_at) WHERE filled_contracts > 0;

CREATE TABLE IF NOT EXISTS dashboard2_v2_exit_intents (
  id UUID PRIMARY KEY,
  ledger_id UUID NOT NULL REFERENCES dashboard2_v2_ledger(id),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  status TEXT NOT NULL CHECK (status IN ('reserved','filled','partial','zero_fill','unknown','blocked')),
  client_order_id TEXT NOT NULL UNIQUE,
  book_version TEXT NOT NULL,
  requested_contracts INTEGER NOT NULL,
  filled_contracts INTEGER NOT NULL DEFAULT 0,
  exit_proceeds_price NUMERIC(12,8),
  order_id TEXT,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ledger_id, book_version)
);
CREATE INDEX IF NOT EXISTS dashboard2_v2_exit_ledger ON dashboard2_v2_exit_intents (ledger_id, created_at);

CREATE TABLE IF NOT EXISTS dashboard2_v2_audit (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  mode TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dashboard2_v2_audit_created
  ON dashboard2_v2_audit (created_at DESC);