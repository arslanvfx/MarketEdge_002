// Isolated persistence for Smart Exit.  In particular, this module never
// writes to either the regular bot or scalper schemas.
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { DEFAULT_SMART_EXIT_CONFIG, resolveSmartExitSensitivity } from "./kalshi-smart-exit-policy.ts";
import type {
  SmartExitConfig,
  SmartExitEvaluationRecord,
  SmartExitEvidence,
  SmartExitOwnerKind,
  SmartExitLifecycleRecord,
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

export interface SmartExitReplaySource {
  owner: SmartExitOwnerKind;
  positionId: string;
  symbol: string;
  ticker: string;
  side: "yes" | "no";
  entryTimestampSeconds: number;
  expiryTimestampSeconds: number;
  entryContractCost: number;
  quantity: number;
  evaluations: SmartExitEvaluationRecord[];
}

let migrated = false;
let migrationPromise: Promise<void> | null = null;
const SMART_EXIT_REPLAY_MAX_POSITIONS = 50;
const SMART_EXIT_REPLAY_MAX_EVALUATIONS_PER_POSITION = 1_000;
const SMART_EXIT_REPLAY_MAX_TOTAL_EVALUATIONS =
  SMART_EXIT_REPLAY_MAX_POSITIONS * SMART_EXIT_REPLAY_MAX_EVALUATIONS_PER_POSITION;

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
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_evaluations_recent
      ON kalshi_smart_exit_evaluations (evaluated_at DESC)`);
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS kalshi_smart_exit_lifecycles (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK (owner IN ('regular','scalper')),
        position_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        ticker TEXT NOT NULL,
        triggered_at TIMESTAMPTZ NOT NULL,
        settled_at TIMESTAMPTZ,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (owner, position_id)
      )`);
    await client.query(`ALTER TABLE kalshi_smart_exit_lifecycles
      ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_lifecycles_recent
      ON kalshi_smart_exit_lifecycles (triggered_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS smart_exit_lifecycles_unsettled
      ON kalshi_smart_exit_lifecycles (triggered_at ASC) WHERE settled_at IS NULL`);
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
  const persisted = (result.rows[0]?.config ?? {}) as Partial<SmartExitConfig>;
  const selected = resolveSmartExitSensitivity(persisted.sensitivity);
  return {
    ...DEFAULT_SMART_EXIT_CONFIG,
    ...persisted,
    sensitivity: selected.sensitivity,
    debounceCount: selected.parameters.debounceCount,
    confirmationLevel: selected.parameters.confirmationLevel,
  };
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

/**
 * Loads bounded, owner-scoped position histories for advisory replay. Final
 * outcomes are intentionally absent: callers must obtain authoritative Kalshi
 * settlement separately rather than trusting inferred or cached bet outcomes.
 */
