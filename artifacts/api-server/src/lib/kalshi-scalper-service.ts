// ---------------------------------------------------------------------------
// kalshi-scalper-service.ts — Isolated high-value Kalshi scalper service.
//
// Runs independently on a 1-second cadence.
// First authenticated quote used for guard/cap/balance work.
// A SECOND authenticated quote is fetched immediately before paper simulation
// and live placeOrder, re-checking all guards with fresh prices.
// Regular bot state read-only (mode only); regular positions never mutated.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { logger } from "./logger.ts";
import { CRYPTO_COINS, KALSHI_SERIES, currentWindowKey } from "./crypto.ts";
import { getKalshiCachedData, fetchOrderbookPrices, fetchKalshiTarget } from "./crypto-kalshi.ts";
// READ-ONLY imports from the protected regular-bot trader: balance + settlement
// reads only. The scalper's ORDER SUBMISSION path uses its own isolated exchange
// boundary (placeScalpOrderStrict) and NEVER imports/calls placeOrder.
import { getBalance, fetchKalshiMarketResult, fetchKalshiSettledMarkets } from "./kalshi-trader.ts";
import { placeScalpOrderStrict } from "./kalshi-scalper-exchange.ts";
import { getTicker } from "./crypto-data.ts";
import type { ScalpConfig, ScalpMode, ScalpOrder, ScalpIncident, ScalpPerformance, ScalpMarketStatus, ScalpPerMarketOverride } from "./kalshi-scalper-types.ts";
import { DEFAULT_SCALP_CONFIG } from "./kalshi-scalper-types.ts";
import {
  resolveEffectiveParams,
  selectScalpSide,
  isInFinalWindow,
  computeLimitPrice,
  winningCostFromFill,
  validateOrderbookQuote,
  checkFreefallGuard,
  computeScalpPnl,
  isFillWithinBand,
  classifyPlaceOrderResult,
  type PlaceOrderClassification,
  buildExecutionRiskSnapshot,
  compareRiskSnapshot,
  sizeOrderWithinReservedBudget,
  type FreefallSample,
  type ExecutionRiskSnapshot,
  type ScalpConfigPatch,
} from "./kalshi-scalper-policy.ts";
import {
  loadScalpConfigFromDB,
  saveScalpConfigToDB,
  runScalpMigrations,
  claimReservationAndCap,
  updateReservationStatus,
  countTodayReservations,
  insertScalpOrderIntent,
  finalizeScalpOrder,
  finalizeOrderAndReleaseReservation,
  abortIntentAndReleaseReservation,
  updateScalpOrderSettlement,
  setScalpOrderIncident,
  getSubmittingScalpOrders,
  getUnsettledScalpOrders,
  getScalpOrders,
  getTodayScalpSpend,
  getOpenScalpSpend,
  countUnresolvedLiveAttempts,
  getUnresolvedLiveAttempts,
  insertScalpIncident,
  getScalpIncidents,
} from "./kalshi-scalper-db.ts";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _config: ScalpConfig = { ...DEFAULT_SCALP_CONFIG };
let _running = false;
let _scanInterval: ReturnType<typeof setInterval> | null = null;
let _lastScanAt: number | null = null;
let _lastError: string | null = null;

// Per-symbol price samples for the scalper's own freefall guard (never shared)
const _priceSamples = new Map<string, FreefallSample[]>();
const MAX_PRICE_SAMPLES = 120;

