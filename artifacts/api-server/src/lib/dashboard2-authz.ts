export type Dashboard2OperatorDecision = "allowed" | "unauthenticated" | "forbidden";

const OPERATOR_ROLES = new Set(["admin", "operator", "trading_operator"]);

function normalizedRole(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function claimRole(claims: unknown): string | null {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const record = claims as Record<string, unknown>;
  const containers = [
    record,
    record["metadata"],
    record["publicMetadata"],
    record["public_metadata"],
  ];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const role = normalizedRole((container as Record<string, unknown>)["role"]);
    if (role) return role;
  }
  return null;
}

function configuredOperators(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * Live-capable controls fail closed unless the signed-in user is explicitly
 * named server-side or carries an operator/admin role in verified Clerk claims.
 */
export function decideDashboard2OperatorAuthz(input: {
  userId: string | null | undefined;
  sessionClaims?: unknown;
  configuredUserIds?: string | undefined;
}): Dashboard2OperatorDecision {
  if (!input.userId) return "unauthenticated";
  if (configuredOperators(input.configuredUserIds).has(input.userId)) return "allowed";
  const role = claimRole(input.sessionClaims);
  return role && OPERATOR_ROLES.has(role) ? "allowed" : "forbidden";
}