export async function listSmartExitReplaySources(params: {
  owner?: SmartExitOwnerKind;
  symbol?: string;
  limitPositions?: number;
} = {}): Promise<SmartExitReplaySource[]> {
  await ensureMigrated();
  const limit = Math.min(
    SMART_EXIT_REPLAY_MAX_POSITIONS,
    Math.max(1, params.limitPositions ?? SMART_EXIT_REPLAY_MAX_POSITIONS),
  );
  const result = await pool.query(`
    WITH positions AS (
      SELECT owner, position_id, MAX(evaluated_at) AS latest_at
      FROM kalshi_smart_exit_evaluations
      WHERE ($1::text IS NULL OR owner = $1)
        AND ($2::text IS NULL OR symbol = UPPER($2))
      GROUP BY owner, position_id
      ORDER BY latest_at DESC
      LIMIT $3
    ),
    ranked_evaluations AS (
      SELECT e.owner, e.position_id, e.evaluated_at, e.payload,
             ROW_NUMBER() OVER (
               PARTITION BY e.owner, e.position_id
               ORDER BY e.evaluated_at DESC
             ) AS sample_rank
      FROM kalshi_smart_exit_evaluations e
      INNER JOIN positions p
        ON p.owner = e.owner AND p.position_id = e.position_id
    )
    SELECT owner, position_id, payload
    FROM ranked_evaluations
    WHERE sample_rank <= $4
    ORDER BY owner, position_id, evaluated_at ASC
    LIMIT $5`,
  [
    params.owner ?? null,
    params.symbol ?? null,
    limit,
    SMART_EXIT_REPLAY_MAX_EVALUATIONS_PER_POSITION,
    SMART_EXIT_REPLAY_MAX_TOTAL_EVALUATIONS,
  ]);
  const histories = new Map<string, {
    owner: SmartExitOwnerKind;
    positionId: string;
    evaluations: SmartExitEvaluationRecord[];
  }>();
  for (const row of result.rows as Array<{
    owner: SmartExitOwnerKind;
    position_id: string;
    payload: SmartExitEvaluationRecord;
  }>) {
    const key = `${row.owner}:${row.position_id}`;
    let history = histories.get(key);
    if (!history) {
      history = { owner: row.owner, positionId: String(row.position_id), evaluations: [] };
      histories.set(key, history);
    }
    history.evaluations.push(row.payload);
  }
  const regularIds = [...histories.values()]
    .filter((item) => item.owner === "regular")
    .map((item) => item.positionId);
  const scalperIds = [...histories.values()]
    .filter((item) => item.owner === "scalper")
    .map((item) => item.positionId);
  const [regularResult, scalperResult] = await Promise.all([
    regularIds.length === 0 ? { rows: [] } : pool.query(`
      SELECT id, symbol, ticker, direction, created_at, contract_count, bet_amount,
             entry_yes_price
      FROM kalshi_bot_bets
      WHERE id = ANY($1::text[])`, [regularIds]),
    scalperIds.length === 0 ? { rows: [] } : pool.query(`
      SELECT id, symbol, ticker, side, created_at, filled_count,
             winning_contract_cost, avg_fill_price, entry_yes_price
      FROM kalshi_scalp_orders
      WHERE id = ANY($1::text[]) AND status = 'filled' AND filled_count > 0`,
    [scalperIds]),
  ]);
  const sourceRows = new Map<string, Record<string, unknown>>();
  for (const row of regularResult.rows as Array<Record<string, unknown>>) {
    sourceRows.set(`regular:${String(row.id)}`, row);
  }
  for (const row of scalperResult.rows as Array<Record<string, unknown>>) {
    sourceRows.set(`scalper:${String(row.id)}`, row);
  }
  const numberOrNull = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const sources: SmartExitReplaySource[] = [];
  for (const [key, history] of histories) {
    const row = sourceRows.get(key);
    const first = history.evaluations[0];
    if (!row || !first) continue;
    const ticker = String(row.ticker ?? first.ticker ?? "");
    const side = (row.direction ?? row.side ?? first.side) === "no" ? "no" : "yes";
    const quantity = history.owner === "regular"
      ? numberOrNull(row.contract_count)
      : numberOrNull(row.filled_count);
    const exactStake = history.owner === "regular"
      ? numberOrNull(row.bet_amount)
      : (() => {
          const winningCost = numberOrNull(row.winning_contract_cost);
          return winningCost !== null && quantity !== null ? winningCost * quantity : null;
        })();
    const fallbackYesPrice = numberOrNull(row.entry_yes_price)
      ?? numberOrNull(row.avg_fill_price);
    const fallbackWinningPrice = fallbackYesPrice === null
      ? first.marketAtEntryProbability
      : side === "yes" ? fallbackYesPrice : 1 - fallbackYesPrice;
    const entryStake = exactStake
      ?? (quantity !== null ? fallbackWinningPrice * quantity : null);
    const entryTimestampSeconds = new Date(String(row.created_at ?? "")).getTime() / 1_000;
    const firstAt = Date.parse(first.timestamp) / 1_000;
    const expiryTimestampSeconds = firstAt + first.secondsRemaining;
    if (!ticker || quantity === null || quantity <= 0 || entryStake === null
        || entryStake < 0 || !Number.isFinite(entryTimestampSeconds)
        || !Number.isFinite(expiryTimestampSeconds)) continue;
    sources.push({
      owner: history.owner,
      positionId: history.positionId,
      symbol: String(row.symbol ?? first.symbol).toUpperCase(),
      ticker,
      side,
      entryTimestampSeconds,
      expiryTimestampSeconds,
      entryContractCost: entryStake / quantity,
      quantity,
      evaluations: history.evaluations,
    });
  }
  return sources;
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

export async function getSmartExitEvaluationsByIds(
  ids: readonly string[],
): Promise<SmartExitEvaluationRecord[]> {
  await ensureMigrated();
  if (ids.length === 0) return [];
  const result = await pool.query(
    `SELECT payload FROM kalshi_smart_exit_evaluations WHERE id = ANY($1::text[])`,
    [ids],
  );
  return result.rows.map((row: { payload: SmartExitEvaluationRecord }) => row.payload);
}

/**
 * Returns the latest informative decision for each position. A healthy HOLD is
 * more useful for trigger coverage than the synthetic unavailable sample often
 * written as the market expires; unavailable is retained when it is all we saw.
 */
export async function listSmartExitCoverageEvaluations(params: {
  limit?: number;
} = {}): Promise<SmartExitEvaluationRecord[]> {
  await ensureMigrated();
  const positionLimit = Math.max(1, params.limit ?? 100);
  const sampleLimit = Math.min(10_000, Math.max(1_000, positionLimit * 50));
  const result = await pool.query(`
    SELECT payload FROM kalshi_smart_exit_evaluations
    ORDER BY evaluated_at DESC LIMIT $1`,
  [sampleLimit]);
  const selected = new Map<string, SmartExitEvaluationRecord>();
  for (const row of result.rows as Array<{ payload: SmartExitEvaluationRecord }>) {
    const evaluation = row.payload;
    const key = `${evaluation.owner}:${evaluation.positionId}`;
    const current = selected.get(key);
    if (!current || (current.recommendation === "unavailable" && evaluation.recommendation !== "unavailable")) {
      selected.set(key, evaluation);
    }
  }
  return [...selected.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, positionLimit);
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

/** Canonical global replay is addressed by immutable identity, never by recency. */
export async function getSmartExitReplayReportByIdentity(params: {
  owner: SmartExitOwnerKind;
  symbol: string;
  version: string;
}): Promise<SmartExitReplayReport | null> {
  await ensureMigrated();
  const result = await pool.query(`
    SELECT id, owner, symbol, version, status, payload, created_at
    FROM kalshi_smart_exit_replay_reports
    WHERE owner = $1 AND symbol = upper($2) AND version = $3
    LIMIT 1`,
  [params.owner, params.symbol, params.version]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? {
    id: String(row.id), owner: row.owner as SmartExitOwnerKind, symbol: String(row.symbol),
    version: String(row.version), status: row.status as SmartExitReportStatus,
    payload: row.payload as Record<string, unknown>, createdAt: row.created_at as Date,
  } : null;
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
    ON CONFLICT (owner, symbol, version) DO UPDATE SET
      status = EXCLUDED.status, payload = EXCLUDED.payload, created_at = NOW()`,
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

export async function upsertSmartExitLifecycle(record: SmartExitLifecycleRecord): Promise<void> {
  await ensureMigrated();
  await pool.query(`
    INSERT INTO kalshi_smart_exit_lifecycles
      (id,owner,position_id,symbol,ticker,triggered_at,settled_at,payload,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (owner,position_id) DO UPDATE SET
      settled_at=EXCLUDED.settled_at, payload=EXCLUDED.payload, updated_at=NOW()`,
  [record.id, record.owner, record.positionId, record.symbol, record.ticker,
    record.triggeredAt, record.settledAt, record]);
}

export async function getSmartExitLifecycle(
  owner: SmartExitOwnerKind, positionId: string,
): Promise<SmartExitLifecycleRecord | null> {
  await ensureMigrated();
  const result = await pool.query(
    `SELECT payload FROM kalshi_smart_exit_lifecycles WHERE owner=$1 AND position_id=$2`,
    [owner, positionId],
  );
  return (result.rows[0]?.payload as SmartExitLifecycleRecord | undefined) ?? null;
}

export async function listSmartExitLifecycles(limit = 100): Promise<SmartExitLifecycleRecord[]> {
  await ensureMigrated();
  const result = await pool.query(
    `SELECT payload FROM kalshi_smart_exit_lifecycles ORDER BY triggered_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  return result.rows.map((row: { payload: SmartExitLifecycleRecord }) => row.payload);
}

export async function listUnsettledSmartExitLifecycles(limit = 25): Promise<SmartExitLifecycleRecord[]> {
  await ensureMigrated();
  const result = await pool.query(
    `SELECT payload FROM kalshi_smart_exit_lifecycles
     WHERE settled_at IS NULL ORDER BY triggered_at ASC LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return result.rows.map((row: { payload: SmartExitLifecycleRecord }) => row.payload);
}