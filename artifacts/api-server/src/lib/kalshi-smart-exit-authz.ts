export interface SmartExitCapability {
  canManage: boolean;
  reason: "unauthenticated" | "forbidden" | "authorized";
  message: string | null;
}

export function getSmartExitMutationCapability(
  userId: string | null | undefined,
  adminUserId: string | null | undefined = process.env["BOT_ADMIN_CLERK_USER_ID"],
): SmartExitCapability {
  const authorized = typeof userId === "string" && userId.trim().length > 0;
  if (!authorized) return {
        canManage: false,
        reason: "unauthenticated",
        message: "Sign in to manage Smart Exit. Read-only status remains available.",
      };
  if (adminUserId && userId !== adminUserId) return {
    canManage: false,
    reason: "forbidden",
    message: "This account is not authorized to manage Smart Exit.",
  };
  return { canManage: true, reason: "authorized", message: null };
}