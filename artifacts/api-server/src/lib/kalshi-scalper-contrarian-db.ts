// Isolated, durable persistence for the contrarian experiment.  This module
// never writes normal-scalper tables (apart from the read-only conflict check).
import crypto from "crypto";
import { pool } from "@workspace/db";
import {
  DEFAULT_CONTRARIAN_CONFIG,
  type ContrarianConfig,
  type ContrarianMode,
  type ContrarianSide,
} from "./kalshi-scalper-contrarian.ts";

export type ContrarianReservationStatus = "claimed" | "released" | "filled" | "unknown" | "settled";
export type ContrarianOrderStatus = "submitting" | "zero_fill" | "filled" | "unknown" | "settled";
export interface ContrarianConfigRecord { config: ContrarianConfig; updatedAt: Date; version: number; }
export interface ContrarianObservation {
  id: string; executionMode: ContrarianMode; sourceMode: ContrarianMode; symbol: string; windowKey: string;
  ticker: string; protectedSide: ContrarianSide; oppositeSide: ContrarianSide; eligible: boolean; reason: string;
  evidence: Record<string, unknown>; yesAsk: number | null; noAsk: number | null; directAsk: number | null; createdAt: Date;
}
export interface ContrarianReservation {
  id: string; executionMode: ContrarianMode; sourceMode: ContrarianMode; symbol: string; windowKey: string; ticker: string;
  reservedBudget: number; status: ContrarianReservationStatus; reason: string | null; createdAt: Date; updatedAt: Date;
}
export interface ContrarianOrder {
  id: string; reservationId: string; executionMode: ContrarianMode; sourceMode: ContrarianMode; symbol: string; windowKey: string;
  ticker: string; protectedSide: ContrarianSide; oppositeSide: ContrarianSide; contractCount: number; yesLimitPrice: number;
  directAsk: number; yesAsk: number | null; noAsk: number | null; clientOrderId: string; status: ContrarianOrderStatus;
  exchangeOrderId: string | null; filledCount: number; avgYesFillPrice: number | null; budgetSpent: number;
  settlementResult: ContrarianSide | null; outcome: "win" | "loss" | null; pnl: number | null;
  evidence: Record<string, unknown>; reconciliationEvidence: Record<string, unknown> | null;
  createdAt: Date; updatedAt: Date; reconciledAt: Date | null; settledAt: Date | null;
}
export interface ContrarianIncident {
  id: string; orderId: string | null; reservationId: string | null; executionMode: ContrarianMode; symbol: string;
  windowKey: string; ticker: string; reason: string; evidence: Record<string, unknown>; resolvedAt: Date | null; createdAt: Date;
}
export interface ContrarianClaimInput {
  executionMode: ContrarianMode; sourceMode: ContrarianMode; symbol: string; windowKey: string; ticker: string;
  requestedBudget: number; dailyCap: number; openCap: number; perWindowCap: number; reason?: string;
}
export type ContrarianClaimResult =
  | { claimed: true; reservation: ContrarianReservation; dailyCommitted: number; openCommitted: number; windowCommitted: number }
  | { claimed: false; reason: string; reservation: ContrarianReservation | null; dailyCommitted: number; openCommitted: number; windowCommitted: number };
