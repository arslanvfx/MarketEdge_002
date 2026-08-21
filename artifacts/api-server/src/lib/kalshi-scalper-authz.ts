// ---------------------------------------------------------------------------
// kalshi-scalper-authz.ts — Authorization decision for Scalper mutations.
//
// Scalper controls intentionally use the same access policy as the rest of the
// bot: any authenticated app session may operate the bot. This module remains
// pure so that a missing or malformed auth identity still fails closed.
// ---------------------------------------------------------------------------

export type ScalpAuthzStatus = 401 | 200;

export interface ScalpAuthzDecision {
  allowed: boolean;
  status: ScalpAuthzStatus;
  error: string | null;
  reason: "unauthenticated" | "authorized";
}

export interface ScalpMutationCapability {
  canManage: boolean;
  reason: ScalpAuthzDecision["reason"];
  message: string | null;
}

export function decideScalpMutationAuthz(
  userId: string | null | undefined,
): ScalpAuthzDecision {
  const user = typeof userId === "string" ? userId.trim() : "";
  if (user === "") {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized — must be signed in",
      reason: "unauthenticated",
    };
  }
  return {
    allowed: true,
    status: 200,
    error: null,
    reason: "authorized",
  };
}

/**
 * Safe client-facing projection. The response does not expose Clerk identities.
 */
export function getScalpMutationCapability(
  userId: string | null | undefined,
): ScalpMutationCapability {
  const decision = decideScalpMutationAuthz(userId);
  return {
    canManage: decision.allowed,
    reason: decision.reason,
    message: decision.error,
  };
}