// Isolated persistence for Smart Exit.  In particular, this module never
// writes to either the regular bot or scalper schemas.
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { DEFAULT_SMART_EXIT_CONFIG } from "./kalshi-smart-exit-policy.ts";
import type {
  SmartExitConfig,
  SmartExitEvaluationRecord,
  SmartExitEvidence,
  SmartExitOwnerKind,
  SmartExitState,
} from "./kalshi-smart-exit-types.ts";

export type SmartExitReportStatus =
  | "insufficient_data" | "validated" | "rejected" | "applied" | "superseded";
export type SmartExitRequestStatus =
  | "requested" | "filled" | "zero_fill" | "unknown" | "blocked";

export interface SmartExitEvidenceInput {
  owner: SmartExitOwnerKind;
  symbol: string;
  evidence: SmartExitEvidence;
}

export interface SmartExitReplayReport {
  id: string;
  owner: SmartExitOwnerKind;
  symbol: string;
  version: string;
  status: SmartExitReportStatus;
  payload: Record<string, unknown>;
  createdAt?: Date | string;
}

export interface SmartExitExitRequest {
  id: string;
  owner: SmartExitOwnerKind;
  positionId: string;
  symbol: string;
  status?: SmartExitRequestStatus;
  payload?: Record<string, unknown>;
}

export interface SmartExitRecoveryStudy {
  id: string;
  owner: SmartExitOwnerKind;
  positionId: string;
  symbol: string;
  payload: Record<string, unknown>;
  observedAt?: Date | string;
}

export interface SmartExitPersistedPositionState {
  owner: SmartExitOwnerKind;
  positionId: string;
  symbol: string;
  modelAtEntryProbability: number | null;
  state: SmartExitState;
  updatedAt?: Date | string;
}

let migrated = false;
let migrationPromise: Promise<void> | null = null;

