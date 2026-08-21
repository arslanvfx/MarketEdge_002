import { pool } from "@workspace/db";

export interface ScalpAdminState {
  hasAdmin: boolean;
  isAdmin: boolean;
}

export type InitialAdminClaimResult =
  | { status: "claimed" | "already_admin"; state: ScalpAdminState }
  | { status: "unavailable"; state: ScalpAdminState };

interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

type AdminStateRow = {
  has_admin: boolean;
  is_admin: boolean;
};

const normalizeUserId = (userId: string): string => {
  const normalized = userId.trim();
  if (normalized === "") {
    throw new Error("Authenticated user id is required");
  }
  return normalized;
};

/**
 * Reads the current user's role and whether any Scalper admin exists.
 * Identity values never leave this server-side store.
 */
export async function getScalpAdminState(
  userId: string,
  queryable: Queryable = pool,
): Promise<ScalpAdminState> {
  const normalized = normalizeUserId(userId);
  const result = await queryable.query<AdminStateRow>(
    `SELECT
       EXISTS (
         SELECT 1
           FROM scalper_user_roles
          WHERE role = 'admin'
       ) AS has_admin,
       EXISTS (
         SELECT 1
           FROM scalper_user_roles
          WHERE role = 'admin' AND clerk_user_id = $1
       ) AS is_admin`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Unable to read Scalper administrator state");
  }
  return {
    hasAdmin: row.has_admin === true,
    isAdmin: row.is_admin === true,
  };
}

/**
 * Atomically claims the initial administrator role.
 *
 * The database's partial unique index on bootstrap_admin=true is the lock. Only
 * one concurrent insert can succeed. A repeated request from the winning user
 * is idempotent; every other caller is denied once the role has been claimed.
 */
export async function claimInitialScalpAdmin(
  userId: string,
  queryable: Queryable = pool,
): Promise<InitialAdminClaimResult> {
  const normalized = normalizeUserId(userId);
  const inserted = await queryable.query<{ clerk_user_id: string }>(
    `INSERT INTO scalper_user_roles
       (clerk_user_id, role, bootstrap_admin, created_by)
     VALUES ($1, 'admin', true, $1)
     ON CONFLICT DO NOTHING
     RETURNING clerk_user_id`,
    [normalized],
  );

  if ((inserted.rowCount ?? inserted.rows.length) === 1) {
    return {
      status: "claimed",
      state: { hasAdmin: true, isAdmin: true },
    };
  }

  const state = await getScalpAdminState(normalized, queryable);
  return {
    status: state.isAdmin ? "already_admin" : "unavailable",
    state,
  };
}