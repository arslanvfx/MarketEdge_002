export const REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS = 30_000;
// Restore the proven guarded cadence: conviction may retry, but never faster
// than the roughly five-second lifecycle that was stable before rapid retries.
export const CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS = 5_000;
export const REGULAR_MAX_ZERO_FILL_ATTEMPTS = 2;
export const CONVICTION_MAX_ZERO_FILL_ATTEMPTS = 10;

export function regularZeroFillRetryCooldownMs(decisionMode: string): number {
  return decisionMode === "conviction"
    ? CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS
    : REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS;
}

export function regularZeroFillMaxAttempts(decisionMode: string): number {
  return decisionMode === "conviction"
    ? CONVICTION_MAX_ZERO_FILL_ATTEMPTS
    : REGULAR_MAX_ZERO_FILL_ATTEMPTS;
}

export function regularZeroFillRetryKey(
  mode: "paper" | "live",
  symbol: string,
  windowKey: string,
): string {
  return `${mode}:${symbol.trim().toUpperCase()}:${windowKey.trim()}`;
}

export function regularZeroFillRetryRemainingMs(
  retryAfter: number | null | undefined,
  now = Date.now(),
): number {
  if (!Number.isFinite(retryAfter) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil(retryAfter! - now));
}

export function hasNewAuthenticatedBookVersion(
  previousVersion: string | null | undefined,
  candidateVersion: string | null | undefined,
): boolean {
  if (!candidateVersion) return false;
  return !previousVersion || candidateVersion !== previousVersion;
}