// Read regular bot mode read-only for display metadata only.
function getRegularBotMode(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const state = require("./kalshi-bot-state") as { S?: { mode?: string } };
    return state?.S?.mode ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker — always set in-memory first, then persist
// ---------------------------------------------------------------------------

async function _tripCircuitBreaker(reason: string): Promise<void> {
  // Set in-memory immediately (fail-closed) before any async persist
  _config = { ..._config, circuitBreaker: true, circuitBreakerReason: reason };
  logger.error({ reason }, "[kalshi-scalper] CIRCUIT BREAKER TRIPPED — halting new scalp attempts");
  // Persist — never swallow failures silently
  try {
    await saveScalpConfigToDB(_config);
  } catch (persistErr) {
    // Keep in-memory breaker true; log loudly
    logger.error(
      { persistErr, reason },
      "[kalshi-scalper] CRITICAL: circuit breaker persist FAILED — breaker still active in memory",
    );
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initScalper(): Promise<void> {
  await runScalpMigrations();
  _config = await loadScalpConfigFromDB();
  logger.info(
    { enabled: _config.enabled, mode: _config.mode, circuitBreaker: _config.circuitBreaker },
    "[kalshi-scalper] initialized",
  );

  // Recover any submitting rows from a prior crash
  await _recoverSubmittingOrders().catch((err) =>
    logger.warn({ err }, "[kalshi-scalper] submitting-order recovery failed (non-fatal)"),
  );

  _startScanLoop();
  setInterval(() => { _evaluateSettlements().catch(() => {}); }, 30_000);
}

function _startScanLoop(): void {
  if (_scanInterval) clearInterval(_scanInterval);
  _scanInterval = setInterval(() => {
    _runScanTick().catch((err) =>
      logger.warn({ err }, "[kalshi-scalper] scan tick error (non-fatal)"),
    );
  }, 1_000);
  logger.info("[kalshi-scalper] scan loop started (1-second cadence)");
}

// ---------------------------------------------------------------------------
// Startup: recover stuck "submitting" rows
// ---------------------------------------------------------------------------

async function _recoverSubmittingOrders(): Promise<void> {
  const stuck = await getSubmittingScalpOrders();
  if (stuck.length === 0) return;
  for (const order of stuck) {
    logger.warn(
      { id: order.id, symbol: order.symbol, mode: order.mode },
      "[kalshi-scalper] found submitting order from prior crash — marking UNKNOWN, tripping breaker (reserved budget retained)",
    );
    // Mark order UNKNOWN (indeterminate fill), NOT error. Retain reserved budget.
    await finalizeScalpOrder(
      order.id, "unknown", 0, null, null, 0, null,
      "unknown_fill_state_after_crash",
    ).catch(() => {});
    // Mark reservation unknown WITHOUT releasing reserved budget (fail-closed).
    await updateReservationStatus(
      order.mode, order.symbol, order.windowKey, "unknown",
      "unknown_fill_state_after_crash", false,
    ).catch(() => {});
    // Create incident
    const incidentId = crypto.randomUUID();
    const incident: ScalpIncident = {
      id: incidentId,
      orderId: order.id,
      mode: order.mode,
      symbol: order.symbol,
      windowKey: order.windowKey,
      ticker: order.ticker,
      severity: "high",
      description: "Order found in submitting state after restart — fill status unknown",
      expectedBandMin: 0,
      expectedBandMax: 1,
      actualWinningCost: 0,
      createdAt: new Date(),
    };
    await insertScalpIncident(incident).catch(() => {});
    await setScalpOrderIncident(order.id, incidentId).catch(() => {});
    await _tripCircuitBreaker("submitting_order_found_after_restart");
  }
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

export function getScalpConfig(): ScalpConfig {
  return { ..._config };
}

/**
 * Apply a partial update. Persists the merged canonical config BEFORE replacing
 * in-memory. Validates both the partial input and the effective merged config.
 * Preserves explicit null values (dailyCapDollars/openCapDollars).
 * Never allows overwriting circuitBreaker via this path.
 */
/**
 * Merge a STRICTLY-PARSED, normalized config patch into the live config.
 *
 * The patch MUST already have been produced by parseScalpConfigPatch (typed,
 * range-checked, allowlisted). This function does no coercion; it only merges
 * present fields. circuitBreaker / circuitBreakerReason are never touched here
 * (breaker resets only via resetCircuitBreaker).
 */
export async function updateScalpConfig(patch: ScalpConfigPatch): Promise<ScalpConfig> {
  // Normalize parsed per-market overrides (number|null) into the stored
  // ScalpPerMarketOverride shape. Explicit null CLEARS that field (dropped);
  // absent fields are simply not set. The overrides array is fully replaced.
  let mergedOverrides = _config.perMarketOverrides;
  if (patch.perMarketOverrides !== undefined) {
    mergedOverrides = patch.perMarketOverrides.map((ov): ScalpPerMarketOverride => {
      const norm: ScalpPerMarketOverride = { symbol: ov.symbol };
      if (ov.paused !== undefined) norm.paused = ov.paused;
      if (typeof ov.minBand === "number") norm.minBand = ov.minBand;        // null → cleared
      if (typeof ov.maxBand === "number") norm.maxBand = ov.maxBand;        // null → cleared
      if (typeof ov.windowSeconds === "number") norm.windowSeconds = ov.windowSeconds;
      if (typeof ov.budgetDollars === "number") norm.budgetDollars = ov.budgetDollars;
      return norm;
    });
  }

  // Build the merged config (never touch circuitBreaker / circuitBreakerReason here)
  const merged: ScalpConfig = {
    ..._config,
    enabled: patch.enabled !== undefined ? patch.enabled : _config.enabled,
    mode: patch.mode !== undefined ? patch.mode : _config.mode,
    globalBandMin: patch.globalBandMin !== undefined ? patch.globalBandMin : _config.globalBandMin,
    globalBandMax: patch.globalBandMax !== undefined ? patch.globalBandMax : _config.globalBandMax,
    finalWindowSeconds: patch.finalWindowSeconds !== undefined ? patch.finalWindowSeconds : _config.finalWindowSeconds,
    budgetDollars: patch.budgetDollars !== undefined ? patch.budgetDollars : _config.budgetDollars,
    dailyCapDollars: patch.dailyCapDollars !== undefined ? patch.dailyCapDollars : _config.dailyCapDollars,
    openCapDollars: patch.openCapDollars !== undefined ? patch.openCapDollars : _config.openCapDollars,
    freefallGuardEnabled: patch.freefallGuardEnabled !== undefined ? patch.freefallGuardEnabled : _config.freefallGuardEnabled,
    freefallLookbackSeconds: patch.freefallLookbackSeconds !== undefined ? patch.freefallLookbackSeconds : _config.freefallLookbackSeconds,
    freefallThresholdPct: patch.freefallThresholdPct !== undefined ? patch.freefallThresholdPct : _config.freefallThresholdPct,
    perMarketOverrides: mergedOverrides,
    // Preserve circuit breaker state
    circuitBreaker: _config.circuitBreaker,
    circuitBreakerReason: _config.circuitBreakerReason,
  };

  // Cross-field: effective global band must remain valid after merge.
  if (merged.globalBandMin >= merged.globalBandMax) {
    throw new Error("Invalid scalp config: globalBandMin must be less than globalBandMax");
  }

  // Persist BEFORE replacing in-memory
  await saveScalpConfigToDB(merged);
  _config = merged;
  logger.info({ enabled: _config.enabled, mode: _config.mode }, "[kalshi-scalper] config updated");
  return { ..._config };
}

/** Error thrown when a breaker reset is refused due to unresolved live attempts. */
export class UnresolvedAttemptsError extends Error {
  readonly unresolvedCount: number;
  readonly details: Awaited<ReturnType<typeof getUnresolvedLiveAttempts>>;
  constructor(count: number, details: Awaited<ReturnType<typeof getUnresolvedLiveAttempts>>) {
    super(
      `Cannot reset circuit breaker: ${count} unresolved live attempt(s) with indeterminate fill state require authoritative manual reconciliation. No blind resolve is provided.`,
    );
    this.name = "UnresolvedAttemptsError";
    this.unresolvedCount = count;
    this.details = details;
  }
}

export async function resetCircuitBreaker(): Promise<ScalpConfig> {
  // REFUSE while any unresolved live attempt exists — an operator must
  // authoritatively reconcile (out-of-band) before resuming. Fail-closed.
  const unresolved = await countUnresolvedLiveAttempts();
  if (unresolved > 0) {
    const details = await getUnresolvedLiveAttempts();
    logger.error(
      { unresolved },
      "[kalshi-scalper] circuit breaker reset REFUSED — unresolved live attempts require reconciliation",
    );
    throw new UnresolvedAttemptsError(unresolved, details);
  }
  const updated = { ..._config, circuitBreaker: false, circuitBreakerReason: null };
  await saveScalpConfigToDB(updated);
  _config = updated;
  logger.info("[kalshi-scalper] circuit breaker reset");
  return { ..._config };
}

// ---------------------------------------------------------------------------
// Freefall guard price sample collection
// ---------------------------------------------------------------------------

/**
 * Collect one underlying price sample for a symbol.
 *
 * Returns true when a fresh, valid sample was appended; false when the fetch
 * failed or returned an unusable price. The boolean is AUTHORITATIVE: callers
 * that need a guaranteed-fresh sample (e.g. the final Freefall Guard) must treat
 * `false` as "no fresh data" and fail closed — existing old samples must NOT
 * mask a failed fresh fetch.
 */
async function _collectPriceSample(symbol: string, product: string): Promise<boolean> {
  try {
    const price = await getTicker(product);
    if (!Number.isFinite(price) || price <= 0) return false;
    const samples = _priceSamples.get(symbol) ?? [];
    samples.push({ price, at: Date.now() });
    if (samples.length > MAX_PRICE_SAMPLES) samples.splice(0, samples.length - MAX_PRICE_SAMPLES);
    _priceSamples.set(symbol, samples);
    return true;
  } catch {
    // Fetch failed — no fresh sample available.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main scan tick
// ---------------------------------------------------------------------------

async function _runScanTick(): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    await _doScanTick();
    _lastScanAt = Date.now();
    _lastError = null;
  } catch (err) {
    _lastError = String(err);
    throw err;
  } finally {
    _running = false;
  }
}

async function _doScanTick(): Promise<void> {
  if (!_config.enabled) return;
  if (_config.circuitBreaker) {
    logger.debug("[kalshi-scalper] circuit breaker active — scan suppressed");
    return;
  }

  const wk = currentWindowKey();
  if (!wk) return;

  const mode = _config.mode;

  // Collect freefall guard price samples for all active symbols
  for (const coin of CRYPTO_COINS) {
    if (KALSHI_SERIES[coin.symbol]) {
      _collectPriceSample(coin.symbol, coin.product).catch(() => {});
    }
  }

  // Quick scan using cached public quotes to find candidates
  const candidates = _findCandidates(wk);
  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    await _evaluateCandidate(candidate, wk, mode);
  }
}

interface Candidate {
  symbol: string;
  ticker: string;
  closeTime: string;
  cachedYesAsk: number | null;
  cachedNoAsk: number | null;
  side: "yes" | "no";
  winningAsk: number;
}

function _findCandidates(wk: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const coin of CRYPTO_COINS) {
    const sym = coin.symbol.toUpperCase();
    if (!KALSHI_SERIES[sym]) continue;

    const params = resolveEffectiveParams(_config, sym, "");
    if (params.paused) continue;

    const cached = getKalshiCachedData(sym);
    if (!cached?.ticker || !cached.closeTime) continue;

    // Quick timing check before expensive orderbook fetch
    if (!isInFinalWindow(cached.closeTime, Date.now(), params.finalWindowSeconds, wk)) continue;

    // Use cached quotes for initial candidate detection
    const yesAsk = cached.yesAsk ?? null;
    // noAsk from cache: noAsk = 1 - yesBid
    const yesBid = cached.yesBid ?? null;
    const noAsk = yesBid != null ? 1 - yesBid : null;

    const match = selectScalpSide(yesAsk, noAsk, params.bandMin, params.bandMax);
    if (!match) continue;

    candidates.push({
      symbol: sym,
      ticker: cached.ticker,
      closeTime: cached.closeTime,
      cachedYesAsk: yesAsk,
      cachedNoAsk: noAsk,
      side: match.side,
      winningAsk: match.winningAsk,
    });
  }

  return candidates;
}

/** Marker error: an order intent has been persisted (live submit crossed the
 *  fail-closed boundary). The outer catch must NOT release the reserved budget. */
class OrderIntentExistsError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`order intent exists — fail closed: ${String(cause)}`);
    this.name = "OrderIntentExistsError";
    this.cause = cause;
  }
}

