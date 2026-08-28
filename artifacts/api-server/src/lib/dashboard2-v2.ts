import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { ExecutableBook, ExecutableSellBook } from "./kalshi-orderbook-store.ts";
import { isUncertainOrderError, OrderSubmissionRevokedError, placeOrder } from "./kalshi-trader.ts";
import { hasKalshiCredentials } from "./kalshi-auth.ts";
import { dashboard2KalshiOrderbookService } from "./kalshi-orderbook-service.ts";
import { Dashboard2SafetyAuthorizationStore } from "./dashboard2-safety-authorization.ts";
import { fetchKalshiMarketResult } from "./kalshi-trader.ts";
import {
  DEFAULT_DASHBOARD2_CONFIG,
  dashboard2IocOrderFromQuote,
  dashboard2IocSellOrderFromQuote,
  dashboard2CircuitMetrics,
  dashboard2ReservationAllowed,
  isDashboard2Mode,
  parseDashboard2Config,
  type Dashboard2Config,
  type Dashboard2Mode,
} from "./dashboard2-v2-pure.ts";
import {
  dashboard2EtDayBounds,
  dashboard2EtHour,
  dashboard2FinalizedPosition,
  dashboard2RoiPct,
  dashboard2WhatIfPosition,
  DASHBOARD2_PERFORMANCE_TIME_ZONE,
} from "./dashboard2-v2-pure.ts";
import { getBalance } from "./kalshi-trader.ts";
export {
  dashboard2IocOrderFromQuote,
  dashboard2IocSellOrderFromQuote,
  dashboard2CircuitMetrics,
  dashboard2ReservationAllowed,
  isDashboard2Mode,
  parseDashboard2Config,
  type Dashboard2Config,
  type Dashboard2Mode,
} from "./dashboard2-v2-pure.ts";

/** Singleton only; tokens are memory-only, identity-bound, and one-use. */
export const dashboard2SafetyAuthorizations = new Dashboard2SafetyAuthorizationStore();

const configCache = new Map<Dashboard2Mode, Dashboard2Config>();