export interface ContrarianOrderIntentInput {
  reservationId: string; executionMode: ContrarianMode; sourceMode: ContrarianMode; symbol: string; windowKey: string; ticker: string;
  protectedSide: ContrarianSide; oppositeSide: ContrarianSide; contractCount: number; yesLimitPrice: number; directAsk: number;
  yesAsk?: number | null; noAsk?: number | null; clientOrderId: string; evidence: Record<string, unknown>;
}
export interface ContrarianFinalizeInput {
  orderId: string; exchangeOrderId?: string | null; filledCount?: number; avgYesFillPrice?: number | null; budgetSpent?: number;
  evidence?: Record<string, unknown>; reason?: string;
}
type DbRow = Record<string, unknown>;
const n = (value: unknown, field: string): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`invalid numeric database value: ${field}`);
  return result;
};
const d = (value: unknown, field: string): Date => {
  const result = new Date(String(value));
  if (Number.isNaN(result.valueOf())) throw new Error(`invalid date database value: ${field}`);
  return result;
};
const json = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reservationRow = (r: DbRow): ContrarianReservation => ({
  id: String(r.id), executionMode: r.execution_mode as ContrarianMode, sourceMode: r.source_mode as ContrarianMode,
  symbol: String(r.symbol), windowKey: String(r.window_key), ticker: String(r.ticker), reservedBudget: n(r.reserved_budget, "reserved_budget"),
  status: r.status as ContrarianReservationStatus, reason: r.reason == null ? null : String(r.reason), createdAt: d(r.created_at, "created_at"), updatedAt: d(r.updated_at, "updated_at"),
});
const orderRow = (r: DbRow): ContrarianOrder => ({
  id: String(r.id), reservationId: String(r.reservation_id), executionMode: r.execution_mode as ContrarianMode, sourceMode: r.source_mode as ContrarianMode,
  symbol: String(r.symbol), windowKey: String(r.window_key), ticker: String(r.ticker), protectedSide: r.protected_side as ContrarianSide, oppositeSide: r.opposite_side as ContrarianSide,
  contractCount: n(r.contract_count, "contract_count"), yesLimitPrice: n(r.yes_limit_price, "yes_limit_price"), directAsk: n(r.direct_ask, "direct_ask"),
  yesAsk: r.yes_ask == null ? null : n(r.yes_ask, "yes_ask"), noAsk: r.no_ask == null ? null : n(r.no_ask, "no_ask"), clientOrderId: String(r.client_order_id),
  status: r.status as ContrarianOrderStatus, exchangeOrderId: r.exchange_order_id == null ? null : String(r.exchange_order_id), filledCount: n(r.filled_count, "filled_count"),
  avgYesFillPrice: r.avg_yes_fill_price == null ? null : n(r.avg_yes_fill_price, "avg_yes_fill_price"), budgetSpent: n(r.budget_spent, "budget_spent"),
  settlementResult: r.settlement_result as ContrarianSide | null, outcome: r.outcome as "win" | "loss" | null, pnl: r.pnl == null ? null : n(r.pnl, "pnl"),
  evidence: json(r.evidence), reconciliationEvidence: r.reconciliation_evidence == null ? null : json(r.reconciliation_evidence),
  createdAt: d(r.created_at, "created_at"), updatedAt: d(r.updated_at, "updated_at"), reconciledAt: r.reconciled_at == null ? null : d(r.reconciled_at, "reconciled_at"), settledAt: r.settled_at == null ? null : d(r.settled_at, "settled_at"),
});