/**
 * Marker error: a persistence failure occurred AFTER the broker call (i.e. the
 * finalize+release transaction threw). The reserved budget must be retained
 * (the failed transaction rolled back, so reserved_budget is unchanged) and the
 * outer catch must treat it exactly like OrderIntentExistsError — NEVER release.
 */
class PostSubmitPersistenceError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`post-submit persistence failed — fail closed: ${String(cause)}`);
    this.name = "PostSubmitPersistenceError";
    this.cause = cause;
  }
}

/**
 * Shared fail-closed handling for LIVE confirmed exposure with an indeterminate
 * outcome (placeOrder threw, OR a nonzero fill with an untrustworthy price, OR a
 * post-submit persistence failure). Never releases the reserved budget.
 *
 * Steps (each best-effort, breaker set FIRST and in-memory):
 *   1. Trip the circuit breaker (in-memory immediately, then persist).
 *   2. Best-effort mark the order UNKNOWN.
 *   3. Best-effort mark the reservation UNKNOWN WITHOUT release (release=false).
 *   4. Best-effort high-severity incident + link to the order.
 */
async function _handleUnknownExposure(args: {
  orderRecordId: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  bandMin: number;
  bandMax: number;
  reason: string;
  description: string;
}): Promise<void> {
  const { orderRecordId, mode, symbol, windowKey, ticker, bandMin, bandMax, reason, description } = args;

  // 1. Breaker first (fail-closed) — sets in-memory true synchronously.
  await _tripCircuitBreaker(reason);

  // 2. Best-effort mark the order UNKNOWN (do not throw on failure).
  await finalizeScalpOrder(
    orderRecordId, "unknown", 0, null, null, 0, null, description,
  ).catch((e) => logger.error({ e, orderRecordId }, "[kalshi-scalper] failed to mark order unknown (breaker already tripped)"));

  // 3. Best-effort mark reservation UNKNOWN WITHOUT releasing reserved budget.
  await updateReservationStatus(mode, symbol, windowKey, "unknown", description, false)
    .catch((e) => logger.error({ e, symbol, windowKey }, "[kalshi-scalper] failed to mark reservation unknown (budget retained)"));

  // 4. Best-effort incident.
  const incidentId = crypto.randomUUID();
  const incident: ScalpIncident = {
    id: incidentId,
    orderId: orderRecordId,
    mode,
    symbol,
    windowKey,
    ticker,
    severity: "high",
    description,
    expectedBandMin: bandMin,
    expectedBandMax: bandMax,
    actualWinningCost: 0,
    createdAt: new Date(),
  };
  await insertScalpIncident(incident).catch((e) => logger.error({ e, orderRecordId }, "[kalshi-scalper] failed to persist unknown-exposure incident"));
  await setScalpOrderIncident(orderRecordId, incidentId).catch(() => {});
}

async function _evaluateCandidate(
  candidate: Candidate,
  windowKey: string,
  mode: ScalpMode,
): Promise<void> {
  const { symbol, ticker, closeTime } = candidate;
  const params = resolveEffectiveParams(_config, symbol, ticker);

  // ── Pin the IMMUTABLE execution-risk snapshot at claim time ────────────────
  // Every sizing, cap, band, window, freefall and balance decision downstream
  // uses THIS snapshot. claimReservationAndCap reserves snapshot.budgetDollars.
  // We never atomically resize; any mid-flight change fails closed later.
  const snapshot: ExecutionRiskSnapshot = buildExecutionRiskSnapshot(
    _config,
    params,
    { symbol, windowKey, ticker, closeTime },
  );
  const budget = snapshot.budgetDollars;

  // ── ATOMIC claim + cap under a single per-mode advisory-locked transaction ──
  const reservationId = crypto.randomUUID();
  let claim: Awaited<ReturnType<typeof claimReservationAndCap>>;
  try {
    claim = await claimReservationAndCap(
      reservationId, mode, symbol, windowKey, ticker, budget,
      snapshot.dailyCapDollars, snapshot.openCapDollars,
    );
  } catch (err) {
    // Claim transaction failed BEFORE any order intent — safe to skip; no
    // reservation may exist (rolled back) or it exists as 'claimed' with 0 budget.
    _lastError = String(err);
    logger.warn({ err, symbol, windowKey, mode }, "[kalshi-scalper] claim-and-cap failed");
    return;
  }

  if (!claim.claimed) {
    return; // Duplicate — permanent, never retry.
  }
  if (!claim.allowed) {
    // Cap denied. Row already persisted 'skipped' with reserved_budget=0 in the
    // same transaction. One-attempt blocking preserved. Nothing else to do.
    logger.debug({ symbol, windowKey, reason: claim.reason }, "[kalshi-scalper] cap-denied, skipped");
    return;
  }

  // Reserved budget is now held atomically. Proceed to guards + submit,
  // pinned to the exact snapshot under which the budget was reserved.
  try {
    await _executeScalpAttempt(reservationId, candidate, windowKey, mode, snapshot);
  } catch (err) {
    _lastError = String(err);
    if (err instanceof OrderIntentExistsError || err instanceof PostSubmitPersistenceError) {
      // FAIL-CLOSED: the broker was (or may have been) called. Do NOT release
      // the reserved budget here. The unknown handling inside
      // _executeScalpAttempt already tripped the breaker / marked unknown.
      logger.error(
        { err: err.cause, kind: err.name, symbol, windowKey, mode },
        "[kalshi-scalper] post-intent failure — reserved budget retained (fail-closed)",
      );
      return;
    }
    // PRE-ORDER failure only: no intent persisted. Safe to release reservation.
    logger.warn({ err, symbol, windowKey, mode }, "[kalshi-scalper] pre-order attempt error — releasing reservation");
    await updateReservationStatus(mode, symbol, windowKey, "error", String(err), true).catch(() => {});
  }
}

