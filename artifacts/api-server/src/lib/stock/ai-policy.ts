// Single stock-AI gating policy.
//
// Invariant: ALL Claude usage in the stock vertical (bot research gating,
// scheduled scanner research, exit re-checks) must flow through this policy —
// the user-facing `aiEnabled` config toggle AND the platform spend guard must
// BOTH permit it. Never check the spend guard alone: that lets scheduled jobs
// keep spending after the user disables AI.

/** Pure core — unit-testable without config/db imports. */
export function stockAiPermitted(aiEnabled: boolean | undefined, spendGuardAllows: boolean): boolean {
  return aiEnabled !== false && spendGuardAllows;
}
