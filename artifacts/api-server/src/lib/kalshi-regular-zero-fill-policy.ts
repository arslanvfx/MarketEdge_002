export const REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS = 30_000;

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