/**
 * SYNCHRONOUS authoritative final validation. Contains NO await so it can run in
 * the same synchronous turn immediately before an intent write or a placeOrder
 * call, with zero opportunity for `_config` / the current window / cached market
 * identity to change between the check and the guarded action.
 *
 * Re-resolves the freshest `_config` + effective params and re-compares the
 * IMMUTABLE pinned snapshot; also requires: not disabled (via snapshot.enabled
 * diff), circuit breaker still false, and the current window/identity still
 * matching the reservation. Returns a machine reason string on ANY change, or
 * null when it is safe to proceed.
 */
function _finalRiskValidationSync(
  snapshot: ExecutionRiskSnapshot,
  windowKey: string,
  symbol: string,
  ticker: string,
): string | null {
  // Breaker must still be off.
  if (_config.circuitBreaker) return "breaker_before_submit";

  // Window identity must still be current.
  const wkNow = currentWindowKey();
  if (!wkNow || wkNow !== windowKey) return "window_expired_before_submit";

  // Cached market identity must still match the reserved candidate exactly.
  const cached = getKalshiCachedData(symbol);
  if (!cached?.ticker || !cached.closeTime) return "identity_missing_before_submit";
  if (cached.ticker !== ticker || cached.closeTime !== snapshot.closeTime) {
    return "identity_changed_before_submit";
  }

  // Full immutable-snapshot diff against the freshest config + params.
  const params = resolveEffectiveParams(_config, symbol, ticker);
  const diff = compareRiskSnapshot(
    snapshot,
    _config,
    params,
    { symbol, windowKey, ticker, closeTime: cached.closeTime },
  );
  if (!diff.unchanged) return diff.reason ?? "risk_changed";

  // Refreshed close time must still fall in the current window.
  if (!isInFinalWindow(cached.closeTime, Date.now(), snapshot.finalWindowSeconds, wkNow)) {
    return "outside_window_before_submit";
  }

  return null;
}