let migration: Promise<void> | undefined;
export function ensureDashboard2V2Tables(): Promise<void> {
  migration ??= pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard2_v2_config (mode TEXT PRIMARY KEY CHECK (mode IN ('paper','live')), config JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS dashboard2_v2_control (id TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id='singleton'), selected_mode TEXT NOT NULL DEFAULT 'paper' CHECK (selected_mode IN ('paper','live')), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS dashboard2_v2_ledger (id UUID PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('paper','live')), symbol TEXT NOT NULL, window_key TEXT NOT NULL, ticker TEXT, side TEXT CHECK (side IN ('yes','no')), status TEXT NOT NULL, requested_contracts INTEGER NOT NULL DEFAULT 0, filled_contracts INTEGER NOT NULL DEFAULT 0, entry_cost NUMERIC(12,8), book_version TEXT, client_order_id TEXT UNIQUE, order_id TEXT, reconcile_reason TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, settled_at TIMESTAMPTZ, settlement_value NUMERIC(12,8), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(mode,symbol,window_key));
    ALTER TABLE dashboard2_v2_ledger ADD COLUMN IF NOT EXISTS client_order_id TEXT;
    ALTER TABLE dashboard2_v2_ledger ADD COLUMN IF NOT EXISTS order_id TEXT;
    ALTER TABLE dashboard2_v2_ledger ADD COLUMN IF NOT EXISTS reconcile_reason TEXT;
    CREATE TABLE IF NOT EXISTS dashboard2_v2_exit_intents (
      id UUID PRIMARY KEY, ledger_id UUID NOT NULL REFERENCES dashboard2_v2_ledger(id), mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
      status TEXT NOT NULL CHECK (status IN ('reserved','filled','partial','zero_fill','unknown','blocked')),
      client_order_id TEXT NOT NULL UNIQUE, book_version TEXT NOT NULL, requested_contracts INTEGER NOT NULL,
      filled_contracts INTEGER NOT NULL DEFAULT 0, exit_proceeds_price NUMERIC(12,8), order_id TEXT, reason TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(ledger_id,book_version));
    CREATE INDEX IF NOT EXISTS dashboard2_v2_exit_ledger ON dashboard2_v2_exit_intents(ledger_id,created_at);
    CREATE TABLE IF NOT EXISTS dashboard2_v2_audit (id UUID PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, mode TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS dashboard2_v2_ledger_history ON dashboard2_v2_ledger(mode, created_at DESC);
    CREATE INDEX IF NOT EXISTS dashboard2_v2_audit_created ON dashboard2_v2_audit(created_at DESC);
  `).then(() => undefined);
  return migration;
}
export async function auditDashboard2V2(actorId: string, action: string, mode: Dashboard2Mode | null, details: object): Promise<void> {
  await ensureDashboard2V2Tables();
  await pool.query("INSERT INTO dashboard2_v2_audit(id,actor_id,action,mode,details) VALUES($1,$2,$3,$4,$5::jsonb)", [randomUUID(), actorId, action, mode, JSON.stringify(details)]);
}
export async function readDashboard2V2Config(mode: Dashboard2Mode): Promise<{ config: Dashboard2Config; updatedAt: string }> {
  await ensureDashboard2V2Tables();
  const row = await pool.query<{ config: unknown; updated_at: Date }>("SELECT config,updated_at FROM dashboard2_v2_config WHERE mode=$1", [mode]);
  if (!row.rows[0]) {
    configCache.set(mode, DEFAULT_DASHBOARD2_CONFIG);
    return { config: DEFAULT_DASHBOARD2_CONFIG, updatedAt: new Date(0).toISOString() };
  }
  const config = parseDashboard2Config(row.rows[0].config);
  configCache.set(mode, config);
  return { config, updatedAt: row.rows[0].updated_at.toISOString() };
}
export function isDashboard2V2ConfigCurrent(mode: Dashboard2Mode, expected: Dashboard2Config): boolean {
  return configCache.get(mode) === expected;
}
export async function readDashboard2V2SelectedMode(): Promise<{ selectedMode: Dashboard2Mode; updatedAt: string }> {
  await ensureDashboard2V2Tables();
  const result = await pool.query<{ selected_mode: string; updated_at: Date }>("SELECT selected_mode,updated_at FROM dashboard2_v2_control WHERE id='singleton'");
  const row = result.rows[0];
  return { selectedMode: row && isDashboard2Mode(row.selected_mode) ? row.selected_mode : "paper", updatedAt: row?.updated_at.toISOString() ?? new Date(0).toISOString() };
}
export async function selectDashboard2V2Mode(mode: Dashboard2Mode, actorId: string): Promise<{ selectedMode: Dashboard2Mode; updatedAt: string }> {
  await ensureDashboard2V2Tables();
  const client = await pool.connect();
  let result;
  try {
    await client.query("BEGIN");
    const current = await client.query<{ selected_mode: Dashboard2Mode }>("INSERT INTO dashboard2_v2_control(id) VALUES('singleton') ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING selected_mode");
    const config = await client.query<{ config: unknown }>("SELECT config FROM dashboard2_v2_config WHERE mode=$1 FOR UPDATE", [current.rows[0]?.selected_mode ?? "paper"]);
    if (config.rows[0] && parseDashboard2Config(config.rows[0].config).enabled) {
      throw Object.assign(new Error("Cannot change mode while the selected configuration is enabled; pause it first"), { code: "MODE_ACTIVE" });
    }
    result = await client.query<{ updated_at: Date }>("UPDATE dashboard2_v2_control SET selected_mode=$1,updated_at=NOW() WHERE id='singleton' RETURNING updated_at", [mode]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  await auditDashboard2V2(actorId, "mode.select", mode, {});
  return { selectedMode: mode, updatedAt: result!.rows[0]!.updated_at.toISOString() };
}
export async function dashboard2V2LiveReadiness(): Promise<{ activationReady: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  try { parseDashboard2Config((await readDashboard2V2Config("live")).config); } catch { reasons.push("invalid_live_config"); }
  if (!hasKalshiCredentials()) reasons.push("kalshi_credentials_missing");
  if (!dashboard2KalshiOrderbookService.getStatus().ready) reasons.push("orderbook_stream_not_ready");
  try {
    const pending = await pool.query<{ count: string }>(`SELECT (
      (SELECT COUNT(*) FROM dashboard2_v2_ledger WHERE mode='live' AND status IN ('reserved','unknown')) +
      (SELECT COUNT(*) FROM dashboard2_v2_exit_intents WHERE mode='live' AND status IN ('reserved','unknown'))
    )::text count`);
    if (Number(pending.rows[0]?.count ?? 0) > 0) reasons.push("unresolved_v2_live_intents");
  } catch { reasons.push("intent_ledger_unavailable"); }
  return { activationReady: reasons.length === 0, reasons };
}
export async function patchDashboard2V2Config(mode: Dashboard2Mode, patch: unknown, actorId: string): Promise<{ config: Dashboard2Config; updatedAt: string }> {
  if (mode === "live" && patch && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    throw Object.assign(new Error("Live enabled state can only be changed using live start/pause"), { code: "ACTIVATION_PATH" });
  }
  await ensureDashboard2V2Tables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ config: unknown }>("SELECT config FROM dashboard2_v2_config WHERE mode=$1 FOR UPDATE", [mode]);
    const config = parseDashboard2Config(patch, existing.rows[0] ? parseDashboard2Config(existing.rows[0].config) : DEFAULT_DASHBOARD2_CONFIG);
    const write = await client.query<{ updated_at: Date }>("INSERT INTO dashboard2_v2_config(mode,config,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(mode) DO UPDATE SET config=EXCLUDED.config,updated_at=NOW() RETURNING updated_at", [mode, JSON.stringify(config)]);
    await client.query("INSERT INTO dashboard2_v2_audit(id,actor_id,action,mode,details) VALUES($1,$2,'config.patch',$3,$4::jsonb)", [randomUUID(), actorId, mode, JSON.stringify({ patch })]);
    await client.query("COMMIT");
    configCache.set(mode, config);
    return { config, updatedAt: write.rows[0]!.updated_at.toISOString() };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

/** The sole live enable path. DB ownership/mode checks share the ownership
 * advisory lock, while readiness is checked immediately before the transaction. */
export async function startDashboard2V2Live(actorId: string): Promise<{ config: Dashboard2Config; updatedAt: string }> {
  const readiness = await dashboard2V2LiveReadiness();
  if (!readiness.activationReady) throw Object.assign(new Error("Live start requires readiness"), { code: "LIVE_NOT_READY", readiness });
  await ensureDashboard2V2Tables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["dashboard2_execution_ownership"]);
    const selected = await client.query<{ selected_mode: string }>("SELECT selected_mode FROM dashboard2_v2_control WHERE id='singleton' FOR UPDATE");
    const owner = await client.query<{ owner: string }>("SELECT config->>'owner' owner FROM bot_config WHERE id='dashboard2_execution_ownership' FOR UPDATE");
    if (selected.rows[0]?.selected_mode !== "live" || owner.rows[0]?.owner !== "dashboard2_bot") {
      throw Object.assign(new Error("Live start requires selected live mode and dashboard2_bot ownership"), { code: "LIVE_NOT_READY" });
    }
    const old = await client.query<{ config: unknown }>("SELECT config FROM dashboard2_v2_config WHERE mode='live' FOR UPDATE");
    const config = parseDashboard2Config({ enabled: true }, old.rows[0] ? parseDashboard2Config(old.rows[0].config) : DEFAULT_DASHBOARD2_CONFIG);
    const write = await client.query<{ updated_at: Date }>("INSERT INTO dashboard2_v2_config(mode,config,updated_at) VALUES('live',$1::jsonb,NOW()) ON CONFLICT(mode) DO UPDATE SET config=EXCLUDED.config,updated_at=NOW() RETURNING updated_at", [JSON.stringify(config)]);
    await client.query("INSERT INTO dashboard2_v2_audit(id,actor_id,action,mode) VALUES($1,$2,'live.start','live')", [randomUUID(), actorId]);
    await client.query("COMMIT"); configCache.set("live", config);
    return { config, updatedAt: write.rows[0]!.updated_at.toISOString() };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

export async function pauseDashboard2V2(mode: Dashboard2Mode, actorId: string): Promise<{ config: Dashboard2Config; updatedAt: string }> {
  await ensureDashboard2V2Tables();
  const current = await readDashboard2V2Config(mode);
  const config = parseDashboard2Config({ enabled: false }, current.config);
  const write = await pool.query<{ updated_at: Date }>("INSERT INTO dashboard2_v2_config(mode,config,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(mode) DO UPDATE SET config=EXCLUDED.config,updated_at=NOW() RETURNING updated_at", [mode, JSON.stringify(config)]);
  await auditDashboard2V2(actorId, "mode.pause", mode, {});
  configCache.set(mode, config);
  return { config, updatedAt: write.rows[0]!.updated_at.toISOString() };
}

/** Paper fills use only the immutable executable depth supplied by the book store. */
export async function runDashboard2PaperCandidate(input: { symbol: string; windowKey: string; quote: ExecutableBook | null; elapsedMinutes: number; config?: Dashboard2Config; authorizedCount?: number }): Promise<string> {
  const config = input.config ?? (await readDashboard2V2Config("paper")).config;
  const symbol = input.symbol.toUpperCase();
  let status = "blocked", requested = 0, filled = 0, cost: number | null = null, details: object = {};
  if (!config.enabled) details = { reason: "disabled" };
  else if (!config.enabledSymbols.includes(symbol)) details = { reason: "symbol_disabled" };
  else if (input.elapsedMinutes < config.minEntryMinute) details = { reason: "entry_window_not_open" };
  else if (!input.quote) details = { reason: "no_fresh_executable_depth" };
  else if (input.quote.sideCost < config.sideCostFloor || input.quote.sideCost > config.sideCostCeiling) details = { reason: "price_out_of_range" };
  else {
    requested = input.authorizedCount ?? Math.floor(config.maxDollarBudget / input.quote.sideCost);
    filled = Math.min(requested, input.quote.visibleContracts); cost = input.quote.sideCost;
    status = filled === 0 ? "zero_fill" : filled < requested ? "partial_fill" : "full_fill";
    details = { reason: null, bookVersion: input.quote.bookVersion, executableDepth: input.quote.visibleContracts,
      weightedSideCost: input.quote.sideCost, marginalLimitCost: input.quote.marginalLimitCost };
  }
  if (!input.quote || status === "blocked") return "blocked";
  const claim = await reserveDashboard2V2Entry({ mode: "paper", symbol, windowKey: input.windowKey, quote: input.quote, requestedContracts: requested, config });
  if (!claim) return "duplicate";
  await pool.query("UPDATE dashboard2_v2_ledger SET status=$1,filled_contracts=$2,entry_cost=$3,details=$4::jsonb,updated_at=NOW() WHERE id=$5 AND status='reserved'", [status, filled, cost, JSON.stringify(details), claim.id]);
  return claim.id;
}

/** V2-only conflict and exposure view. Unknown/reserved live intents are always
 * conflicts: an ambiguous POST is exposure until authoritative proof says so. */
export async function dashboard2V2EntryState(mode: Dashboard2Mode, symbol: string, windowKey: string): Promise<{
  conflict: boolean; exposure: number; positions: number; dailyPnl: number; consecutiveLosses: number;
}> {
  await ensureDashboard2V2Tables();
  const config = (await readDashboard2V2Config(mode)).config;
  const result = await pool.query<{ conflict: string; exposure: string; positions: string }>(
    `SELECT
      COUNT(*) FILTER (WHERE status='unknown' OR
        (symbol=$2 AND window_key=$3 AND (status='reserved' OR (filled_contracts > 0 AND settled_at IS NULL))))::text conflict,
       COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN requested_contracts*($4::numeric) ELSE filled_contracts*COALESCE(entry_cost,0) END) FILTER (WHERE settled_at IS NULL),0)::text exposure,
      COUNT(*) FILTER (WHERE settled_at IS NULL AND (status IN ('reserved','unknown') OR filled_contracts > 0))::text positions
     FROM dashboard2_v2_ledger WHERE mode=$1`, [mode, symbol.toUpperCase(), windowKey, config.sideCostCeiling],
  );
  const row = result.rows[0]!;
  const settled = await pool.query<{ settled_at: Date; pnl: string }>(
    `SELECT l.settled_at,(COALESCE(x.exit_pnl,0) + CASE
       WHEN l.filled_contracts-COALESCE(x.exited,0)>0
       THEN (l.settlement_value-COALESCE(l.entry_cost,0))*(l.filled_contracts-COALESCE(x.exited,0))
       ELSE 0 END)::text pnl
     FROM dashboard2_v2_ledger l LEFT JOIN (
       SELECT x.ledger_id,SUM(x.filled_contracts)::int exited,
         SUM((x.exit_proceeds_price-l2.entry_cost)*x.filled_contracts) exit_pnl
       FROM dashboard2_v2_exit_intents x JOIN dashboard2_v2_ledger l2 ON l2.id=x.ledger_id
       WHERE x.filled_contracts>0 GROUP BY x.ledger_id
     ) x ON x.ledger_id=l.id
     WHERE l.mode=$1 AND l.settled_at IS NOT NULL ORDER BY l.settled_at DESC`,
    [mode],
  );
  const metrics = dashboard2CircuitMetrics(settled.rows.map(r => ({ settledAt: r.settled_at, pnl: Number(r.pnl) })));
  return {
    conflict: Number(row.conflict) > 0, exposure: Number(row.exposure), positions: Number(row.positions),
    dailyPnl: metrics.dailyPnl, consecutiveLosses: metrics.consecutiveLosses,
  };
}

/** Serializes all portfolio claims for a mode. Reserved and unknown rows are
 * charged at the configured ceiling until an exact fill is durably recorded. */
export async function reserveDashboard2V2Entry(input: {
  mode: Dashboard2Mode; symbol: string; windowKey: string; quote: ExecutableBook; requestedContracts: number; config: Dashboard2Config;
}): Promise<{ id: string; clientOrderId: string } | null> {
  await ensureDashboard2V2Tables();
  const client = await pool.connect();
  const id = randomUUID(), clientOrderId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dashboard2-v2-reservation:${input.mode}`]);
    const totals = await client.query<{ duplicate: string; positions: string; exposure: string; unknown: string }>(
      `SELECT COUNT(*) FILTER (WHERE symbol=$2 AND window_key=$3)::text duplicate,
        COUNT(*) FILTER (WHERE settled_at IS NULL AND (status IN ('reserved','unknown') OR filled_contracts>0))::text positions,
         COUNT(*) FILTER (WHERE status='unknown')::text unknown,
        COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN requested_contracts*($4::numeric) ELSE filled_contracts*COALESCE(entry_cost,0) END)
          FILTER (WHERE settled_at IS NULL),0)::text exposure
       FROM dashboard2_v2_ledger WHERE mode=$1`,
      [input.mode, input.symbol.toUpperCase(), input.windowKey, input.config.sideCostCeiling],
    );
    const row = totals.rows[0]!;
    if (Number(row.unknown) > 0 || !dashboard2ReservationAllowed({ duplicate: Number(row.duplicate) > 0, openPositions: Number(row.positions), exposure: Number(row.exposure), requestedContracts: input.requestedContracts, sideCostCeiling: input.config.sideCostCeiling, maxConcurrentPositions: input.config.maxConcurrentPositions, maxTotalExposure: input.config.maxTotalExposure })) {
      await client.query("ROLLBACK"); return null;
    }
    await client.query(`INSERT INTO dashboard2_v2_ledger(id,mode,symbol,window_key,ticker,side,status,requested_contracts,book_version,client_order_id,details)
      VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9,$10::jsonb)`,
       [id, input.mode, input.symbol.toUpperCase(), input.windowKey, input.quote.ticker, input.quote.side, input.requestedContracts, input.quote.bookVersion, clientOrderId,
         JSON.stringify({ weightedSideCost: input.quote.sideCost, marginalLimitCost: input.quote.marginalLimitCost, executableDepth: input.quote.visibleContracts })]);
    await client.query("COMMIT");
    return { id, clientOrderId };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