export async function runContrarianMigrations(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS kalshi_scalp_contrarian_config (id TEXT PRIMARY KEY DEFAULT 'singleton', config JSONB NOT NULL, version BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await c.query(`ALTER TABLE kalshi_scalp_contrarian_config ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0`);
    await c.query(`CREATE TABLE IF NOT EXISTS kalshi_scalp_contrarian_observations (
      id TEXT PRIMARY KEY, execution_mode TEXT NOT NULL CHECK(execution_mode IN ('paper','live')), source_mode TEXT NOT NULL CHECK(source_mode IN ('paper','live')),
      symbol TEXT NOT NULL, window_key TEXT NOT NULL, ticker TEXT NOT NULL, protected_side TEXT NOT NULL CHECK(protected_side IN ('yes','no')),
      opposite_side TEXT NOT NULL CHECK(opposite_side IN ('yes','no')), eligible BOOLEAN NOT NULL, reason TEXT NOT NULL, evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      yes_ask NUMERIC(16,8), no_ask NUMERIC(16,8), direct_ask NUMERIC(16,8), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await c.query(`CREATE TABLE IF NOT EXISTS kalshi_scalp_contrarian_reservations (
      id TEXT PRIMARY KEY, execution_mode TEXT NOT NULL CHECK(execution_mode IN ('paper','live')), source_mode TEXT NOT NULL CHECK(source_mode IN ('paper','live')),
      symbol TEXT NOT NULL, window_key TEXT NOT NULL, ticker TEXT NOT NULL, reserved_budget NUMERIC(16,8) NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('claimed','released','filled','unknown','settled')), reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(execution_mode,symbol,window_key))`);
    await c.query(`CREATE TABLE IF NOT EXISTS kalshi_scalp_contrarian_orders (
      id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES kalshi_scalp_contrarian_reservations(id), execution_mode TEXT NOT NULL CHECK(execution_mode IN ('paper','live')),
      source_mode TEXT NOT NULL CHECK(source_mode IN ('paper','live')), symbol TEXT NOT NULL, window_key TEXT NOT NULL, ticker TEXT NOT NULL,
      protected_side TEXT NOT NULL CHECK(protected_side IN ('yes','no')), opposite_side TEXT NOT NULL CHECK(opposite_side IN ('yes','no')), contract_count INTEGER NOT NULL CHECK(contract_count > 0),
      yes_limit_price NUMERIC(16,8) NOT NULL, direct_ask NUMERIC(16,8) NOT NULL, yes_ask NUMERIC(16,8), no_ask NUMERIC(16,8), client_order_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('submitting','zero_fill','filled','unknown','settled')), exchange_order_id TEXT, filled_count NUMERIC(16,8) NOT NULL DEFAULT 0,
      avg_yes_fill_price NUMERIC(16,8), budget_spent NUMERIC(16,8) NOT NULL DEFAULT 0, settlement_result TEXT CHECK(settlement_result IN ('yes','no')),
      outcome TEXT CHECK(outcome IN ('win','loss')), pnl NUMERIC(16,8), evidence JSONB NOT NULL DEFAULT '{}'::jsonb, reconciliation_evidence JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reconciled_at TIMESTAMPTZ, settled_at TIMESTAMPTZ)`);
    await c.query(`CREATE TABLE IF NOT EXISTS kalshi_scalp_contrarian_incidents (
      id TEXT PRIMARY KEY, order_id TEXT, reservation_id TEXT, execution_mode TEXT NOT NULL CHECK(execution_mode IN ('paper','live')), symbol TEXT NOT NULL, window_key TEXT NOT NULL,
      ticker TEXT NOT NULL, reason TEXT NOT NULL, evidence JSONB NOT NULL DEFAULT '{}'::jsonb, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await c.query(`CREATE INDEX IF NOT EXISTS contrarian_observations_recent ON kalshi_scalp_contrarian_observations(created_at DESC)`);
    await c.query(`CREATE INDEX IF NOT EXISTS contrarian_orders_reconcile ON kalshi_scalp_contrarian_orders(execution_mode,status,created_at)`);
    await c.query(`CREATE INDEX IF NOT EXISTS contrarian_incidents_unresolved ON kalshi_scalp_contrarian_incidents(created_at DESC) WHERE resolved_at IS NULL`);
  } finally { c.release(); }
}