async function _executeScalpAttempt(
  reservationId: string,
  candidate: Candidate,
  windowKey: string,
  mode: ScalpMode,
  snapshot: ExecutionRiskSnapshot,
): Promise<void> {
  const { symbol, ticker, closeTime, side: initialSide } = candidate;

  // ── FIRST authenticated orderbook fetch — for guards/caps/balance ─────────
  const ob1 = await fetchOrderbookPrices(ticker);
  const quote1 = ob1 ? validateOrderbookQuote(ob1, ticker, closeTime) : null;

  if (!quote1) {
    logger.warn({ symbol, ticker }, "[kalshi-scalper] first orderbook quote invalid — skipping");
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "first_quote_invalid", true);
    return;
  }

  // Re-check band and side from first quote — using PINNED snapshot band.
  const match1 = selectScalpSide(quote1.yesAsk, quote1.noAsk, snapshot.bandMin, snapshot.bandMax);
  if (!match1) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "first_quote_outside_band", true);
    return;
  }

  // Side must not flip from initial candidate
  if (match1.side !== initialSide) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "side_flipped_first_quote", true);
    return;
  }

  // ── Early freefall guard (uses PINNED snapshot config) ────────────────────
  // EARLY reject only; the authoritative freefall check runs at the final
  // pre-submit boundary against a guaranteed-fresh sample (below). Fail closed:
  // when enabled, skip on BLOCKED *and* on UNAVAILABLE (not evaluable).
  if (snapshot.freefallGuardEnabled) {
    const samples = _priceSamples.get(symbol) ?? [];
    const ffResult = checkFreefallGuard(
      samples,
      match1.side,
      Date.now(),
      snapshot.freefallLookbackSeconds * 1000,
      snapshot.freefallThresholdPct,
    );
    if (!ffResult.evaluable || ffResult.blocked) {
      logger.info(
        { symbol, side: match1.side, evaluable: ffResult.evaluable, reason: ffResult.reason, adverseMovePct: ffResult.adverseMovePct },
        "[kalshi-scalper] freefall guard skip (early)",
      );
      await updateReservationStatus(mode, symbol, windowKey, "skipped", ffResult.reason ?? "freefall_blocked", true);
      return;
    }
  }

  // NOTE: cap checks are NOT repeated here. They were performed atomically
  // inside claimReservationAndCap under the per-mode advisory lock, which
  // reserved snapshot.budgetDollars. Re-running getTodayScalpCommitted +
  // checkDailyCap here would double-count and reintroduce a cross-process race.

  // Sizing/exposure ALWAYS uses the durable reserved amount, never a re-resolved
  // params2 budget. This is the authoritative value throughout.
  const reservedBudget = snapshot.budgetDollars;

  // ── Early balance check (live mode only) ─────────────────────────────────
  // Non-authoritative pre-flight only; the final balance check (against actual
  // worst-case submit exposure) runs at the pre-submit boundary below.
  if (mode === "live") {
    try {
      const balance = await getBalance();
      if (balance.availableBalance < reservedBudget) {
        logger.warn({ symbol, available: balance.availableBalance, reservedBudget }, "[kalshi-scalper] insufficient balance (early) — skipping");
        await updateReservationStatus(mode, symbol, windowKey, "skipped", "insufficient_balance", true);
        return;
      }
    } catch (err) {
      logger.warn({ err, symbol }, "[kalshi-scalper] balance check failed (early) — skipping");
      await updateReservationStatus(mode, symbol, windowKey, "skipped", "balance_check_failed", true);
      return;
    }
  }

  // ── FINAL PRE-SUBMIT BOUNDARY ─────────────────────────────────────────────
  // Re-fetch immediately before paper simulation AND live submit. We re-resolve
  // the freshest config + effective params and compare the ENTIRE pinned
  // snapshot; any change fails closed BEFORE any order intent is written.

  if (_config.circuitBreaker) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "breaker_before_submit", true);
    return;
  }

  // Confirm window identity still matches
  const wkNow = currentWindowKey();
  if (!wkNow || wkNow !== windowKey) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "window_expired_before_submit", true);
    return;
  }

  // ── Force-refresh current market identity immediately before second book ───
  // Re-resolve the authoritative ticker/closeTime for this symbol+window and
  // require an EXACT match with the reserved candidate. This guards against the
  // cache pointing at an adjacent/pre-published market by the time we submit.
  try {
    await fetchKalshiTarget(symbol, new Date(closeTime), true);
  } catch (err) {
    logger.warn({ err, symbol }, "[kalshi-scalper] identity force-refresh failed — skipping permanently");
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_refresh_failed", true);
    return;
  }
  const refreshed = getKalshiCachedData(symbol);
  if (!refreshed?.ticker || !refreshed.closeTime) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_missing_after_refresh", true);
    return;
  }
  if (refreshed.ticker !== ticker || refreshed.closeTime !== closeTime) {
    logger.info(
      { symbol, reservedTicker: ticker, refreshedTicker: refreshed.ticker },
      "[kalshi-scalper] market identity changed after refresh — skipping permanently",
    );
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_changed", true);
    return;
  }

  // ── EARLY reject: DIFF freshest config/params against pinned snapshot ───────
  // This is an EARLY optimisation only — it lets us bail cheaply before the
  // second orderbook / freefall-sample / balance awaits. The AUTHORITATIVE
  // final validation runs synchronously AFTER all those awaits (and again after
  // live intent creation, immediately before placeOrder). ANY risk field change
  // (budget, caps, band, window, freefall, paused, enabled, mode) or identity
  // change → permanent skip + release BEFORE any intent.
  const params2 = resolveEffectiveParams(_config, symbol, ticker);
  const diff = compareRiskSnapshot(
    snapshot,
    _config,
    params2,
    { symbol, windowKey, ticker, closeTime: refreshed.closeTime },
  );
  if (!diff.unchanged) {
    logger.info(
      { symbol, windowKey, changed: diff.changedFields },
      "[kalshi-scalper] risk snapshot changed mid-flight (early) — skipping permanently (fail-closed, no resize)",
    );
    await updateReservationStatus(mode, symbol, windowKey, "skipped", diff.reason ?? "risk_changed", true);
    return;
  }

  // Confirm the refreshed close time still falls in the current window (uses
  // the PINNED window seconds — already verified unchanged by the diff above).
  if (!isInFinalWindow(refreshed.closeTime, Date.now(), snapshot.finalWindowSeconds, wkNow)) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_outside_window", true);
    return;
  }

  // ── SECOND authenticated orderbook for the CONFIRMED ticker ────────────────
  const ob2 = await fetchOrderbookPrices(ticker);
  const quote2 = ob2 ? validateOrderbookQuote(ob2, ticker, closeTime) : null;

  if (!quote2) {
    logger.warn({ symbol, ticker }, "[kalshi-scalper] second orderbook quote invalid — skipping");
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "second_quote_invalid", true);
    return;
  }

  // Revalidate window with second quote (pinned window seconds).
  if (!isInFinalWindow(quote2.closeTime, Date.now(), snapshot.finalWindowSeconds, wkNow)) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "outside_window_second_quote", true);
    return;
  }

  // Band selection uses the PINNED snapshot band (verified unchanged above).
  const match2 = selectScalpSide(quote2.yesAsk, quote2.noAsk, snapshot.bandMin, snapshot.bandMax);
  if (!match2) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "second_quote_outside_band", true);
    return;
  }

  // Side must remain consistent with initial candidate
  if (match2.side !== initialSide) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", "side_flipped_second_quote", true);
    return;
  }

  const effectiveSide = match2.side;
  const winningAsk = match2.winningAsk;

  // ── FINAL FREEFALL GUARD — authoritative, at the exact pre-submit boundary ─
  // Fail closed: an AUTHORITATIVE fresh sample is REQUIRED. A failed fresh fetch
  // is "unavailable" and skips — existing old samples must NOT mask it. Then the
  // guard must be evaluable AND not blocked to proceed.
  if (snapshot.freefallGuardEnabled) {
    const coin = CRYPTO_COINS.find((c) => c.symbol.toUpperCase() === symbol);
    if (!coin) {
      // No underlying product to sample → cannot evaluate → fail closed.
      await updateReservationStatus(mode, symbol, windowKey, "skipped", "freefall_unavailable_no_product", true);
      return;
    }
    const collected = await _collectPriceSample(coin.symbol, coin.product);
    if (!collected) {
      // Fresh fetch failed; do NOT fall back to stale samples.
      logger.info(
        { symbol, side: effectiveSide },
        "[kalshi-scalper] freefall final sample fetch failed — unavailable, skipping (fail-closed)",
      );
      await updateReservationStatus(mode, symbol, windowKey, "skipped", "freefall_unavailable_fetch_failed", true);
      return;
    }
    const samplesFinal = _priceSamples.get(symbol) ?? [];
    const ffFinal = checkFreefallGuard(
      samplesFinal,
      effectiveSide,
      Date.now(),
      snapshot.freefallLookbackSeconds * 1000,
      snapshot.freefallThresholdPct,
    );
    if (!ffFinal.evaluable || ffFinal.blocked) {
      logger.info(
        { symbol, side: effectiveSide, evaluable: ffFinal.evaluable, reason: ffFinal.reason, adverseMovePct: ffFinal.adverseMovePct, samplesUsed: ffFinal.samplesUsed },
        "[kalshi-scalper] freefall guard skip (final boundary)",
      );
      await updateReservationStatus(mode, symbol, windowKey, "skipped", ffFinal.reason ?? "freefall_blocked_final", true);
      return;
    }
  }

  // ── Size the order STRICTLY within the durable reserved budget ─────────────
  // Contract count = floor(reservedBudget / cappedWinningAsk); worst-case
  // exposure (count * cappedWinningAsk) is guaranteed <= reservedBudget.
  const sized = sizeOrderWithinReservedBudget(reservedBudget, winningAsk, snapshot.bandMax);
  if (!sized.ok) {
    await updateReservationStatus(mode, symbol, windowKey, "skipped", sized.reason ?? "sizing_failed", true);
    return;
  }
  const { contractCount, cappedWinningAsk, maxExposure } = sized;

  // ── FINAL live balance check against ACTUAL worst-case submit exposure ─────
  if (mode === "live") {
    try {
      const balanceFinal = await getBalance();
      if (balanceFinal.availableBalance < maxExposure) {
        logger.warn(
          { symbol, available: balanceFinal.availableBalance, maxExposure, contractCount, cappedWinningAsk },
          "[kalshi-scalper] insufficient balance for worst-case exposure (final) — skipping",
        );
        await updateReservationStatus(mode, symbol, windowKey, "skipped", "insufficient_balance_final", true);
        return;
      }
    } catch (err) {
      logger.warn({ err, symbol }, "[kalshi-scalper] final balance check failed — skipping");
      await updateReservationStatus(mode, symbol, windowKey, "skipped", "balance_check_failed_final", true);
      return;
    }
  }

  // ── AUTHORITATIVE FINAL VALIDATION (post-await) ───────────────────────────
  // Every awaited pre-submit step (second orderbook, freefall sample, sizing,
  // final balance) is now complete. Re-run the SYNCHRONOUS authoritative check
  // AFTER all that async work so a config/window/identity change during those
  // awaits fails closed here — before any intent is written or fill simulated.
  const finalReason1 = _finalRiskValidationSync(snapshot, windowKey, symbol, ticker);
  if (finalReason1 !== null) {
    logger.info(
      { symbol, windowKey, reason: finalReason1 },
      "[kalshi-scalper] authoritative final validation failed (post-await) — skipping permanently",
    );
    await updateReservationStatus(mode, symbol, windowKey, "skipped", finalReason1, true);
    return;
  }

  // Compute limitPrice for placeOrder (always YES-side)
  const limitPrice = computeLimitPrice(effectiveSide, cappedWinningAsk);
  // entry_yes_price = the YES-side price at entry
  const entryYesPrice = effectiveSide === "yes" ? cappedWinningAsk : 1 - cappedWinningAsk;

  // ── Place order or simulate ───────────────────────────────────────────────
  const orderId_pre = mode === "paper" ? `paper-${crypto.randomUUID()}` : null;

  // For live: persist "submitting" intent BEFORE the exchange call
  const orderRecord: ScalpOrder = {
    id: crypto.randomUUID(),
    mode,
    symbol,
    windowKey,
    ticker,
    side: effectiveSide,
    entryYesPrice,
    contractCount,
    budgetSpent: 0,
    orderId: orderId_pre,
    filledCount: 0,
    avgFillPrice: null,
    limitPrice,
    winningContractCost: null,
    status: mode === "paper" ? "paper" : "submitting",
    errorMessage: null,
    settlementResult: null,
    outcome: null,
    pnl: null,
    incidentId: null,
    createdAt: new Date(),
    settledAt: null,
  };

  let filledCount = 0;
  let avgFillPrice: number | null = null;
  let orderId: string | null = orderId_pre;
  let orderError: string | null = null;
  // Live outcome comes pre-classified from the strict exchange parser.
  let liveOutcome: PlaceOrderClassification = "unknown";

  if (mode === "paper") {
    // ── Paper post-await final validation (no intent exists yet) ──────────────
    // Simulating a fill is the paper equivalent of "submitting", so re-validate
    // synchronously immediately before it.
    const finalReasonPaper = _finalRiskValidationSync(snapshot, windowKey, symbol, ticker);
    if (finalReasonPaper !== null) {
      logger.info(
        { symbol, windowKey, reason: finalReasonPaper },
        "[kalshi-scalper] paper final validation failed before simulate — skipping permanently",
      );
      await updateReservationStatus(mode, symbol, windowKey, "skipped", finalReasonPaper, true);
      return;
    }
    // Paper: simulate full fill at capped winning ask; avgFillPrice is YES-side
    filledCount = contractCount;
    avgFillPrice = effectiveSide === "yes" ? cappedWinningAsk : 1 - cappedWinningAsk;
    logger.info(
      { symbol, side: effectiveSide, count: contractCount, winningAsk: cappedWinningAsk, limitPrice, avgFillPrice, windowKey },
      "[kalshi-scalper] PAPER order simulated",
    );
  } else {
    // ── Live: persist the "submitting" intent BEFORE the exchange call ────────
    // insertScalpOrderIntent is awaited, so config could change DURING it.
    await insertScalpOrderIntent(orderRecord);

    // ── FINAL synchronous re-validation AFTER intent creation, IMMEDIATELY ────
    // before placeOrder. There MUST be no await between this successful check and
    // the placeOrder call expression below. If it fails, the never-submitted
    // intent is atomically marked skipped and the reservation released (no broker
    // was called → RESOLVED, not unknown), then we abort before any exchange call.
    const finalReasonLive = _finalRiskValidationSync(snapshot, windowKey, symbol, ticker);
    if (finalReasonLive !== null) {
      logger.info(
        { symbol, windowKey, reason: finalReasonLive },
        "[kalshi-scalper] live final validation failed after intent, before submit — aborting intent + releasing (no broker call)",
      );
      await abortIntentAndReleaseReservation({
        orderId: orderRecord.id, mode, symbol, windowKey,
        reason: `aborted_before_submit:${finalReasonLive}`,
      });
      return;
    }

    // Live: submit via the SCALPER-OWNED exchange boundary (never placeOrder).
    // Uses immediate_or_cancel + taker_at_cross with the exact YES-side
    // limitPrice, and STRICTLY parses the raw response (no zero-coercion).
    // NOTE: no await occurs between the successful check above and this call.
    try {
      const result = await placeScalpOrderStrict({
        ticker,
        side: effectiveSide,
        limitPrice,
        count: contractCount,
      });
      // Strict parser already discriminated the outcome. A malformed body maps
      // to outcome "unknown" (never zero-coerced); use its validated fields.
      liveOutcome = result.outcome;
      filledCount = result.filledCount ?? NaN; // null (unknown) → NaN sentinel
      avgFillPrice = result.avgFillPrice; // YES-side fraction or null
      orderId = result.orderId;
      logger.info(
        { symbol, side: effectiveSide, contractCount, outcome: result.outcome, reason: result.reason, filledCount: result.filledCount, avgFillPrice, limitPrice, windowKey },
        "[kalshi-scalper] LIVE order submitted (strict)",
      );
    } catch (err) {
      orderError = String(err);
      logger.error({ err, symbol, ticker, side: effectiveSide }, "[kalshi-scalper] LIVE strict submit THREW — fill state UNKNOWN");

      // Submit threw — fill state INDETERMINATE. Mark order UNKNOWN (not
      // error), keep the reservation's reserved budget (do NOT release), create
      // a high-severity incident, and trip the breaker. Never infer a fill.
      await _handleUnknownExposure({
        orderRecordId: orderRecord.id,
        mode, symbol, windowKey, ticker,
        bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
        reason: `scalp_submit_threw:${symbol}:${windowKey}`,
        description: `scalp submit threw (fill state unknown): ${orderError}`,
      });
      // Signal the outer catch to NOT release budget (fail-closed).
      throw new OrderIntentExistsError(err);
    }
  }

  // ── EXACT result classification (fail-closed) ─────────────────────────────
  // LIVE outcomes come pre-classified from the strict parser (authoritative).
  // Paper always simulates a valid (0,1) fill; route it through the classifier
  // (with requestedCount) so behavior is uniform and tested.
  const classification =
    mode === "live"
      ? (liveOutcome as PlaceOrderClassification)
      : classifyPlaceOrderResult({ filledCount, avgFillPrice, requestedCount: contractCount });

  // ── (3) UNKNOWN CONFIRMED EXPOSURE: filled>0 but price null/nonfinite/OOB ──
  if (classification === "unknown") {
    if (mode === "live") {
      // Fail closed: mark unknown, retain reserved budget, incident, breaker.
      await _handleUnknownExposure({
        orderRecordId: orderRecord.id,
        mode, symbol, windowKey, ticker,
        bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
        reason: `unknown_confirmed_exposure:${symbol}:${windowKey}`,
        description:
          `Confirmed exposure with indeterminate fill price: filledCount=${filledCount} avgFillPrice=${String(avgFillPrice)}. ` +
          `Reserved budget retained; manual reconciliation required.`,
      });
    } else {
      // Paper cannot reach here in practice (simulated price is always valid),
      // but if it did there is NO broker exposure — record explicitly + release.
      logger.error(
        { symbol, windowKey, filledCount, avgFillPrice },
        "[kalshi-scalper] PAPER unexpected unknown classification — recording error + releasing reservation",
      );
      await insertScalpOrderIntent({
        ...orderRecord, status: "error", filledCount, avgFillPrice, orderId,
        errorMessage: `paper_unknown_classification: filledCount=${filledCount} avgFillPrice=${String(avgFillPrice)}`,
      }).catch(() => {});
      await updateReservationStatus(mode, symbol, windowKey, "error", "paper_unknown_classification", true).catch(() => {});
    }
    // Never continue past a confirmed-exposure unknown.
    return;
  }

  // ── (1) Definite zero fill (filledCount === 0; avg may be null) ────────────
  if (classification === "zero_fill") {
    if (mode === "live") {
      // Atomic: finalize intent zero_fill + release reservation in one txn.
      // Post-submit persistence MUST fail closed — no .catch swallowing.
      try {
        await finalizeOrderAndReleaseReservation({
          orderId: orderRecord.id, mode, symbol, windowKey,
          status: "zero_fill", reservationStatus: "zero_fill",
          filledCount: 0, avgFillPrice: null, winningContractCost: null,
          budgetSpent: 0, exchangeOrderId: orderId, reason: "zero_fill",
        });
      } catch (persistErr) {
        // Broker returned zero fill, but we failed to persist that fact. The
        // transaction rolled back → reserved budget is intact. Fail closed:
        // do NOT release; trip breaker; best-effort mark unknown.
        await _onPostSubmitPersistenceFailure(persistErr, {
          orderRecordId: orderRecord.id, mode, symbol, windowKey, ticker,
          bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
          context: "zero_fill_finalize_failed",
        });
        throw new PostSubmitPersistenceError(persistErr);
      }
    } else {
      // Paper: no broker exposure. Persist zero-fill record + release. Explicit.
      await insertScalpOrderIntent({ ...orderRecord, status: "zero_fill", orderId }).catch(() => {});
      await updateReservationStatus(mode, symbol, windowKey, "zero_fill", "zero_fill", true).catch(() => {});
    }
    return;
  }

  // ── (2) CONFIRMED FILL: filledCount>0 AND avgFillPrice finite in (0,1) ─────
  // (classification === "confirmed_fill"; avgFillPrice is narrowed non-null.)
  const confirmedAvg = avgFillPrice as number;
  const withinBand = isFillWithinBand(effectiveSide, confirmedAvg, snapshot.bandMin, snapshot.bandMax);
  const winningContractCost = winningCostFromFill(effectiveSide, confirmedAvg);
  const actualSpent = winningContractCost * filledCount;
  const finalStatus = mode === "paper" ? "paper" as const : "filled" as const;

  if (mode === "live") {
    // Atomic: finalize intent filled + release reservation in one txn.
    // Post-submit persistence MUST fail closed — no .catch swallowing.
    try {
      await finalizeOrderAndReleaseReservation({
        orderId: orderRecord.id, mode, symbol, windowKey,
        status: finalStatus, reservationStatus: "filled",
        filledCount, avgFillPrice: confirmedAvg, winningContractCost,
        budgetSpent: actualSpent, exchangeOrderId: orderId, reason: null,
      });
    } catch (persistErr) {
      // Contracts were bought but we failed to persist the fill + release. The
      // transaction rolled back → reserved budget intact. Fail closed.
      await _onPostSubmitPersistenceFailure(persistErr, {
        orderRecordId: orderRecord.id, mode, symbol, windowKey, ticker,
        bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
        context: "fill_finalize_failed",
      });
      throw new PostSubmitPersistenceError(persistErr);
    }
  } else {
    // Paper: no broker exposure. Persist filled record + release. Explicit.
    await insertScalpOrderIntent({
      ...orderRecord,
      status: finalStatus,
      filledCount,
      avgFillPrice: confirmedAvg,
      winningContractCost,
      budgetSpent: actualSpent,
      orderId,
    }).catch(() => {});
    await updateReservationStatus(mode, symbol, windowKey, "filled", undefined, true).catch(() => {});
  }

  // ── Out-of-band fill → incident + circuit breaker ────────────────────────
  if (!withinBand) {
    const incidentId = crypto.randomUUID();
    const incident: ScalpIncident = {
      id: incidentId,
      orderId: orderRecord.id,
      mode,
      symbol,
      windowKey,
      ticker,
      severity: "high",
      description: `Winning-contract cost ${winningContractCost.toFixed(4)} outside band [${snapshot.bandMin}, ${snapshot.bandMax}] for ${effectiveSide} side`,
      expectedBandMin: snapshot.bandMin,
      expectedBandMax: snapshot.bandMax,
      actualWinningCost: winningContractCost,
      createdAt: new Date(),
    };
    // Never swallow incident persist failures
    await insertScalpIncident(incident);
    await setScalpOrderIncident(orderRecord.id, incidentId).catch(() => {});
    await _tripCircuitBreaker(
      `fill_outside_band:${symbol}:${effectiveSide}:cost=${winningContractCost.toFixed(4)}:band=[${snapshot.bandMin},${snapshot.bandMax}]`,
    );
  }
}