/** No available exchange read proves identity by client_order_id/order_id.
 * Unknown exposure therefore remains blocked indefinitely. */
export async function reconcileDashboard2V2LiveUnknowns(): Promise<void> {
  await ensureDashboard2V2Tables();
  await pool.query(`UPDATE dashboard2_v2_ledger
    SET reconcile_reason=COALESCE(reconcile_reason,'identity_unprovable_no_client_or_order_lookup'),updated_at=NOW()
    WHERE mode='live' AND status='unknown' AND reconcile_reason IS NULL`);
}

export async function dashboard2V2History(mode: Dashboard2Mode, limit = 100) {
  await ensureDashboard2V2Tables();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
  const result = await pool.query(`SELECT l.*,COALESCE(x.exited,0) exited_contracts,
      COALESCE(x.exit_pnl,0) + CASE WHEN l.settled_at IS NOT NULL
          AND l.filled_contracts-COALESCE(x.exited,0)>0
        THEN (l.settlement_value-COALESCE(l.entry_cost,0))*(l.filled_contracts-COALESCE(x.exited,0)) ELSE 0 END pnl
    FROM dashboard2_v2_ledger l LEFT JOIN (
      SELECT x.ledger_id,SUM(x.filled_contracts)::int exited,
        SUM((x.exit_proceeds_price-l2.entry_cost)*x.filled_contracts) exit_pnl
      FROM dashboard2_v2_exit_intents x JOIN dashboard2_v2_ledger l2 ON l2.id=x.ledger_id
      WHERE x.filled_contracts>0 GROUP BY x.ledger_id
    ) x ON x.ledger_id=l.id
    WHERE l.mode=$1 ORDER BY l.created_at DESC LIMIT $2`, [mode, safeLimit]);
  return result.rows;
}
export async function dashboard2V2Positions(mode: Dashboard2Mode) {
  await ensureDashboard2V2Tables();
  return (await pool.query(`SELECT l.*, (l.filled_contracts-COALESCE(x.exited,0)) remaining_contracts
    FROM dashboard2_v2_ledger l LEFT JOIN (
      SELECT ledger_id,SUM(filled_contracts)::int exited FROM dashboard2_v2_exit_intents GROUP BY ledger_id
    ) x ON x.ledger_id=l.id
    WHERE l.mode=$1 AND l.settled_at IS NULL AND l.filled_contracts-COALESCE(x.exited,0)>0 ORDER BY l.created_at DESC`, [mode])).rows;
}
export async function dashboard2V2Analytics(mode: Dashboard2Mode) {
  await ensureDashboard2V2Tables();
  const row = await pool.query<{ attempts: string; fills: string; contracts: string; settled: string; pnl: string }>(
    `SELECT COUNT(*)::text attempts, COUNT(*) FILTER (WHERE filled_contracts > 0)::text fills,
      COALESCE(SUM(l.filled_contracts),0)::text contracts, COUNT(*) FILTER (WHERE l.settled_at IS NOT NULL)::text settled,
      COALESCE(SUM(COALESCE(x.exit_pnl,0) +
        CASE WHEN l.settled_at IS NOT NULL THEN (COALESCE(l.settlement_value,0)-COALESCE(l.entry_cost,0))*(l.filled_contracts-COALESCE(x.exited,0)) ELSE 0 END),0)::text pnl
     FROM dashboard2_v2_ledger l LEFT JOIN (
       SELECT ledger_id,SUM(filled_contracts)::int exited,
         SUM((x.exit_proceeds_price-l2.entry_cost)*x.filled_contracts) exit_pnl
       FROM dashboard2_v2_exit_intents x JOIN dashboard2_v2_ledger l2 ON l2.id=x.ledger_id
       WHERE x.filled_contracts>0 GROUP BY x.ledger_id
     ) x ON x.ledger_id=l.id WHERE l.mode=$1`, [mode],
  );
  return row.rows[0] ?? { attempts: "0", fills: "0", contracts: "0", settled: "0", pnl: "0" };
}

