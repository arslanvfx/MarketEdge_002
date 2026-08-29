import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS,
  CONVICTION_MAX_ZERO_FILL_ATTEMPTS,
  REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS,
  REGULAR_MAX_ZERO_FILL_ATTEMPTS,
  regularZeroFillRetryCooldownMs,
  regularZeroFillMaxAttempts,
  regularZeroFillRetryKey,
  regularZeroFillRetryRemainingMs,
  hasNewAuthenticatedBookVersion,
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

test("conviction retry requires a genuinely newer authenticated book version", () => {
  assert.equal(hasNewAuthenticatedBookVersion(undefined, "sid-9:seq-101"), true);
  assert.equal(hasNewAuthenticatedBookVersion("sid-9:seq-100", "sid-9:seq-101"), true);
  assert.equal(hasNewAuthenticatedBookVersion("sid-9:seq-101", "sid-9:seq-101"), false);
  assert.equal(hasNewAuthenticatedBookVersion("sid-9:seq-101", ""), false);
});

test("authoritative regular zero-fill cooldown blocks through 29.999s and opens at 30s", () => {
  const startedAt = 1_000_000;
  const retryAfter = startedAt + REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS;
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, startedAt), 30_000);
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, retryAfter - 1), 1);
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, retryAfter), 0);
});

test("conviction retries use the guarded five-second cadence and bounded attempts", () => {
  const startedAt = 1_000_000;
  const cooldown = regularZeroFillRetryCooldownMs("conviction");
  assert.equal(cooldown, CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS);
  const retryAfter = startedAt + cooldown;
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, startedAt), 5_000);
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, retryAfter - 1), 1);
  assert.equal(regularZeroFillRetryRemainingMs(retryAfter, retryAfter), 0);
  assert.equal(regularZeroFillRetryCooldownMs("ml_gate"), REGULAR_ZERO_FILL_RETRY_COOLDOWN_MS);
  assert.equal(regularZeroFillMaxAttempts("conviction"), CONVICTION_MAX_ZERO_FILL_ATTEMPTS);
  assert.equal(CONVICTION_MAX_ZERO_FILL_ATTEMPTS, 10);
  assert.equal(regularZeroFillMaxAttempts("ml_gate"), REGULAR_MAX_ZERO_FILL_ATTEMPTS);
});