/**
 * Post-submit persistence failure handler. Called when a LIVE
 * finalizeOrderAndReleaseReservation transaction throws AFTER the broker call.
 *
 * Contract: the failed transaction rolled back, so reserved_budget is unchanged
 * (retained). This function MUST NOT release the reservation. It trips the
 * breaker (in-memory first), best-effort marks the intent + reservation unknown
 * WITHOUT release, and best-effort records an incident. It never throws — the
 * caller re-throws PostSubmitPersistenceError so the outer catch stops scanning.
 */
async function _onPostSubmitPersistenceFailure(
  err: unknown,
  args: {
    orderRecordId: string;
    mode: ScalpMode;
    symbol: string;
    windowKey: string;
    ticker: string;
    bandMin: number;
    bandMax: number;
    context: string;
  },
): Promise<void> {
  logger.error(
    { err, ...args },
    "[kalshi-scalper] POST-SUBMIT persistence FAILED — reserved budget retained, failing closed",
  );
  await _handleUnknownExposure({
    orderRecordId: args.orderRecordId,
    mode: args.mode,
    symbol: args.symbol,
    windowKey: args.windowKey,
    ticker: args.ticker,
    bandMin: args.bandMin,
    bandMax: args.bandMax,
    reason: `post_submit_persist_failed:${args.context}:${args.symbol}:${args.windowKey}`,
    description: `Post-submit persistence failed (${args.context}): ${String(err)}. Reserved budget retained; manual reconciliation required.`,
  }).catch((e) =>
    logger.error({ e, ...args }, "[kalshi-scalper] CRITICAL: unknown-exposure handling itself failed after post-submit persist failure"),
  );
}