function mergeConfig(raw: Record<string, unknown>): ContrarianConfig {
  const positive = (key: keyof ContrarianConfig) => typeof raw[key] === "number" && Number.isFinite(raw[key]) && (raw[key] as number) > 0 ? raw[key] as number : DEFAULT_CONTRARIAN_CONFIG[key] as number;
  return { enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONTRARIAN_CONFIG.enabled, mode: raw.mode === "live" || raw.mode === "paper" ? raw.mode : DEFAULT_CONTRARIAN_CONFIG.mode,
    budgetDollars: positive("budgetDollars"), dailyCapDollars: positive("dailyCapDollars"), openCapDollars: positive("openCapDollars"), perWindowCapDollars: positive("perWindowCapDollars"), maxDirectContractCost: positive("maxDirectContractCost"),
    circuitBreakerEnabled: typeof raw.circuitBreakerEnabled === "boolean" ? raw.circuitBreakerEnabled : DEFAULT_CONTRARIAN_CONFIG.circuitBreakerEnabled, circuitBreaker: typeof raw.circuitBreaker === "boolean" ? raw.circuitBreaker : DEFAULT_CONTRARIAN_CONFIG.circuitBreaker,
    circuitBreakerReason: typeof raw.circuitBreakerReason === "string" ? raw.circuitBreakerReason : null };
}
export async function loadContrarianConfigRecord(): Promise<ContrarianConfigRecord> {
  const result = await pool.query(`INSERT INTO kalshi_scalp_contrarian_config(id,config) VALUES('singleton',$1) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING config,updated_at,version`, [JSON.stringify(DEFAULT_CONTRARIAN_CONFIG)]);
  const r = result.rows[0] as DbRow; return { config: mergeConfig(json(r.config)), updatedAt: d(r.updated_at, "updated_at"), version: n(r.version, "version") };
}
export async function loadContrarianConfig(): Promise<ContrarianConfig> { return (await loadContrarianConfigRecord()).config; }
export async function saveContrarianConfig(config: ContrarianConfig, expectedVersion?: number): Promise<ContrarianConfigRecord | null> {
  const result = await pool.query(`UPDATE kalshi_scalp_contrarian_config SET config=$1,version=version+1,updated_at=NOW() WHERE id='singleton' AND ($2::bigint IS NULL OR version=$2) RETURNING config,updated_at,version`, [JSON.stringify(config), expectedVersion ?? null]);
  if (!result.rows[0]) return null; const r = result.rows[0] as DbRow; return { config: mergeConfig(json(r.config)), updatedAt: d(r.updated_at, "updated_at"), version: n(r.version, "version") };
}