type PerformanceLedgerRow = {
  entry_cost: string | number | null; filled_contracts: number; settlement_value: string | number | null;
  settled_at: Date | string | null;
  exits: Array<{ filledContracts: number; proceeds: string | number; at: Date | string }> | null;
};

async function dashboard2PerformancePositions(mode: Dashboard2Mode) {
  await ensureDashboard2V2Tables();
  const result = await pool.query<PerformanceLedgerRow>(`SELECT l.entry_cost,l.filled_contracts,l.settlement_value,l.settled_at,
      COALESCE(json_agg(json_build_object('filledContracts',x.filled_contracts,'proceeds',x.exit_proceeds_price,'at',x.updated_at)
        ORDER BY x.updated_at) FILTER (WHERE x.filled_contracts>0), '[]'::json) exits
    FROM dashboard2_v2_ledger l LEFT JOIN dashboard2_v2_exit_intents x ON x.ledger_id=l.id
    WHERE l.mode=$1 AND l.filled_contracts>0
    GROUP BY l.id`, [mode]);
  return result.rows.flatMap(row => {
    const entryCost = Number(row.entry_cost);
    const filledContracts = Number(row.filled_contracts);
    if (!Number.isFinite(entryCost) || entryCost < 0 || !Number.isInteger(filledContracts) || filledContracts < 1) return [];
    const position = dashboard2FinalizedPosition({
      entryCost, filledContracts, settlementValue: row.settlement_value == null ? null : Number(row.settlement_value),
      settledAt: row.settled_at,
      exits: (row.exits ?? []).flatMap(exit => {
        const proceeds = Number(exit.proceeds);
        return Number.isFinite(proceeds) && Number.isInteger(exit.filledContracts) && exit.filledContracts > 0
          ? [{ filledContracts: exit.filledContracts, proceeds, at: exit.at }] : [];
      }),
    });
    return position.finalized ? [{ entryCost, ...position }] : [];
  });
}

