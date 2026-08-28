export const DASHBOARD2_OWNERS = ["current_bot", "dashboard2_bot", "paused"] as const;
export type Dashboard2ExecutionOwner = (typeof DASHBOARD2_OWNERS)[number];

export function isDashboard2ExecutionOwner(value: unknown): value is Dashboard2ExecutionOwner {
  return typeof value === "string" &&
    (DASHBOARD2_OWNERS as readonly string[]).includes(value);
}