export async function recordContrarianObservation(input: Omit<ContrarianObservation, "id" | "createdAt">): Promise<ContrarianObservation> {
  const result = await pool.query(`INSERT INTO kalshi_scalp_contrarian_observations(id,execution_mode,source_mode,symbol,window_key,ticker,protected_side,opposite_side,eligible,reason,evidence,yes_ask,no_ask,direct_ask)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [crypto.randomUUID(),input.executionMode,input.sourceMode,input.symbol,input.windowKey,input.ticker,input.protectedSide,input.oppositeSide,input.eligible,input.reason,JSON.stringify(input.evidence),input.yesAsk,input.noAsk,input.directAsk]);
  const r = result.rows[0] as DbRow; return { id:String(r.id), executionMode:r.execution_mode as ContrarianMode, sourceMode:r.source_mode as ContrarianMode, symbol:String(r.symbol), windowKey:String(r.window_key), ticker:String(r.ticker), protectedSide:r.protected_side as ContrarianSide, oppositeSide:r.opposite_side as ContrarianSide, eligible:Boolean(r.eligible), reason:String(r.reason), evidence:json(r.evidence), yesAsk:r.yes_ask == null ? null : n(r.yes_ask,"yes_ask"), noAsk:r.no_ask == null ? null : n(r.no_ask,"no_ask"), directAsk:r.direct_ask == null ? null : n(r.direct_ask,"direct_ask"), createdAt:d(r.created_at,"created_at") };
}

export async function claimContrarianReservation(input: ContrarianClaimInput): Promise<ContrarianClaimResult> {
  if (![input.requestedBudget,input.dailyCap,input.openCap,input.perWindowCap].every((x) => Number.isFinite(x) && x > 0)) throw new Error("contrarian claim requires finite positive budgets and caps");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kalshi-scalper-contrarian-cap:${input.executionMode}`]);
    const prior = await c.query(`SELECT r.*,o.status AS order_status FROM kalshi_scalp_contrarian_reservations r LEFT JOIN kalshi_scalp_contrarian_orders o ON o.reservation_id=r.id WHERE r.execution_mode=$1 AND r.symbol=$2 AND r.window_key=$3 FOR UPDATE OF r`, [input.executionMode,input.symbol,input.windowKey]);
    const existing = prior.rows[0] as DbRow | undefined;
    if (existing && (existing.status !== "released" || existing.order_status != null)) {
      await c.query("COMMIT"); return { claimed:false, reason:"existing_contrarian_ownership", reservation:reservationRow(existing), dailyCommitted:0,openCommitted:0,windowCommitted:0 };
    }
    const normalConflict = await c.query(
      `SELECT 1
       FROM kalshi_scalp_reservations r
       LEFT JOIN kalshi_scalp_orders o
         ON o.mode = r.mode
        AND o.symbol = r.symbol
        AND o.window_key = r.window_key
        AND o.ticker = r.ticker
       WHERE r.mode=$1 AND r.symbol=$2 AND r.window_key=$3
         AND (
           o.status IN ('submitting','unknown','filled')
           OR (
             o.id IS NULL
             AND r.status = 'claimed'
             AND r.reserved_budget > 0
           )
         )
       LIMIT 1`,
      [input.sourceMode,input.symbol,input.windowKey],
    );
    if (normalConflict.rows[0]) {
      await c.query("COMMIT");
      return { claimed:false, reason:"normal_scalper_exposure", reservation:existing ? reservationRow(existing) : null, dailyCommitted:0,openCommitted:0,windowCommitted:0 };
    }
    const totals = await c.query(`WITH amounts AS (
      SELECT r.execution_mode,r.window_key,r.created_at,r.reserved_budget,r.status,o.status AS order_status,o.budget_spent
      FROM kalshi_scalp_contrarian_reservations r LEFT JOIN kalshi_scalp_contrarian_orders o ON o.reservation_id=r.id WHERE r.execution_mode=$1
    ) SELECT
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND (status <> 'released' OR order_status IN ('submitting','unknown','filled','settled')) THEN CASE WHEN order_status IN ('filled','settled') THEN GREATEST(budget_spent,reserved_budget) ELSE reserved_budget END ELSE 0 END),0) daily,
        COALESCE(SUM(CASE WHEN order_status IN ('submitting','unknown','filled') OR (order_status IS NULL AND status='claimed') THEN CASE WHEN order_status='filled' THEN GREATEST(budget_spent,reserved_budget) ELSE reserved_budget END ELSE 0 END),0) open,
      COALESCE(SUM(CASE WHEN window_key=$2 AND (status <> 'released' OR order_status IN ('submitting','unknown','filled','settled')) THEN CASE WHEN order_status IN ('filled','settled') THEN GREATEST(budget_spent,reserved_budget) ELSE reserved_budget END ELSE 0 END),0) window_committed FROM amounts`, [input.executionMode,input.windowKey]);
    const t = totals.rows[0] as DbRow; const daily=n(t.daily,"daily"), open=n(t.open,"open"), window=n(t.window_committed,"window_committed");
    const rejected = input.requestedBudget + daily > input.dailyCap ? "daily_cap_exceeded" : input.requestedBudget + open > input.openCap ? "open_cap_exceeded" : input.requestedBudget + window > input.perWindowCap ? "per_window_cap_exceeded" : null;
    if (rejected) {
      const q = await c.query(`INSERT INTO kalshi_scalp_contrarian_reservations(id,execution_mode,source_mode,symbol,window_key,ticker,reserved_budget,status,reason) VALUES($1,$2,$3,$4,$5,$6,0,'released',$7)
        ON CONFLICT(execution_mode,symbol,window_key) DO UPDATE SET source_mode=EXCLUDED.source_mode,ticker=EXCLUDED.ticker,reserved_budget=0,status='released',reason=EXCLUDED.reason,updated_at=NOW() RETURNING *`, [existing ? existing.id : crypto.randomUUID(),input.executionMode,input.sourceMode,input.symbol,input.windowKey,input.ticker,rejected]);
      await c.query("COMMIT"); return { claimed:false,reason:rejected,reservation:reservationRow(q.rows[0] as DbRow),dailyCommitted:daily,openCommitted:open,windowCommitted:window };
    }
    const q = await c.query(`INSERT INTO kalshi_scalp_contrarian_reservations(id,execution_mode,source_mode,symbol,window_key,ticker,reserved_budget,status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,'claimed',$8)
      ON CONFLICT(execution_mode,symbol,window_key) DO UPDATE SET source_mode=EXCLUDED.source_mode,ticker=EXCLUDED.ticker,reserved_budget=EXCLUDED.reserved_budget,status='claimed',reason=EXCLUDED.reason,updated_at=NOW() RETURNING *`, [existing ? existing.id : crypto.randomUUID(),input.executionMode,input.sourceMode,input.symbol,input.windowKey,input.ticker,input.requestedBudget,input.reason ?? null]);
    await c.query("COMMIT"); return { claimed:true,reservation:reservationRow(q.rows[0] as DbRow),dailyCommitted:daily,openCommitted:open,windowCommitted:window };
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
}

