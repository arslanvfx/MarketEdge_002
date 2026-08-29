export const REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS = 30_000;
export const CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS = 30_000;
export const REGULAR_MAX_ZERO_FILL_ATTEMPTS = 2;
// Conviction is a fast-moving price-band strategy. A confirmed zero fill ends
// the symbol's entry attempt for that window: retrying later can act on a
// materially different book even when the original poller signal still looks
// in-range.
export const CONVICTION_MAX_ZERO_FILL_ATTEMPTS = 1;

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