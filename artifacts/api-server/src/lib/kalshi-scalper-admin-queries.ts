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

export interface ScalpAdminQueryable {
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

export async function getScalpAdminStateWithQuery(
  userId: string,
  queryable: ScalpAdminQueryable,
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

export async function claimInitialScalpAdminWithQuery(
  userId: string,
  queryable: ScalpAdminQueryable,
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

  const state = await getScalpAdminStateWithQuery(normalized, queryable);
  return {
    status: state.isAdmin ? "already_admin" : "unavailable",
    state,
  };
}