export async function insertContrarianOrderIntent(input: ContrarianOrderIntentInput): Promise<ContrarianOrder> {
  if (!Number.isInteger(input.contractCount) || input.contractCount < 1) throw new Error("contractCount must be a positive integer");
  const result = await pool.query(`INSERT INTO kalshi_scalp_contrarian_orders(id,reservation_id,execution_mode,source_mode,symbol,window_key,ticker,protected_side,opposite_side,contract_count,yes_limit_price,direct_ask,yes_ask,no_ask,client_order_id,evidence)
    SELECT $1,r.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
    FROM kalshi_scalp_contrarian_reservations r
    WHERE r.id=$2 AND r.status='claimed' AND r.reserved_budget > 0
      AND r.execution_mode=$3 AND r.source_mode=$4 AND r.symbol=$5
      AND r.window_key=$6 AND r.ticker=$7
    RETURNING *`, [crypto.randomUUID(),input.reservationId,input.executionMode,input.sourceMode,input.symbol,input.windowKey,input.ticker,input.protectedSide,input.oppositeSide,input.contractCount,input.yesLimitPrice,input.directAsk,input.yesAsk ?? null,input.noAsk ?? null,input.clientOrderId,JSON.stringify(input.evidence)]);
  if (!result.rows[0]) throw new Error("contrarian reservation is no longer claimable");
  return orderRow(result.rows[0] as DbRow);
}

export async function releaseContrarianReservation(
  reservationId: string,
  reason: string,
): Promise<ContrarianReservation | null> {
  const result = await pool.query(
    `UPDATE kalshi_scalp_contrarian_reservations
     SET status='released',reserved_budget=0,reason=$2,updated_at=NOW()
     WHERE id=$1 AND status='claimed'
       AND NOT EXISTS (
         SELECT 1 FROM kalshi_scalp_contrarian_orders o
         WHERE o.reservation_id=kalshi_scalp_contrarian_reservations.id
       )
     RETURNING *`,
    [reservationId,reason],
  );
  return result.rows[0] ? reservationRow(result.rows[0] as DbRow) : null;
}

