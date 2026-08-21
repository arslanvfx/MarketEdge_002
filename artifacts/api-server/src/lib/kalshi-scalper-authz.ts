// ---------------------------------------------------------------------------
// kalshi-scalper-authz.ts — Pure, fail-closed authorization decision for
// scalper MUTATION routes (POST config, POST reset-circuit-breaker).
//
// SECURITY MODEL (fail-closed):
//   - No signed-in Clerk user            → 401 (unauthenticated)
//   - Operator identity NOT configured   → 403 (writes denied until configured)
//   - Configured but userId != admin id  → 403 (not authorized)
//   - Configured AND exact match         → allow
//
// The previous guard was FAIL-OPEN: when BOT_ADMIN_CLERK_USER_ID was unset, any
// signed-in user could mutate the scalper. This module makes the decision pure
// and fail-closed so it can be unit tested directly and cannot silently open.
//
// This module is scalper-only. It does NOT read regular-bot state or modify any
// regular-bot behavior.
// ---------------------------------------------------------------------------

export type ScalpAuthzStatus = 401 | 403 | 200;

export interface ScalpAuthzDecision {
  /** true only for an exact authorized match. */
  allowed: boolean;
  /** HTTP status to send when !allowed (200 when allowed). */
  status: ScalpAuthzStatus;
  /** Client-facing error message when !allowed (null when allowed). */
  error: string | null;
  /**
   * Machine-readable reason for logging/tests. One of:
   *  - "unauthenticated"
   *  - "operator_not_configured"
   *  - "not_authorized"
   *  - "authorized"
   */
  reason:
    | "unauthenticated"
    | "operator_not_configured"
    | "not_authorized"
    | "authorized";
}

export interface ScalpMutationCapability {
  canManage: boolean;
  reason: ScalpAuthzDecision["reason"];
  message: string | null;
}

/**
 * Pure authorization decision for scalper mutations. Fail-closed by construction.
 *
 * @param userId  The authenticated Clerk user id (getAuth(req).userId) or null/undefined.
 * @param adminId The configured operator id (process.env.BOT_ADMIN_CLERK_USER_ID) or undefined.
 *
 * Both inputs are treated as opaque strings; surrounding whitespace is ignored,
 * and blank/empty values are treated as "absent".
 */
export function decideScalpMutationAuthz(
  userId: string | null | undefined,
  adminId: string | null | undefined,
): ScalpAuthzDecision {
  const user = typeof userId === "string" ? userId.trim() : "";
  const admin = typeof adminId === "string" ? adminId.trim() : "";

  // 1) Must be signed in.
  if (user === "") {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized — must be signed in",
      reason: "unauthenticated",
    };
  }

  // 2) Operator identity must be configured (fail-closed when unset/blank).
  if (admin === "") {
    return {
      allowed: false,
      status: 403,
      error:
        "Forbidden — operator authorization is not configured; scalper writes are disabled until an operator identity is set",
      reason: "operator_not_configured",
    };
  }

  // 3) Must be an EXACT match.
  if (user !== admin) {
    return {
      allowed: false,
      status: 403,
      error: "Forbidden — not authorized to control the scalper",
      reason: "not_authorized",
    };
  }

  // 4) Authorized.
  return { allowed: true, status: 200, error: null, reason: "authorized" };
}

/**
 * Safe client-facing capability projection. It deliberately exposes neither
 * the configured operator id nor the signed-in user id.
 */
export function getScalpMutationCapability(
  userId: string | null | undefined,
  adminId: string | null | undefined,
): ScalpMutationCapability {
  const decision = decideScalpMutationAuthz(userId, adminId);
  return {
    canManage: decision.allowed,
    reason: decision.reason,
    message: decision.error,
  };
}