// ---------------------------------------------------------------------------
// Settlement evaluation
// ---------------------------------------------------------------------------

async function _evaluateSettlements(): Promise<void> {
  try {
    const unsettled = await getUnsettledScalpOrders();
    for (const order of unsettled) {
      await _settleOrder(order).catch((err) =>
        logger.warn({ err, id: order.id }, "[kalshi-scalper] settle order error (non-fatal)"),
      );
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-scalper] settlement eval error (non-fatal)");
  }
}

async function _settleOrder(order: ScalpOrder): Promise<void> {
  const result = await fetchKalshiMarketResult(order.ticker).catch(() => null);
  if (result?.result === "yes" || result?.result === "no") {
    await _applySettlement(order, result.result);
    return;
  }
  const series = order.ticker.split("-")[0];
  if (series) {
    const settled = await fetchKalshiSettledMarkets(series, 50).catch(
      (): Array<{ ticker: string; result: "yes" | "no"; closeTime: string; floorStrike: number }> => [],
    );
    const match = settled.find((m) => m.ticker === order.ticker);
    if (match) {
      await _applySettlement(order, match.result);
    }
  }
}

async function _applySettlement(order: ScalpOrder, result: "yes" | "no"): Promise<void> {
  if (order.avgFillPrice == null) return;
  const pnl = computeScalpPnl(order.mode, order.side, order.filledCount, order.avgFillPrice, result);
  const outcome: "win" | "loss" = pnl >= 0 ? "win" : "loss";
  await updateScalpOrderSettlement(order.id, result, outcome, pnl);
  logger.info(
    { id: order.id, symbol: order.symbol, side: order.side, result, outcome, pnl },
    "[kalshi-scalper] order settled",
  );
}

// ---------------------------------------------------------------------------
// Market status snapshot (for GET /status markets array)
// ---------------------------------------------------------------------------