async function finalize(orderId: string, status: ContrarianOrderStatus, input: ContrarianFinalizeInput): Promise<ContrarianOrder | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const q = await c.query(
      `UPDATE kalshi_scalp_contrarian_orders
       SET status=$2,
           exchange_order_id=COALESCE($3,exchange_order_id),
           filled_count=COALESCE($4,filled_count),
           avg_yes_fill_price=COALESCE($5,avg_yes_fill_price),
           budget_spent=COALESCE($6,budget_spent),
           reconciliation_evidence=COALESCE($7,reconciliation_evidence),
           reconciled_at=NOW(),
           updated_at=NOW()
       WHERE id=$1
         AND status IN ('submitting','unknown')
       RETURNING *`,
      [orderId,status,input.exchangeOrderId ?? null,input.filledCount ?? null,input.avgYesFillPrice ?? null,input.budgetSpent ?? null,input.evidence ? JSON.stringify(input.evidence) : null],
    );
    if (!q.rows[0]) { await c.query("COMMIT"); return null; }
    const order = orderRow(q.rows[0] as DbRow);
    const reservationStatus: ContrarianReservationStatus = status === "zero_fill" ? "released" : status === "unknown" ? "unknown" : "filled";
    await c.query(`UPDATE kalshi_scalp_contrarian_reservations SET status=$2,reserved_budget=CASE WHEN $2='released' THEN 0 ELSE reserved_budget END,reason=COALESCE($3,reason),updated_at=NOW() WHERE id=$1`, [order.reservationId,reservationStatus,input.reason ?? null]);
    if (status === "unknown") {
      await c.query(
        `INSERT INTO kalshi_scalp_contrarian_incidents(id,order_id,reservation_id,execution_mode,symbol,window_key,ticker,reason,evidence)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
         WHERE NOT EXISTS (
           SELECT 1
           FROM kalshi_scalp_contrarian_incidents
           WHERE order_id=$2
             AND reason=$8
             AND resolved_at IS NULL
         )`,
        [crypto.randomUUID(),order.id,order.reservationId,order.executionMode,order.symbol,order.windowKey,order.ticker,input.reason ?? "post_submit_unknown",JSON.stringify(input.evidence ?? {})],
      );
    } else {
      await c.query(
        `UPDATE kalshi_scalp_contrarian_incidents
         SET resolved_at=NOW()
         WHERE order_id=$1
           AND resolved_at IS NULL`,
        [order.id],
      );
    }
    await c.query("COMMIT"); return order;
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
}
export const finalizeContrarianZeroFill = (input: ContrarianFinalizeInput) => finalize(input.orderId, "zero_fill", input);
export const finalizeContrarianFilled = (input: ContrarianFinalizeInput) => finalize(input.orderId, "filled", input);
export const finalizeContrarianUnknown = (input: ContrarianFinalizeInput) => finalize(input.orderId, "unknown", input);
export async function finalizeContrarianPaper(input: ContrarianFinalizeInput): Promise<ContrarianOrder | null> { return finalize(input.orderId, "filled", input); }
export async function settleContrarianOrder(orderId: string, settlementResult: ContrarianSide, outcome: "win" | "loss", pnl: number, evidence?: Record<string, unknown>): Promise<ContrarianOrder | null> {
  const c = await pool.connect(); try { await c.query("BEGIN"); const q=await c.query(`UPDATE kalshi_scalp_contrarian_orders SET status='settled',settlement_result=$2,outcome=$3,pnl=$4,reconciliation_evidence=COALESCE($5,reconciliation_evidence),settled_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='filled' RETURNING *`,[orderId,settlementResult,outcome,pnl,evidence ? JSON.stringify(evidence) : null]); if (!q.rows[0]) { await c.query("COMMIT"); return null; } const o=orderRow(q.rows[0] as DbRow); await c.query(`UPDATE kalshi_scalp_contrarian_reservations SET status='settled',reserved_budget=0,updated_at=NOW() WHERE id=$1`,[o.reservationId]); await c.query("COMMIT"); return o; } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } }

