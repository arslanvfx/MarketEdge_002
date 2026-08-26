// Dedicated ledger for Scalper exits.  It is intentionally not part of either
// kalshi_scalp_orders (the entry ledger) or kalshi_smart_exit_* (regular exits).
import { pool } from "@workspace/db";
import { DEFAULT_SCALPER_EXIT_CONFIG, resolveScalperExitSensitivity, type ScalperExitConfig } from "./kalshi-scalper-smart-exit-policy.ts";

export async function runScalperExitMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_config (
      id TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
      config JSONB NOT NULL, version BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_lifecycles (
      id TEXT PRIMARY KEY, scalp_order_id TEXT NOT NULL, mode TEXT NOT NULL,
      symbol TEXT NOT NULL, ticker TEXT NOT NULL, window_key TEXT NOT NULL, side TEXT NOT NULL,
      remaining_quantity NUMERIC(12,2) NOT NULL, status TEXT NOT NULL,
      trigger_reason TEXT, evidence JSONB, executable_quantity NUMERIC(12,2),
      executable_price NUMERIC(12,8), exit_fill_quantity NUMERIC(12,2),
      exit_winning_price NUMERIC(12,8), proceeds NUMERIC(16,8), exit_pnl NUMERIC(16,8),
      entry_winning_price NUMERIC(12,8), entry_stake NUMERIC(16,8),
      settlement_result TEXT, hold_value NUMERIC(16,8), hold_pnl NUMERIC(16,8),
      value_saved NUMERIC(16,8), verdict TEXT, sold_at TIMESTAMPTZ,
      config_version BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ,
      CONSTRAINT uq_scalper_exit_lifecycle UNIQUE (scalp_order_id, mode, ticker, side, remaining_quantity))`);
    await client.query(`CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_requests (
      id TEXT PRIMARY KEY, lifecycle_id TEXT NOT NULL, attempt_no INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      client_order_id TEXT NOT NULL UNIQUE, payload JSONB NOT NULL,
      reason TEXT, exchange_order_id TEXT, fill_quantity NUMERIC(12,2),
      winning_price NUMERIC(12,8), evidence JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ)`);
    await client.query(`ALTER TABLE kalshi_scalper_exit_lifecycles
      ADD COLUMN IF NOT EXISTS entry_winning_price NUMERIC(12,8),
      ADD COLUMN IF NOT EXISTS entry_stake NUMERIC(16,8),
      ADD COLUMN IF NOT EXISTS settlement_result TEXT,
      ADD COLUMN IF NOT EXISTS hold_value NUMERIC(16,8),
      ADD COLUMN IF NOT EXISTS hold_pnl NUMERIC(16,8),
      ADD COLUMN IF NOT EXISTS value_saved NUMERIC(16,8),
      ADD COLUMN IF NOT EXISTS verdict TEXT,
      ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE kalshi_scalper_exit_requests
      DROP CONSTRAINT IF EXISTS kalshi_scalper_exit_requests_lifecycle_id_key`);
    await client.query(`ALTER TABLE kalshi_scalper_exit_requests
      ADD COLUMN IF NOT EXISTS attempt_no INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS exchange_order_id TEXT,
      ADD COLUMN IF NOT EXISTS fill_quantity NUMERIC(12,2),
      ADD COLUMN IF NOT EXISTS winning_price NUMERIC(12,8),
      ADD COLUMN IF NOT EXISTS evidence JSONB,
      ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_scalper_exit_request_attempt
      ON kalshi_scalper_exit_requests (lifecycle_id, attempt_no)`);
    await client.query(`ALTER TABLE kalshi_scalper_exit_lifecycles
      DROP CONSTRAINT IF EXISTS uq_scalper_exit_lifecycle`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_scalper_exit_active_owner
      ON kalshi_scalper_exit_lifecycles (scalp_order_id)
      WHERE status IN ('requested','unknown')`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_scalper_exit_advisory_identity
      ON kalshi_scalper_exit_lifecycles
      (scalp_order_id,mode,ticker,side,remaining_quantity)
      WHERE status='advisory'`);
    await client.query(`CREATE TABLE IF NOT EXISTS kalshi_scalper_exit_evaluations (
      id TEXT PRIMARY KEY, scalp_order_id TEXT NOT NULL, mode TEXT NOT NULL,
      symbol TEXT NOT NULL, ticker TEXT NOT NULL, window_key TEXT NOT NULL,
      side TEXT NOT NULL, remaining_quantity NUMERIC(12,2) NOT NULL,
      evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE INDEX IF NOT EXISTS scalper_exit_eval_order_created
      ON kalshi_scalper_exit_evaluations (scalp_order_id, created_at ASC)`);
  } finally { client.release(); }
}

function normalize(raw: Record<string, unknown>): ScalperExitConfig {
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === "off" || raw.mode === "paper-exit" || raw.mode === "live-exit" || raw.mode === "shadow" ? raw.mode : "shadow",
    sensitivity: resolveScalperExitSensitivity(raw.sensitivity),
    maxEvidenceAgeSeconds: typeof raw.maxEvidenceAgeSeconds === "number" && raw.maxEvidenceAgeSeconds >= 1 && raw.maxEvidenceAgeSeconds <= 5 ? raw.maxEvidenceAgeSeconds : 2,
  };
}
export async function loadScalperExitConfig(): Promise<{ config: ScalperExitConfig; version: number }> {
  const result = await pool.query(`SELECT config, version FROM kalshi_scalper_exit_config WHERE id = 'singleton'`);
  if (!result.rows[0]) {
    await pool.query(`INSERT INTO kalshi_scalper_exit_config (id, config) VALUES ('singleton', $1) ON CONFLICT DO NOTHING`, [JSON.stringify(DEFAULT_SCALPER_EXIT_CONFIG)]);
    return { config: { ...DEFAULT_SCALPER_EXIT_CONFIG }, version: 0 };
  }
  return { config: normalize(result.rows[0].config ?? {}), version: Number(result.rows[0].version) || 0 };
}
export async function saveScalperExitConfig(config: ScalperExitConfig): Promise<{ config: ScalperExitConfig; version: number }> {
  const normalized = normalize(config as unknown as Record<string, unknown>);
  const result = await pool.query(`INSERT INTO kalshi_scalper_exit_config (id, config, version) VALUES ('singleton',$1,1)
    ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, version=kalshi_scalper_exit_config.version+1, updated_at=NOW() RETURNING version`, [JSON.stringify(normalized)]);
  return { config: normalized, version: Number(result.rows[0].version) };
}

export interface ScalperExitLifecycleInput {
  id: string; scalpOrderId: string; mode: string; symbol: string; ticker: string;
  windowKey: string; side: "yes" | "no"; remainingQuantity: number; status: string;
  triggerReason: string; evidence: Record<string, unknown>; executableQuantity: number | null;
  executablePrice: number | null; entryWinningPrice: number; configVersion: number;
}
/** Atomic identity claim. Existing requested/unknown ownership is never replaced. */
export async function claimScalperExitLifecycle(input: ScalperExitLifecycleInput): Promise<{ claimed: boolean; id: string | null; status: string | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(
      `SELECT filled_count FROM kalshi_scalp_orders WHERE id=$1 FOR UPDATE`,
      [input.scalpOrderId],
    );
    if (!order.rows[0]) {
      await client.query("ROLLBACK");
      return { claimed: false, id: null, status: "missing_scalp_order" };
    }
    if (input.status !== "advisory") {
      const unresolved = await client.query(`SELECT l.id,l.status
        FROM kalshi_scalper_exit_lifecycles l
        WHERE l.scalp_order_id=$1 AND l.status IN ('requested','unknown')
        ORDER BY l.created_at ASC LIMIT 1`, [input.scalpOrderId]);
      if (unresolved.rows[0]) {
        await client.query("ROLLBACK");
        return {
          claimed: false,
          id: String(unresolved.rows[0].id),
          status: String(unresolved.rows[0].status),
        };
      }
      const retryable = await client.query(`SELECT id,status
        FROM kalshi_scalper_exit_lifecycles
        WHERE scalp_order_id=$1 AND status='zero_fill'
          AND ABS(remaining_quantity-$2::numeric)<0.001
        ORDER BY created_at DESC LIMIT 1`, [input.scalpOrderId, input.remainingQuantity]);
      if (retryable.rows[0]) {
        await client.query("ROLLBACK");
        return {
          claimed: false,
          id: String(retryable.rows[0].id),
          status: String(retryable.rows[0].status),
        };
      }
      const sold = await client.query(`SELECT COALESCE(SUM(r.fill_quantity),0) AS quantity
        FROM kalshi_scalper_exit_requests r
        JOIN kalshi_scalper_exit_lifecycles l ON l.id=r.lifecycle_id
        WHERE l.scalp_order_id=$1 AND r.status IN ('filled','partial')`,
      [input.scalpOrderId]);
      const expectedRemaining = Math.max(
        0,
        Number(order.rows[0].filled_count) - (Number(sold.rows[0]?.quantity) || 0),
      );
      if (Math.abs(expectedRemaining - input.remainingQuantity) > 0.001) {
        await client.query("ROLLBACK");
        return { claimed: false, id: null, status: "quantity_mismatch" };
      }
    }
    const result = await client.query(`INSERT INTO kalshi_scalper_exit_lifecycles
      (id,scalp_order_id,mode,symbol,ticker,window_key,side,remaining_quantity,status,trigger_reason,evidence,executable_quantity,executable_price,entry_winning_price,entry_stake,config_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14*$8,$15)
      ON CONFLICT DO NOTHING
      RETURNING id,status`,
    [input.id,input.scalpOrderId,input.mode,input.symbol,input.ticker,input.windowKey,input.side,input.remainingQuantity,input.status,input.triggerReason,
      JSON.stringify(input.evidence),input.executableQuantity,input.executablePrice,input.entryWinningPrice,input.configVersion]);
    if (result.rowCount === 1) {
      await client.query("COMMIT");
      return { claimed: true, id: String(result.rows[0].id), status: String(result.rows[0].status) };
    }
    const activeOwner = await client.query(`SELECT id,status
      FROM kalshi_scalper_exit_lifecycles
      WHERE scalp_order_id=$1 AND status IN ('requested','unknown')
      ORDER BY created_at ASC LIMIT 1`, [input.scalpOrderId]);
    if (activeOwner.rows[0]) {
      await client.query("COMMIT");
      return {
        claimed: false,
        id: String(activeOwner.rows[0].id),
        status: String(activeOwner.rows[0].status),
      };
    }
    const existing = await client.query(`SELECT id,status FROM kalshi_scalper_exit_lifecycles
      WHERE scalp_order_id=$1 AND mode=$2 AND ticker=$3 AND side=$4
        AND ABS(remaining_quantity-$5::numeric)<0.001`,
      [input.scalpOrderId,input.mode,input.ticker,input.side,input.remainingQuantity]);
    await client.query("COMMIT");
    return {
      claimed: false,
      id: existing.rows[0]?.id == null ? null : String(existing.rows[0].id),
      status: existing.rows[0]?.status == null ? null : String(existing.rows[0].status),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function claimScalperExitRequest(params: { id: string; lifecycleId: string; clientOrderId: string; payload: Record<string, unknown> }): Promise<{ claimed: boolean; attemptNo: number | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM kalshi_scalper_exit_lifecycles WHERE id=$1 FOR UPDATE`, [params.lifecycleId]);
    const state = await client.query(`SELECT COALESCE(MAX(attempt_no),0) AS attempt_no,
      COUNT(*) FILTER (WHERE status IN ('requested','unknown')) AS unresolved
      FROM kalshi_scalper_exit_requests WHERE lifecycle_id=$1`, [params.lifecycleId]);
    const priorAttempt = Number(state.rows[0]?.attempt_no) || 0;
    const unresolved = Number(state.rows[0]?.unresolved) || 0;
    if (unresolved > 0 || priorAttempt >= 2) {
      await client.query("ROLLBACK");
      return { claimed: false, attemptNo: null };
    }
    const attemptNo = priorAttempt + 1;
    const result = await client.query(`INSERT INTO kalshi_scalper_exit_requests
      (id,lifecycle_id,attempt_no,status,client_order_id,payload)
      VALUES ($1,$2,$3,'requested',$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [params.id, params.lifecycleId, attemptNo, params.clientOrderId, JSON.stringify(params.payload)]);
    if (result.rowCount === 1) {
      await client.query(`UPDATE kalshi_scalper_exit_lifecycles
        SET status='requested',updated_at=NOW() WHERE id=$1`, [params.lifecycleId]);
    }
    await client.query("COMMIT");
    return { claimed: result.rowCount === 1, attemptNo: result.rowCount === 1 ? attemptNo : null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function releaseScalperExitLifecycle(params: {
  id: string;
  reason: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(`UPDATE kalshi_scalper_exit_lifecycles
    SET status='blocked',trigger_reason=$2,
      evidence=CASE WHEN $3::jsonb IS NULL THEN evidence
        ELSE COALESCE(evidence,'{}'::jsonb)||$3::jsonb END,
      updated_at=NOW()
    WHERE id=$1 AND status='requested'
      AND NOT EXISTS (
        SELECT 1 FROM kalshi_scalper_exit_requests r
        WHERE r.lifecycle_id=kalshi_scalper_exit_lifecycles.id
          AND r.status IN ('requested','unknown')
      )`,
  [params.id, params.reason, params.evidence ? JSON.stringify(params.evidence) : null]);
}
export async function resolveScalperExitRequest(params: {
  id: string; status: "filled"|"zero_fill"|"partial"|"unknown"|"blocked";
  reason: string; fillQuantity?: number; winningPrice?: number;
  exchangeOrderId?: string | null; evidence?: Record<string, unknown>;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query(`SELECT lifecycle_id,status FROM kalshi_scalper_exit_requests WHERE id=$1 FOR UPDATE`, [params.id]);
    if (!request.rows[0]) throw new Error("scalper exit request not found");
    const terminalAlready = ["filled","zero_fill","partial","blocked"].includes(String(request.rows[0].status));
    if (terminalAlready) {
      await client.query("COMMIT");
      return;
    }
    await client.query(`UPDATE kalshi_scalper_exit_requests SET status=$2,reason=$3,
      exchange_order_id=COALESCE($4,exchange_order_id),fill_quantity=COALESCE($5,fill_quantity),
      winning_price=COALESCE($6,winning_price),evidence=COALESCE($7,evidence),
      updated_at=NOW(),resolved_at=CASE WHEN $2='unknown' THEN resolved_at ELSE NOW() END WHERE id=$1`,
      [params.id,params.status,params.reason,params.exchangeOrderId ?? null,params.fillQuantity ?? null,
        params.winningPrice ?? null,params.evidence ? JSON.stringify(params.evidence) : null]);
    const lifecycleId = String(request.rows[0].lifecycle_id);
    const totals = await client.query(`SELECT COALESCE(SUM(fill_quantity),0) AS fill_quantity,
      COALESCE(SUM(fill_quantity*winning_price),0) AS proceeds
      FROM kalshi_scalper_exit_requests WHERE lifecycle_id=$1 AND status IN ('filled','partial')`, [lifecycleId]);
    const filled = Number(totals.rows[0]?.fill_quantity) || 0;
    const proceeds = Number(totals.rows[0]?.proceeds) || 0;
    const lifecycle = await client.query(`SELECT remaining_quantity,entry_winning_price FROM kalshi_scalper_exit_lifecycles WHERE id=$1 FOR UPDATE`, [lifecycleId]);
    const requested = Number(lifecycle.rows[0]?.remaining_quantity) || 0;
    const entryWinningPrice = Number(lifecycle.rows[0]?.entry_winning_price) || 0;
    const lifecycleStatus = filled > 0
      ? filled + 1e-9 >= requested ? "filled" : "partial"
      : params.status;
    await client.query(`UPDATE kalshi_scalper_exit_lifecycles SET status=$2,
      exit_fill_quantity=$3,exit_winning_price=CASE WHEN $3>0 THEN $4/$3 ELSE NULL END,
      proceeds=$4,exit_pnl=CASE WHEN $3>0 THEN $4-($3*$5) ELSE NULL END,
      sold_at=CASE WHEN $3>0 THEN COALESCE(sold_at,NOW()) ELSE sold_at END,updated_at=NOW()
      WHERE id=$1`, [lifecycleId,lifecycleStatus,filled,proceeds,entryWinningPrice]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function listScalperExitLifecycles(limit = 100): Promise<Record<string, unknown>[]> {
  return (await pool.query(`SELECT * FROM kalshi_scalper_exit_lifecycles ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
}
export async function listScalperExitEvidenceForReplay(limit = 1000): Promise<Record<string, unknown>[]> {
  return (await pool.query(`SELECT e.*,o.settlement_result,o.winning_contract_cost,o.filled_count
    FROM kalshi_scalper_exit_evaluations e JOIN kalshi_scalp_orders o ON o.id=e.scalp_order_id
    WHERE o.settlement_result IN ('yes','no') ORDER BY e.created_at ASC LIMIT $1`, [limit])).rows;
}
export async function getScalperExitFilledQuantity(scalpOrderId: string): Promise<number> {
  const result = await pool.query(`SELECT COALESCE(SUM(r.fill_quantity),0) AS quantity
    FROM kalshi_scalper_exit_requests r
    JOIN kalshi_scalper_exit_lifecycles l ON l.id=r.lifecycle_id
    WHERE l.scalp_order_id=$1 AND r.status IN ('filled','partial')`, [scalpOrderId]);
  return Number(result.rows[0]?.quantity) || 0;
}
export async function listPendingScalperExitRequests(): Promise<Record<string, unknown>[]> {
  return (await pool.query(`SELECT r.*, l.ticker,l.side,l.remaining_quantity,l.scalp_order_id,l.created_at AS lifecycle_created_at
    FROM kalshi_scalper_exit_requests r JOIN kalshi_scalper_exit_lifecycles l ON l.id=r.lifecycle_id
    WHERE r.status IN ('requested','unknown') ORDER BY r.created_at ASC LIMIT 100`)).rows;
}

export async function recordScalperExitEvaluation(params: {
  id: string; scalpOrderId: string; mode: string; symbol: string; ticker: string;
  windowKey: string; side: "yes" | "no"; remainingQuantity: number;
  evidence: Record<string, unknown>;
}): Promise<void> {
  await pool.query(`INSERT INTO kalshi_scalper_exit_evaluations
    (id,scalp_order_id,mode,symbol,ticker,window_key,side,remaining_quantity,evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [params.id,params.scalpOrderId,params.mode,params.symbol,params.ticker,params.windowKey,
      params.side,params.remainingQuantity,JSON.stringify(params.evidence)]);
}

export async function finalizeSettledScalperExitLifecycles(): Promise<number> {
  const result = await pool.query(`UPDATE kalshi_scalper_exit_lifecycles l SET
    settlement_result=o.settlement_result,
    hold_value=CASE WHEN o.settlement_result=l.side THEN l.remaining_quantity ELSE 0 END,
    hold_pnl=(CASE WHEN o.settlement_result=l.side THEN l.remaining_quantity ELSE 0 END)-l.entry_stake,
    value_saved=CASE
      WHEN l.status='advisory' AND l.executable_price IS NOT NULL
        THEN (l.executable_price*l.remaining_quantity-l.entry_stake)
          -((CASE WHEN o.settlement_result=l.side THEN l.remaining_quantity ELSE 0 END)-l.entry_stake)
      WHEN l.exit_fill_quantity>0 AND l.exit_pnl IS NOT NULL
        THEN l.exit_pnl-((CASE WHEN o.settlement_result=l.side THEN l.exit_fill_quantity ELSE 0 END)
          -(l.entry_winning_price*l.exit_fill_quantity))
      ELSE NULL END,
    verdict=CASE
      WHEN l.status='advisory' AND l.executable_price IS NULL THEN 'unknown'
      WHEN l.status<>'advisory' AND COALESCE(l.exit_fill_quantity,0)=0 THEN 'unknown'
      WHEN (CASE
        WHEN l.status='advisory' THEN l.executable_price*l.remaining_quantity
          -(CASE WHEN o.settlement_result=l.side THEN l.remaining_quantity ELSE 0 END)
        ELSE l.proceeds-(CASE WHEN o.settlement_result=l.side THEN l.exit_fill_quantity ELSE 0 END)
      END)>0 THEN 'saved_loss'
      WHEN (CASE
        WHEN l.status='advisory' THEN l.executable_price*l.remaining_quantity
          -(CASE WHEN o.settlement_result=l.side THEN l.remaining_quantity ELSE 0 END)
        ELSE l.proceeds-(CASE WHEN o.settlement_result=l.side THEN l.exit_fill_quantity ELSE 0 END)
      END)<0 THEN CASE WHEN o.settlement_result=l.side THEN 'missed_win' ELSE 'reduced_profit' END
      ELSE 'no_difference' END,
    settled_at=COALESCE(o.settled_at,NOW()),updated_at=NOW()
    FROM kalshi_scalp_orders o
    WHERE o.id=l.scalp_order_id AND o.settlement_result IN ('yes','no') AND l.settled_at IS NULL`);
  return result.rowCount ?? 0;
}

export async function getScalperExitLifecyclesByOrderIds(orderIds: readonly string[]): Promise<Record<string, unknown>[]> {
  if (orderIds.length === 0) return [];
  return (await pool.query(`SELECT * FROM kalshi_scalper_exit_lifecycles
    WHERE scalp_order_id=ANY($1::text[]) ORDER BY created_at DESC`, [orderIds])).rows;
}