export async function dashboard2V2DailyPerformance(mode: Dashboard2Mode, now = new Date()) {
  const bounds = dashboard2EtDayBounds(now);
  const all = await dashboard2PerformancePositions(mode);
  const today = all.filter(position => position.finalAt!.getTime() >= bounds.dayStartAt.getTime() && position.finalAt!.getTime() < bounds.nextResetAt.getTime());
  const pnl = (positions: typeof all) => positions.reduce((sum, position) => sum + position.pnl, 0);
  const todayPnl = pnl(today), allTimePnl = pnl(all);
  // Balance and outcome KPIs deliberately mirror Bot 1: they are lifetime
  // settled/finalized measures, while P&L bars remain scoped to today's ET day.
  const wins = all.filter(p => p.pnl > 0).length, losses = all.filter(p => p.pnl < 0).length, pushes = all.length - wins - losses;
  const hours = Array.from({ length: 24 }, (_, etHour) => ({ etHour, pnl: 0, bets: 0 }));
  for (const position of today) {
    const hour = dashboard2EtHour(position.finalAt!);
    hours[hour]!.pnl += position.pnl; hours[hour]!.bets++;
  }
  const config = (await readDashboard2V2Config(mode)).config;
  // Performance remains readable during a transient authenticated balance-read
  // failure; only the live balance datapoint is unavailable.
  const balance = mode === "paper"
    ? config.paperStartingBalance + allTimePnl
    : await getBalance().then(result => result.availableBalance).catch(() => null);
  return {
    mode, timeZone: DASHBOARD2_PERFORMANCE_TIME_ZONE, dayStartAt: bounds.dayStartAt.toISOString(), nextResetAt: bounds.nextResetAt.toISOString(),
    summary: { balance, balanceLabel: mode === "paper" ? "Paper balance" : "Kalshi available balance", todayPnl, allTimePnl,
      wins, losses, pushes, totalBets: all.length, winRate: wins + losses ? wins / (wins + losses) : null },
    hours,
  };
}