function _buildMarketStatuses(wk: string): ScalpMarketStatus[] {
  return CRYPTO_COINS
    .filter((c) => KALSHI_SERIES[c.symbol])
    .map((coin) => {
      const sym = coin.symbol.toUpperCase();
      const params = resolveEffectiveParams(_config, sym, "");
      const cached = getKalshiCachedData(sym);
      const yesAsk = cached?.yesAsk ?? null;
      const yesBid = cached?.yesBid ?? null;
      const noAsk = yesBid != null ? 1 - yesBid : null;
      const closeTime = cached?.closeTime ?? null;
      const secondsRemaining = closeTime
        ? Math.max(0, (new Date(closeTime).getTime() - Date.now()) / 1000)
        : null;
      const inWindow = closeTime != null
        ? isInFinalWindow(closeTime, Date.now(), params.finalWindowSeconds, wk)
        : false;

      let freefallBlocked = false;
      let reason: string | null = null;
      const match = yesAsk != null || noAsk != null
        ? selectScalpSide(yesAsk, noAsk, params.bandMin, params.bandMax)
        : null;

      // lastAsk = the SELECTED winning-contract ask (or null when out of band).
      const lastAsk = match ? match.winningAsk : null;

      if (match && _config.freefallGuardEnabled && inWindow) {
        const samples = _priceSamples.get(sym) ?? [];
        const ff = checkFreefallGuard(
          samples, match.side, Date.now(),
          _config.freefallLookbackSeconds * 1000, _config.freefallThresholdPct,
        );
        // Unavailable (not evaluable) is a fail-closed skip, NOT a clear signal:
        // surface it as blocked with its unavailability reason so the UI does not
        // imply the guard is passing when it actually cannot evaluate.
        freefallBlocked = ff.blocked || !ff.evaluable;
        reason = ff.reason;
      }

      // state: 'active' when it's a live in-window in-band candidate.
      let state: ScalpMarketStatus["state"];
      if (params.paused) { state = "paused"; reason = reason ?? "paused"; }
      else if (yesAsk == null && noAsk == null) { state = "no_quote"; reason = reason ?? "no_quote"; }
      else if (!match) { state = "out_of_band"; reason = reason ?? "out_of_band"; }
      else if (inWindow) { state = "active"; }
      else { state = "ready"; reason = reason ?? "awaiting_final_window"; }

      return {
        symbol: sym,
        state,
        effectiveBandMin: params.bandMin,
        effectiveBandMax: params.bandMax,
        effectiveWindowSeconds: params.finalWindowSeconds,
        effectiveBudgetDollars: params.budgetDollars,
        lastAsk,
        secondsRemaining: secondsRemaining != null ? Math.round(secondsRemaining) : null,
        freefallBlocked,
        reason,
      };
    });
}

// ---------------------------------------------------------------------------
// Public read APIs
// ---------------------------------------------------------------------------

/** Serialize an order to the exact shape the frontend ScalpOrder type expects.
 *  Exposes `error` (alias of errorMessage) and includes winningContractCost.
 *  Dates are ISO strings. outcome is 'open' when filled but unsettled. */
function serializeScalpOrder(o: ScalpOrder) {
  const filledUnsettled = o.filledCount > 0 && o.outcome == null && o.settlementResult == null;
  return {
    id: o.id,
    mode: o.mode,
    symbol: o.symbol,
    windowKey: o.windowKey,
    ticker: o.ticker,
    side: o.side,
    entryYesPrice: o.entryYesPrice,
    contractCount: o.contractCount,
    budgetSpent: o.budgetSpent,
    orderId: o.orderId,
    filledCount: o.filledCount,
    avgFillPrice: o.avgFillPrice,
    limitPrice: o.limitPrice,
    winningContractCost: o.winningContractCost,
    status: o.status,
    error: o.errorMessage,          // frontend alias
    errorMessage: o.errorMessage,   // keep original too
    settlementResult: o.settlementResult,
    outcome: filledUnsettled ? "open" : o.outcome,
    pnl: o.pnl,
    incidentId: o.incidentId,
    createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
    settledAt: o.settledAt instanceof Date ? o.settledAt.toISOString() : o.settledAt,
  };
}

export async function getScalpStatus(requestedMode?: ScalpMode) {
  const mode = requestedMode ?? _config.mode;
  const wk = currentWindowKey() ?? "";
  const [dailySpend, openSpend, recentOrders, incidents, todayRes] = await Promise.all([
    getTodayScalpSpend(mode),
    getOpenScalpSpend(mode),
    getScalpOrders({ mode, limit: 20 }),
    getScalpIncidents(10),
    countTodayReservations(mode),
  ]);

  const markets = _buildMarketStatuses(wk);

  return {
    config: { ..._config },
    circuitBreaker: _config.circuitBreaker,
    circuitBreakerReason: _config.circuitBreakerReason,
    mode,
    totalReservationsToday: todayRes,
    openSpend,
    dailySpend,
    recentOrders: recentOrders.map(serializeScalpOrder),
    incidents,
    // ISO string | null (not epoch)
    lastScanAt: _lastScanAt != null ? new Date(_lastScanAt).toISOString() : null,
    lastError: _lastError,
    markets,
    regularBotMode: getRegularBotMode(),
  };
}

export async function getScalpHistory(opts: { mode?: ScalpMode; symbol?: string; limit?: number }) {
  const orders = await getScalpOrders(opts);
  return { orders: orders.map(serializeScalpOrder), total: orders.length };
}

export async function getScalpPerformance(mode: ScalpMode): Promise<ScalpPerformance> {
  const orders = await getScalpOrders({ mode, limit: 2000 });

  const filled = orders.filter((o) => o.filledCount > 0);
  const settled = filled.filter((o) => o.outcome != null);
  const wins = settled.filter((o) => o.outcome === "win").length;
  const losses = settled.filter((o) => o.outcome === "loss").length;
  const totalPnl = settled.reduce((s, o) => s + (o.pnl ?? 0), 0);
  const totalSpent = filled.reduce((s, o) => s + o.budgetSpent, 0);
  const fillPrices = filled.filter((o) => o.avgFillPrice != null).map((o) => o.avgFillPrice!);
  const avgFillPrice = fillPrices.length > 0
    ? fillPrices.reduce((a, b) => a + b, 0) / fillPrices.length
    : null;

  const bySymbolMap = new Map<string, {
    orders: number; wins: number; losses: number; settled: number;
    pnl: number; spent: number; fillPrices: number[];
  }>();
  for (const o of filled) {
    if (!bySymbolMap.has(o.symbol)) {
      bySymbolMap.set(o.symbol, { orders: 0, wins: 0, losses: 0, settled: 0, pnl: 0, spent: 0, fillPrices: [] });
    }
    const s = bySymbolMap.get(o.symbol)!;
    s.orders++;
    s.spent += o.budgetSpent;
    if (o.avgFillPrice != null) s.fillPrices.push(o.avgFillPrice);
    if (o.outcome === "win") { s.wins++; s.settled++; s.pnl += o.pnl ?? 0; }
    if (o.outcome === "loss") { s.losses++; s.settled++; s.pnl += o.pnl ?? 0; }
  }

  const bySymbol = Array.from(bySymbolMap.entries()).map(([symbol, s]) => ({
    symbol,
    orders: s.orders,
    wins: s.wins,
    losses: s.losses,
    settled: s.settled,
    winRate: s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : null,
    pnl: s.pnl,
    spent: s.spent,
    avgFillPrice: s.fillPrices.length > 0
      ? s.fillPrices.reduce((a, b) => a + b, 0) / s.fillPrices.length
      : null,
  }));

  return {
    mode,
    totalOrders: orders.length,
    filledOrders: filled.length,
    settled: settled.length,   // frontend field name (was settledOrders)
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    totalPnl,
    totalSpent,
    avgFillPrice,
    bySymbol,
  };
}

// Re-export the unresolved query for route/reconciliation display.
export async function getUnresolvedLiveScalpAttempts() {
  return getUnresolvedLiveAttempts();
}

export async function applyScalpConfigUpdate(patch: ScalpConfigPatch): Promise<ScalpConfig> {
  return updateScalpConfig(patch);
}
