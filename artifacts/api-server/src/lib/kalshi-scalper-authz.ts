// ---------------------------------------------------------------------------
// kalshi-scalper-authz.ts — Pure, fail-closed authorization decision for
// scalper MUTATION routes (POST config, POST reset-circuit-breaker).
//
// SECURITY MODEL (fail-closed):
//   - No signed-in Clerk user             → 401 (unauthenticated)
//   - No administrator has been claimed   → 403 (claim route only)
//   - Signed in without the admin role     → 403 (not authorized)
//   - Signed in with the persisted role    → allow
//
// This module is scalper-only. It does NOT read regular-bot state or modify any
// regular-bot behavior.
// ---------------------------------------------------------------------------

export type ScalpAuthzStatus = 401 | 403 | 200;

export interface ScalpAdminState {
  hasAdmin: boolean;
  isAdmin: boolean;
}

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
   *  - "bootstrap_available"
   *  - "not_authorized"
   *  - "authorized"
   */
  reason:
    | "unauthenticated"
    | "bootstrap_available"
    | "not_authorized"
    | "authorized";
}

export interface ScalpMutationCapability {
  canManage: boolean;
  canClaimAdmin: boolean;
  reason: ScalpAuthzDecision["reason"];
  message: string | null;
}

/**
 * Pure authorization decision for scalper mutations. Fail-closed by construction.
 *
 * @param userId The authenticated Clerk user id (getAuth(req).userId) or null/undefined.
 * @param adminState Persisted server-side role state for this user.
 */
export function decideScalpMutationAuthz(
  userId: string | null | undefined,
  adminState: ScalpAdminState,
): ScalpAuthzDecision {
  const user = typeof userId === "string" ? userId.trim() : "";

  // 1) Must be signed in.
  if (user === "") {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized — must be signed in",
      reason: "unauthenticated",
    };
  }

  // 2) The bootstrap endpoint is the only path allowed before an admin exists.
  if (!adminState.hasAdmin) {
    return {
      allowed: false,
      status: 403,
      error:
        "Forbidden — no Scalper administrator has been claimed",
      reason: "bootstrap_available",
    };
  }

  // 3) The authenticated user must hold the persisted admin role.
  if (!adminState.isAdmin) {
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
  adminState: ScalpAdminState,
): ScalpMutationCapability {
  const decision = decideScalpMutationAuthz(userId, adminState);
  return {
    canManage: decision.allowed,
    canClaimAdmin:
      decision.reason === "bootstrap_available" &&
      typeof userId === "string" &&
      userId.trim() !== "",
    reason: decision.reason,
    message: decision.error,
  };
}