export async function dashboard2V2WhatIf(mode: Dashboard2Mode, stake: number, now = new Date()) {
  const bounds = dashboard2EtDayBounds(now);
  const today = (await dashboard2PerformancePositions(mode)).filter(p => p.finalAt!.getTime() >= bounds.dayStartAt.getTime() && p.finalAt!.getTime() < bounds.nextResetAt.getTime());
  const included = today.map(p => ({ ...p, sizing: dashboard2WhatIfPosition(p.entryCost, p.filledContracts, p.pnl, stake) })).filter(p => p.sizing.contracts > 0);
  const sum = (key: "actualStake" | "actualPnl" | "hypotheticalStake" | "hypotheticalPnl") => included.reduce((total, item) => total + item.sizing[key], 0);
  const actualStake = sum("actualStake"), actualPnl = sum("actualPnl"), hypotheticalStake = sum("hypotheticalStake"), hypotheticalPnl = sum("hypotheticalPnl");
  const actualRoiPct = dashboard2RoiPct(actualPnl, actualStake);
  const hypotheticalRoiPct = dashboard2RoiPct(hypotheticalPnl, hypotheticalStake);
  return { mode, timeZone: DASHBOARD2_PERFORMANCE_TIME_ZONE, dayStartAt: bounds.dayStartAt.toISOString(), nextResetAt: bounds.nextResetAt.toISOString(),
    stakePerBet: stake, includedCount: included.length, excludedCount: today.length - included.length,
    actualStake, actualPnl, actualRoiPct, hypotheticalStake, hypotheticalPnl, hypotheticalRoiPct,
    deltaPnl: hypotheticalPnl - actualPnl,
    // All ROI values are percentages, so this is their percentage-point delta,
    // not a percent change in dollar P&L.
    deltaPct: actualRoiPct == null || hypotheticalRoiPct == null ? null : hypotheticalRoiPct - actualRoiPct,
    assumptions: [
      "Only finalized Dashboard 2 positions in the current America/New_York day are included.",
      "Each position uses floor(stakePerBet / entry_cost) whole contracts; no fractional contracts are used.",
      "Fees are not modeled.",
    ],
  };
}
export async function dashboard2V2Audit(limit = 100) {
  await ensureDashboard2V2Tables();
  return (await pool.query("SELECT * FROM dashboard2_v2_audit ORDER BY created_at DESC LIMIT $1", [Math.min(Math.max(Math.floor(limit), 1), 500)])).rows;
}