export async function getActiveContrarianExposures(): Promise<Array<{ mode: ContrarianMode; symbol: string; windowKey: string; status: string }>> {
  const q=await pool.query(`SELECT source_mode,symbol,window_key,status FROM kalshi_scalp_contrarian_orders WHERE execution_mode='live' AND status IN ('submitting','unknown','filled')`); return q.rows.map((r:DbRow)=>({mode:r.source_mode as ContrarianMode,symbol:String(r.symbol),windowKey:String(r.window_key),status:String(r.status)}));
}
export async function hasNormalScalpExposure(mode: ContrarianMode, symbol: string, windowKey: string, ticker: string): Promise<boolean> {
  const q=await pool.query(`SELECT 1 FROM kalshi_scalp_orders WHERE mode=$1 AND symbol=$2 AND window_key=$3 AND ticker=$4 AND status IN ('submitting','unknown','filled') LIMIT 1`,[mode,symbol,windowKey,ticker]); return Boolean(q.rows[0]);
}
export async function getContrarianOrders(statuses?: ContrarianOrderStatus[], limit=100): Promise<ContrarianOrder[]> {
  const q=await pool.query(`SELECT * FROM kalshi_scalp_contrarian_orders WHERE ($1::text[] IS NULL OR status=ANY($1)) ORDER BY created_at DESC LIMIT $2`,[statuses ?? null,Math.max(1,Math.min(500,limit))]); return q.rows.map((r:DbRow)=>orderRow(r));
}
export async function getContrarianOrder(id: string): Promise<ContrarianOrder | null> {
  const q=await pool.query(`SELECT * FROM kalshi_scalp_contrarian_orders WHERE id=$1`,[id]);
  return q.rows[0] ? orderRow(q.rows[0] as DbRow) : null;
}
export const getUnknownContrarianOrders = () => getContrarianOrders(["unknown","submitting"]);
export const getUnsettledContrarianOrders = () => getContrarianOrders(["filled"]);
export async function getRecentContrarianIncidents(limit=100): Promise<ContrarianIncident[]> {
  const q=await pool.query(
    `SELECT * FROM kalshi_scalp_contrarian_incidents
     ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1,Math.min(500,limit))],
  );
  return q.rows.map((r:DbRow)=>({
    id:String(r.id),
    orderId:r.order_id == null ? null : String(r.order_id),
    reservationId:r.reservation_id == null ? null : String(r.reservation_id),
    executionMode:r.execution_mode as ContrarianMode,
    symbol:String(r.symbol),
    windowKey:String(r.window_key),
    ticker:String(r.ticker),
    reason:String(r.reason),
    evidence:json(r.evidence),
    resolvedAt:r.resolved_at == null ? null : d(r.resolved_at,"resolved_at"),
    createdAt:d(r.created_at,"created_at"),
  }));
}
export async function getRecentContrarianObservations(limit=100): Promise<ContrarianObservation[]> { const q=await pool.query(`SELECT * FROM kalshi_scalp_contrarian_observations ORDER BY created_at DESC LIMIT $1`,[Math.max(1,Math.min(500,limit))]); return q.rows.map((r:DbRow)=>({id:String(r.id),executionMode:r.execution_mode as ContrarianMode,sourceMode:r.source_mode as ContrarianMode,symbol:String(r.symbol),windowKey:String(r.window_key),ticker:String(r.ticker),protectedSide:r.protected_side as ContrarianSide,oppositeSide:r.opposite_side as ContrarianSide,eligible:Boolean(r.eligible),reason:String(r.reason),evidence:json(r.evidence),yesAsk:r.yes_ask == null?null:n(r.yes_ask,"yes_ask"),noAsk:r.no_ask == null?null:n(r.no_ask,"no_ask"),directAsk:r.direct_ask == null?null:n(r.direct_ask,"direct_ask"),createdAt:d(r.created_at,"created_at")})); }
export async function getContrarianTotals(mode: ContrarianMode): Promise<{ daily:number; open:number; spent:number; pnl:number; unresolved:number }> { const q=await pool.query(`SELECT COALESCE(SUM(CASE WHEN o.created_at >= date_trunc('day',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN GREATEST(o.budget_spent,r.reserved_budget) ELSE 0 END),0) daily,COALESCE(SUM(CASE WHEN o.status IN ('submitting','unknown','filled') THEN GREATEST(o.budget_spent,r.reserved_budget) ELSE 0 END),0) open,COALESCE(SUM(o.budget_spent),0) spent,COALESCE(SUM(o.pnl),0) pnl,COALESCE(SUM(CASE WHEN o.status IN ('submitting','unknown') THEN GREATEST(o.budget_spent,r.reserved_budget) ELSE 0 END),0) unresolved FROM kalshi_scalp_contrarian_orders o JOIN kalshi_scalp_contrarian_reservations r ON r.id=o.reservation_id WHERE o.execution_mode=$1`,[mode]); const r=q.rows[0] as DbRow; return {daily:n(r.daily,"daily"),open:n(r.open,"open"),spent:n(r.spent,"spent"),pnl:n(r.pnl,"pnl"),unresolved:n(r.unresolved,"unresolved")}; }

export async function getContrarianReportCounts(): Promise<{ totalOrders: number; unresolvedLiveOrders: number }> {
  const q = await pool.query(
    `SELECT
       COUNT(*)::int AS total_orders,
       COUNT(*) FILTER (
         WHERE execution_mode='live'
           AND status IN ('submitting','unknown')
       )::int AS unresolved_live_orders
     FROM kalshi_scalp_contrarian_orders`,
  );
  const row = q.rows[0] as DbRow;
  return {
    totalOrders: n(row.total_orders, "total_orders"),
    unresolvedLiveOrders: n(row.unresolved_live_orders, "unresolved_live_orders"),
  };
}
