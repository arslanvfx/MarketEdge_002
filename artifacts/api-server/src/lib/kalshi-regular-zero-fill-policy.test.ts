import assert from "node:assert/strict";
import test from "node:test";
import {
  REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS,
  regularZeroFillRetryKey,
  regularZeroFillRetryRemainingMs,
} from "./kalshi-regular-zero-fill-policy.ts";

test("zero-fill retry ownership is isolated by mode, symbol, and window", () => {
  assert.equal(
    regularZeroFillRetryKey("live", " doge ", "2026-08-28T03:00"),
    "live:DOGE:2026-08-28T03:00",
  );
  assert.notEqual(
    regularZeroFillRetryKey("live", "DOGE", "2026-08-28T03:00"),
    regularZeroFillRetryKey("paper", "DOGE", "2026-08-28T03:00"),
  );
  assert.notEqual(
    regularZeroFillRetryKey("live", "DOGE", "2026-08-28T03:00"),
    regularZeroFillRetryKey("live", "DOGE", "2026-08-28T03:15"),
  );
});

test("authoritative zero-fill cooldown blocks through 29.999s and opens at 30s", () => {
  const startedAt = 1_000_000;
  const retryAfter = startedAt + REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS;
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, startedAt), 30_000);
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, retryAfter - 1), 1);
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, retryAfter), 0);
});