export async function dashboard2V2RecentEvents(mode: Dashboard2Mode, limit = 20) {
  await ensureDashboard2V2Tables();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const result = await pool.query<{
    id: string;
    at: Date;
    type: string;
    message: string;
    severity: "info" | "success" | "warning" | "error";
  }>(
    `SELECT id, at, type, message, severity FROM (
       SELECT id::text, created_at AS at, ('entry.' || status)::text AS type,
         (UPPER(mode) || ' ' || symbol || ' ' || UPPER(COALESCE(side,'?')) || ' ' ||
          filled_contracts || '/' || requested_contracts || ' @ ' ||
          TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM TO_CHAR(COALESCE(entry_cost,0) * 100, 'FM990.0'))) ||
          'c - ' || REPLACE(status, '_', ' '))::text AS message,
         (CASE WHEN status IN ('full_fill','partial_fill') THEN 'success'
               WHEN status IN ('unknown','blocked') THEN 'warning'
               ELSE 'info' END)::text AS severity
       FROM dashboard2_v2_ledger WHERE mode=$1
       UNION ALL
       SELECT id::text, created_at AS at, action AS type,
         (UPPER(COALESCE(mode,'system')) || ' - ' || REPLACE(action, '.', ' '))::text AS message,
         'info'::text AS severity
       FROM dashboard2_v2_audit WHERE mode IS NULL OR mode=$1
     ) events ORDER BY at DESC LIMIT $2`,
    [mode, safeLimit],
  );
  return result.rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

export type Dashboard2OpenPosition = {
  id: string; mode: Dashboard2Mode; ticker: string; side: "yes" | "no";
  filledContracts: number; exitedContracts: number;
};

export async function dashboard2V2OpenPositionsForExit(): Promise<Dashboard2OpenPosition[]> {
  await ensureDashboard2V2Tables();
  const rows = await pool.query<{
    id: string; mode: Dashboard2Mode; ticker: string; side: "yes" | "no";
    filled_contracts: number; exited_contracts: number;
  }>(`SELECT l.id,l.mode,l.ticker,l.side,l.filled_contracts,
      COALESCE(SUM(x.filled_contracts),0)::int exited_contracts
    FROM dashboard2_v2_ledger l
    LEFT JOIN dashboard2_v2_exit_intents x ON x.ledger_id=l.id
    WHERE l.ticker IS NOT NULL AND l.side IS NOT NULL AND l.filled_contracts>0 AND l.settled_at IS NULL
    GROUP BY l.id HAVING l.filled_contracts-COALESCE(SUM(x.filled_contracts),0)>0`);
  return rows.rows.map(row => ({
    id: row.id, mode: row.mode, ticker: row.ticker, side: row.side,
    filledContracts: Number(row.filled_contracts), exitedContracts: Number(row.exited_contracts),
  }));
}

/** Claims one exact book version. Unknown/reserved prevents every repeat;
 * zero-fill can only be retried after a distinct version due to the unique key. */
export async function reserveDashboard2V2Exit(
  position: Dashboard2OpenPosition,
  quote: ExecutableSellBook,
  requestedContracts: number,
): Promise<{ id: string; clientOrderId: string } | null> {
  await ensureDashboard2V2Tables();
  const client = await pool.connect();
  const id = randomUUID(), clientOrderId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dashboard2-v2-exit:${position.id}`]);
    const state = await client.query<{ remaining: number; unresolved: string }>(
      `SELECT l.filled_contracts-COALESCE(SUM(x.filled_contracts),0)::int remaining,
        COUNT(*) FILTER (WHERE x.status IN ('reserved','unknown'))::text unresolved
       FROM dashboard2_v2_ledger l LEFT JOIN dashboard2_v2_exit_intents x ON x.ledger_id=l.id
       WHERE l.id=$1 AND l.settled_at IS NULL GROUP BY l.id`, [position.id]);
    const row = state.rows[0];
    if (!row || Number(row.unresolved) > 0 || requestedContracts < 1 ||
        requestedContracts > Number(row.remaining) || requestedContracts > quote.visibleContracts) {
      await client.query("ROLLBACK"); return null;
    }
    const write = await client.query(
      `INSERT INTO dashboard2_v2_exit_intents
       (id,ledger_id,mode,status,client_order_id,book_version,requested_contracts,exit_proceeds_price,details)
       VALUES($1,$2,$3,'reserved',$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(ledger_id,book_version) DO NOTHING`,
      [id, position.id, position.mode, clientOrderId, quote.bookVersion, requestedContracts,
       quote.sideProceeds, JSON.stringify({
         seq: quote.seq, updatedAt: quote.updatedAt, visibleContracts: quote.visibleContracts,
         weightedExpectedProceeds: quote.sideProceeds, marginalLimitProceeds: quote.marginalLimitProceeds,
       })]);
    if (write.rowCount !== 1) { await client.query("ROLLBACK"); return null; }
    await client.query("COMMIT");
    return { id, clientOrderId };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

export async function completeDashboard2PaperExit(
  reservationId: string, quote: ExecutableSellBook, count: number,
): Promise<void> {
  await recordConfirmedDashboard2Exit({
    reservationId, expectedMode: "paper", status: "filled", filled: count,
    proceeds: quote.sideProceeds, orderId: null,
  });
}

async function recordConfirmedDashboard2Exit(input: {
  reservationId: string; expectedMode: Dashboard2Mode;
  status: "filled" | "partial" | "zero_fill"; filled: number;
  proceeds: number; orderId: string | null;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const write = await client.query<{ ledger_id: string }>(
      `UPDATE dashboard2_v2_exit_intents
       SET status=$1,filled_contracts=$2,exit_proceeds_price=$3,order_id=$4,updated_at=NOW()
       WHERE id=$5 AND mode=$6 AND status='reserved' RETURNING ledger_id`,
      [input.status, input.filled, input.proceeds, input.orderId, input.reservationId, input.expectedMode]);
    const ledgerId = write.rows[0]?.ledger_id;
    if (!ledgerId) throw new Error("Dashboard2 exit reservation was not durably confirmed");
    // The lifecycle close and confirmed fill commit together. settled_at is the
    // single circuit-event timestamp; NULL settlement_value records an all-exit close.
    await client.query(`UPDATE dashboard2_v2_ledger l
      SET settled_at=NOW(),settlement_value=NULL,updated_at=NOW()
      WHERE l.id=$1 AND l.settled_at IS NULL
        AND l.filled_contracts <= COALESCE((
          SELECT SUM(x.filled_contracts) FROM dashboard2_v2_exit_intents x
          WHERE x.ledger_id=l.id
        ),0)`, [ledgerId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function submitDashboard2LiveExit(input: {
  position: Dashboard2OpenPosition; quote: ExecutableSellBook; count: number;
  reservation: { id: string; clientOrderId: string }; preSubmitGuard: () => boolean;
}): Promise<"filled" | "partial" | "zero_fill" | "unknown" | "blocked"> {
  const command = dashboard2IocSellOrderFromQuote(input.quote, input.count, input.reservation.clientOrderId);
  try {
    const result = await placeOrder({ ...command, preSubmitGuard: input.preSubmitGuard });
    const filled = Math.max(0, result.filledCount);
    const status = filled === 0 ? "zero_fill" : filled < input.count ? "partial" : "filled";
    const proceeds = result.avgPrice == null ? input.quote.sideProceeds
      : input.position.side === "yes" ? result.avgPrice : 1 - result.avgPrice;
    await recordConfirmedDashboard2Exit({
      reservationId: input.reservation.id, expectedMode: "live", status,
      filled, proceeds, orderId: result.orderId,
    });
    return status;
  } catch (error) {
    if (error instanceof OrderSubmissionRevokedError) {
      await pool.query("UPDATE dashboard2_v2_exit_intents SET status='blocked',reason='pre_submit_revoked',updated_at=NOW() WHERE id=$1 AND status='reserved'", [input.reservation.id]);
      return "blocked";
    }
    const reason = isUncertainOrderError(error) ? error.reason : "broker_throw";
    await pool.query("UPDATE dashboard2_v2_exit_intents SET status='unknown',reason=$1,updated_at=NOW() WHERE id=$2 AND status='reserved'", [reason, input.reservation.id]);
    return "unknown";
  }
}

/**
 * Settlement deliberately accepts an already-resolved outcome only. Callers
 * must obtain it from the existing target/live-spot path and pass null when
 * either value is stale, absent, or equal to the strike. No inferred outcome
 * may close a paper position.
 */
export async function settleDashboard2PaperWindow(symbol: string, windowKey: string, outcome: "yes" | "no" | null): Promise<boolean> {
  if (!outcome) return false;
  await ensureDashboard2V2Tables();
  const write = await pool.query(
    `UPDATE dashboard2_v2_ledger
        SET settled_at=NOW(), settlement_value=CASE WHEN side=$3 THEN 1 ELSE 0 END, updated_at=NOW()
      WHERE mode='paper' AND symbol=$1 AND window_key=$2 AND filled_contracts > 0 AND settled_at IS NULL
        AND filled_contracts > COALESCE((SELECT SUM(x.filled_contracts) FROM dashboard2_v2_exit_intents x WHERE x.ledger_id=dashboard2_v2_ledger.id),0)`,
    [symbol.toUpperCase(), windowKey, outcome],
  );
  return write.rowCount === 1;
}

/** Bounded, exchange-authoritative settlement pass for both modes.  A missing
 * ticker/result is intentionally left open; spot data is never consulted. */
export async function settleDashboard2V2PriorWindows(limit = 20): Promise<number> {
  await ensureDashboard2V2Tables();
  const candidates = await pool.query<{ ticker: string }>(
    `SELECT DISTINCT ticker FROM dashboard2_v2_ledger
      WHERE ticker IS NOT NULL AND filled_contracts>0 AND settled_at IS NULL
        AND filled_contracts > COALESCE((SELECT SUM(x.filled_contracts) FROM dashboard2_v2_exit_intents x WHERE x.ledger_id=dashboard2_v2_ledger.id),0)
        AND created_at < date_trunc('hour', NOW()) + floor(date_part('minute', NOW()) / 15) * interval '15 minutes'
      ORDER BY ticker LIMIT $1`, [Math.min(Math.max(Math.floor(limit), 1), 100)]);
  let settled = 0;
  for (const { ticker } of candidates.rows) {
    const result = await fetchKalshiMarketResult(ticker);
    if (!result.result) continue;
    const write = await pool.query(
      `UPDATE dashboard2_v2_ledger SET settled_at=NOW(),settlement_value=CASE WHEN side=$2 THEN 1 ELSE 0 END,updated_at=NOW()
       WHERE ticker=$1 AND filled_contracts>0 AND settled_at IS NULL
         AND filled_contracts > COALESCE((SELECT SUM(x.filled_contracts) FROM dashboard2_v2_exit_intents x WHERE x.ledger_id=dashboard2_v2_ledger.id),0)`,
      [ticker, result.result]);
    settled += write.rowCount ?? 0;
  }
  return settled;
}

/**
 * Live submit boundary. The caller supplies fresh full safety evidence as a
 * synchronous guard; this method persists the one-use client id first, calls
 * placeOrder exactly once, and keeps every throw as UNKNOWN exposure.
 */
export async function submitDashboard2LiveIoc(input: {
  symbol: string; windowKey: string; quote: ExecutableBook; count: number;
  owner: string; activationReady: boolean; preSubmitGuard: () => boolean; reservation: { id: string; clientOrderId: string };
}): Promise<"filled" | "partial_fill" | "zero_fill" | "unknown" | "blocked"> {
  const config = (await readDashboard2V2Config("live")).config;
  if (!config.enabled || !input.activationReady || input.owner !== "dashboard2_bot") {
    await pool.query("UPDATE dashboard2_v2_ledger SET status='blocked',reconcile_reason='pre_submit_not_eligible',updated_at=NOW() WHERE id=$1 AND status='reserved'", [input.reservation.id]);
    return "blocked";
  }
  const clientOrderId = input.reservation.clientOrderId;
  const command = dashboard2IocOrderFromQuote(input.quote, input.count, clientOrderId);
  try {
    // The guard is checked a second time by placeOrder immediately before its
    // single POST, so stale ownership/book/auth cannot submit.
    const result = await placeOrder({ ...command, preSubmitGuard: input.preSubmitGuard });
    const filled = Math.max(0, result.filledCount);
    const status = filled === 0 ? "zero_fill" : filled < input.count ? "partial_fill" : "filled";
    await pool.query("UPDATE dashboard2_v2_ledger SET status=$1,filled_contracts=$2,entry_cost=$3,order_id=$4,updated_at=NOW() WHERE client_order_id=$5", [status, filled, result.avgPrice, result.orderId, clientOrderId]);
    return status;
  } catch (error) {
    if (error instanceof OrderSubmissionRevokedError) {
      await pool.query("UPDATE dashboard2_v2_ledger SET status='blocked',reconcile_reason='pre_submit_revoked',updated_at=NOW() WHERE client_order_id=$1", [clientOrderId]);
      return "blocked";
    }
    // A revoked guard, timeout, malformed response, or transport exception can
    // all leave exposure ambiguous. Never retry this client order id.
    const reason = isUncertainOrderError(error) ? error.reason : "broker_throw";
    await pool.query("UPDATE dashboard2_v2_ledger SET status='unknown',reconcile_reason=$1,updated_at=NOW() WHERE client_order_id=$2", [reason, clientOrderId]);
    return "unknown";
  }
}