/** Creates only kalshi_smart_exit_* tables and is safe on every startup. */
export async function runSmartExitMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_config (
        id TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_evidence_samples (
        sample_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        symbol TEXT NOT NULL,
        evidence JSONB NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_evidence_replay
      ON kalshi_smart_exit_evidence_samples (owner, symbol, observed_at ASC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_evaluations (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        evaluated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_evaluations_position_latest
      ON kalshi_smart_exit_evaluations (owner, position_id, evaluated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_evaluations_symbol_latest
      ON kalshi_smart_exit_evaluations (owner, symbol, evaluated_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_position_state (
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        model_at_entry_probability DOUBLE PRECISION,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner, position_id)
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_replay_reports (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        symbol TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN
          ('insufficient_data','validated','rejected','applied','superseded')),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_at TIMESTAMPTZ,
        UNIQUE (owner, symbol, version)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_reports_latest
      ON kalshi_smart_exit_replay_reports (owner, symbol, created_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_requests (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
          ('requested','filled','zero_fill','unknown','blocked')),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        UNIQUE (owner, position_id)
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_recovery_studies (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        payload JSONB NOT NULL,
        observed_only BOOLEAN NOT NULL DEFAULT TRUE CHECK (observed_only = TRUE),
        submitted_order BOOLEAN NOT NULL DEFAULT FALSE CHECK (NOT submitted_order),
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_recovery_position
      ON kalshi_smart_exit_recovery_studies (owner, position_id, observed_at DESC)`);
    migrated = true;
    logger.info("[kalshi-smart-exit] DB migrations complete");
  } finally {
    client.release();
  }
}

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  if (!migrationPromise) migrationPromise = runSmartExitMigrations().catch((error) => {
    migrationPromise = null;
    throw error;
  });
  await migrationPromise;
}

export async function loadSmartExitConfig(): Promise<SmartExitConfig> {
  await ensureMigrated();
  const result = await pool.query(`SELECT config FROM kalshi_smart_exit_config WHERE id = 'singleton'`);
  return (result.rows[0]?.config ?? DEFAULT_SMART_EXIT_CONFIG) as SmartExitConfig;
}

export async function saveSmartExitConfig(config: SmartExitConfig): Promise<void> {
  await ensureMigrated();
  await pool.query(`
    INSERT INTO kalshi_smart_exit_config (id, config, updated_at) VALUES ('singleton', $1, NOW())
    ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`, [config]);
}

/** Appends a synchronized, compact evidence sample for deterministic replay. */
export async function insertSmartExitEvidence(input: SmartExitEvidenceInput): Promise<void> {
  await ensureMigrated();
  const sampleId = `${input.owner}:${input.symbol.toUpperCase()}:${Math.round(input.evidence.observedAtSeconds * 1_000)}`;
  await pool.query(`
    INSERT INTO kalshi_smart_exit_evidence_samples (sample_id, owner, symbol, evidence, observed_at)
    VALUES ($1, $2, $3, $4, to_timestamp($5))
    ON CONFLICT (sample_id) DO NOTHING`,
  [sampleId, input.owner, input.symbol.toUpperCase(), input.evidence, input.evidence.observedAtSeconds]);
}

export async function insertSmartExitEvaluation(record: SmartExitEvaluationRecord): Promise<void> {
  await ensureMigrated();
  await pool.query(`
    INSERT INTO kalshi_smart_exit_evaluations (id, owner, position_id, symbol, evaluated_at, payload)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO NOTHING`,
  [record.id, record.owner, record.positionId, record.symbol.toUpperCase(), record.timestamp, record]);
}

export async function upsertSmartExitPositionState(
  value: SmartExitPersistedPositionState,
): Promise<void> {
  await ensureMigrated();
  await pool.query(`
    INSERT INTO kalshi_smart_exit_position_state
      (owner, position_id, symbol, model_at_entry_probability, state, updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT (owner, position_id) DO UPDATE SET
      symbol=EXCLUDED.symbol,
      model_at_entry_probability=COALESCE(
        kalshi_smart_exit_position_state.model_at_entry_probability,
        EXCLUDED.model_at_entry_probability
      ),
      state=EXCLUDED.state,
      updated_at=NOW()`,
  [value.owner, value.positionId, value.symbol.toUpperCase(),
    value.modelAtEntryProbability, value.state]);
}

export async function listSmartExitPositionStates(): Promise<SmartExitPersistedPositionState[]> {
  await ensureMigrated();
  const result = await pool.query(`
    SELECT owner, position_id, symbol, model_at_entry_probability, state, updated_at
    FROM kalshi_smart_exit_position_state`);
  return result.rows.map((row: Record<string, unknown>) => ({
    owner: row.owner as SmartExitOwnerKind,
    positionId: String(row.position_id),
    symbol: String(row.symbol),
    modelAtEntryProbability: row.model_at_entry_probability == null
      ? null
      : Number(row.model_at_entry_probability),
    state: row.state as SmartExitState,
    updatedAt: row.updated_at as Date,
  }));
}

export async function listSmartExitEvaluations(params: {
  owner?: SmartExitOwnerKind; symbol?: string; positionId?: string; limit?: number;
} = {}): Promise<SmartExitEvaluationRecord[]> {
  await ensureMigrated();
  const result = await pool.query(`
    SELECT payload FROM kalshi_smart_exit_evaluations
    WHERE ($1::text IS NULL OR owner = $1) AND ($2::text IS NULL OR symbol = upper($2))
      AND ($3::text IS NULL OR position_id = $3)
    ORDER BY evaluated_at DESC LIMIT $4`,
  [params.owner ?? null, params.symbol ?? null, params.positionId ?? null, Math.max(1, params.limit ?? 100)]);
  return result.rows.map((row: { payload: SmartExitEvaluationRecord }) => row.payload);
}

export async function listLatestSmartExitEvaluationsPerPosition(params: {
  owner?: SmartExitOwnerKind; symbol?: string; limit?: number;
} = {}): Promise<SmartExitEvaluationRecord[]> {
  await ensureMigrated();
  const result = await pool.query(`
    SELECT payload FROM (
      SELECT DISTINCT ON (owner, position_id) payload, owner, position_id, evaluated_at
      FROM kalshi_smart_exit_evaluations
      WHERE ($1::text IS NULL OR owner = $1) AND ($2::text IS NULL OR symbol = upper($2))
      ORDER BY owner, position_id, evaluated_at DESC
    ) latest ORDER BY evaluated_at DESC LIMIT $3`,
  [params.owner ?? null, params.symbol ?? null, Math.max(1, params.limit ?? 100)]);
  return result.rows.map((row: { payload: SmartExitEvaluationRecord }) => row.payload);
}

export async function listSmartExitReplayReports(params: {
  owner?: SmartExitOwnerKind; symbol?: string; limit?: number;
} = {}): Promise<SmartExitReplayReport[]> {
  await ensureMigrated();
  const result = await pool.query(`
    SELECT id, owner, symbol, version, status, payload, created_at
    FROM kalshi_smart_exit_replay_reports
    WHERE ($1::text IS NULL OR owner = $1) AND ($2::text IS NULL OR symbol = upper($2))
    ORDER BY created_at DESC LIMIT $3`,
  [params.owner ?? null, params.symbol ?? null, Math.max(1, params.limit ?? 100)]);
  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), owner: row.owner as SmartExitOwnerKind, symbol: String(row.symbol),
    version: String(row.version), status: row.status as SmartExitReportStatus,
    payload: row.payload as Record<string, unknown>, createdAt: row.created_at as Date,
  }));
}

export async function getValidatedSmartExitParameterReport(
  owner: SmartExitOwnerKind, symbol: string,
): Promise<SmartExitReplayReport | null> {
  await ensureMigrated();
  const result = await pool.query(`
    SELECT id, owner, symbol, version, status, payload, created_at
    FROM kalshi_smart_exit_replay_reports
    WHERE owner = $1 AND symbol = upper($2) AND status = 'validated'
    ORDER BY created_at DESC LIMIT 1`, [owner, symbol]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? {
    id: String(row.id), owner: row.owner as SmartExitOwnerKind, symbol: String(row.symbol),
    version: String(row.version), status: row.status as SmartExitReportStatus,
    payload: row.payload as Record<string, unknown>, createdAt: row.created_at as Date,
  } : null;
}

export async function insertSmartExitReplayReport(report: SmartExitReplayReport): Promise<void> {
  await ensureMigrated();
  await pool.query(`
    INSERT INTO kalshi_smart_exit_replay_reports (id, owner, symbol, version, status, payload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()))
    ON CONFLICT (owner, symbol, version) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload`,
  [report.id, report.owner, report.symbol.toUpperCase(), report.version, report.status, report.payload,
    report.createdAt ?? null]);
}

/** Applies only a still-validated report, and records its application atomically. */
export async function applyValidatedSmartExitParameterVersion(params: {
  owner: SmartExitOwnerKind; symbol: string; version: string; config: SmartExitConfig;
}): Promise<boolean> {
  await ensureMigrated();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await client.query(`
      SELECT id FROM kalshi_smart_exit_replay_reports
      WHERE owner=$1 AND symbol=upper($2) AND version=$3 AND status='validated' FOR UPDATE`,
    [params.owner, params.symbol, params.version]);
    if (!report.rows[0]) { await client.query("ROLLBACK"); return false; }
    await client.query(`INSERT INTO kalshi_smart_exit_config (id,config,updated_at) VALUES ('singleton',$1,NOW())
      ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`, [params.config]);
    await client.query(`UPDATE kalshi_smart_exit_replay_reports SET status='applied', applied_at=NOW() WHERE id=$1`,
      [report.rows[0].id]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function claimSmartExitRequest(request: SmartExitExitRequest): Promise<{ claimed: boolean; reason: string | null }> {
  await ensureMigrated();
  const result = await pool.query(`
    INSERT INTO kalshi_smart_exit_requests (id,owner,position_id,symbol,status,payload)
    VALUES ($1,$2,$3,$4,'requested',$5) ON CONFLICT (owner,position_id) DO NOTHING`,
  [request.id, request.owner, request.positionId, request.symbol.toUpperCase(), request.payload ?? {}]);
  return result.rowCount === 1 ? { claimed: true, reason: null } : { claimed: false, reason: "exit_request_exists" };
}

export async function resolveSmartExitRequest(params: {
  id: string; status: "filled" | "zero_fill" | "blocked"; reason?: string | null;
}): Promise<void> {
  await ensureMigrated();
  await pool.query(`UPDATE kalshi_smart_exit_requests SET status=$1, reason=$2, resolved_at=NOW() WHERE id=$3`,
    [params.status, params.reason ?? null, params.id]);
}

export async function markSmartExitRequestUnknown(id: string, reason: string): Promise<void> {
  await ensureMigrated();
  await pool.query(`UPDATE kalshi_smart_exit_requests SET status='unknown', reason=$1, resolved_at=NULL WHERE id=$2`,
    [reason, id]);
}

/**
 * Persists counterfactual recovery evidence only.  The database constraints
 * deliberately make it impossible for this table to describe an order submit.
 */
export async function insertSmartExitRecoveryStudy(study: SmartExitRecoveryStudy): Promise<void> {
  await ensureMigrated();
  await pool.query(`
    INSERT INTO kalshi_smart_exit_recovery_studies
      (id, owner, position_id, symbol, payload, observed_only, submitted_order, observed_at)
    VALUES ($1,$2,$3,$4,$5,TRUE,FALSE,COALESCE($6,NOW()))
    ON CONFLICT (id) DO NOTHING`,
  [study.id, study.owner, study.positionId, study.symbol.toUpperCase(), study.payload,
    study.observedAt ?? null]);
}

/** The sole permitted cross-schema read: no regular/scalper table is mutated. */
export async function listOpenScalperPositions(): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(`
    SELECT id, mode, symbol, window_key, ticker, side, filled_count, contract_count,
           entry_yes_price, avg_fill_price, winning_contract_cost,
           entry_guard_evidence, created_at
    FROM kalshi_scalp_orders
    WHERE status = 'filled' AND settlement_result IS NULL AND filled_count > 0
    ORDER BY created_at ASC`);
  return result.rows;
}