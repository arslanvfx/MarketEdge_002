// Isolated execution lifecycle for the optional contrarian spike experiment.
// The normal Scalper only supplies the exact existing final-guard decision and
// fresh revalidation callbacks. This module owns its own config, caps, intent,
// order, incident, reconciliation, settlement, and reporting state.
import crypto from "crypto";
import { logger } from "./logger.ts";
import {
  ContrarianExposureRegistry,
  DEFAULT_CONTRARIAN_CONFIG,
  computeContrarianFillSpend,
  computeContrarianPnl,
  evaluateContrarianGuardEligibility,
  planContrarianOrder,
  replayContrarianGuardOutcomeRows,
  validateContrarianConfig,
  type ContrarianConfig,
  type ContrarianConfigPatch,
  type ContrarianOrderPlan,
  type ContrarianSide,
} from "./kalshi-scalper-contrarian.ts";
import {
  claimContrarianReservation,
  finalizeContrarianFilled,
  finalizeContrarianPaper,
  finalizeContrarianUnknown,
  finalizeContrarianZeroFill,
  getActiveContrarianExposures,
  getContrarianOrder,
  getContrarianOrders,
  getContrarianGuardOutcomeStudyReport,
  getPendingContrarianGuardOutcomeStudyOutbox,
  getContrarianReportCounts,
  getContrarianTotals,
  getRecentContrarianIncidents,
  getRecentContrarianObservations,
  getUnknownContrarianOrders,
  getUnsettledContrarianOrders,
  getUnsettledContrarianGuardOutcomeStudies,
  hasNormalScalpExposure,
  insertContrarianOrderIntent,
  loadContrarianConfigRecord,
  recordContrarianObservation,
  recordContrarianGuardOutcomeStudy,
  releaseContrarianReservation,
  runContrarianMigrations,
  saveContrarianConfig,
  settleContrarianOrder,
  settleContrarianGuardOutcomeStudy,
  type ContrarianConfigRecord,
  type ContrarianObservation,
  type ContrarianOrder,
  type ContrarianReservation,
  type ContrarianGuardOutcomeStudyInput,
} from "./kalshi-scalper-contrarian-db.ts";
import {
  placeScalpOrderStrict,
  reconcileScalpOrderStrict,
} from "./kalshi-scalper-exchange.ts";
import {
  fetchKalshiMarketResult,
  fetchKalshiSettledMarkets,
  getBalance,
} from "./kalshi-trader.ts";
import type { FreefallPreSubmitDecision } from "./kalshi-scalper-policy.ts";
import type {
  ScalpGuardOutcomeStudyRecoveryPayload,
  ScalpMode,
} from "./kalshi-scalper-types.ts";

export interface ContrarianFreshGuardContext {
  ok: boolean;
  reason: string | null;
  decision: FreefallPreSubmitDecision | null;
  yesAsk: number | null;
  noAsk: number | null;
  targetPrice: number | null;
  closeTime: string | null;
  evidence: Record<string, unknown>;
}

export interface ContrarianTriggerInput {
  sourceMode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  closeTime: string;
  protectedSide: ContrarianSide;
  decision: FreefallPreSubmitDecision;
  /**
   * Force-refreshes identity + authenticated orderbook, collects a fresh
   * underlying sample, and reruns the existing pinned final guard.
   */
  refreshAndRevalidate: () => Promise<ContrarianFreshGuardContext>;
  /**
   * Synchronous final identity/window/regular-exposure/guard boundary. It is
   * called immediately before the intent and again immediately before POST.
   */
  finalValidationSync: () => string | null;
}

interface ConfigSnapshot {
  version: number;
  config: ContrarianConfig;
}

let configRecord: ContrarianConfigRecord = {
  config: { ...DEFAULT_CONTRARIAN_CONFIG },
  updatedAt: new Date(0),
  version: 0,
};
let breakerLatchedInMemory = false;
let breakerReasonInMemory: string | null = null;
let breakerGeneration = 0;
let configTail: Promise<void> = Promise.resolve();
const attemptsInFlight = new Set<string>();
const recentObservationKeys = new Map<string, number>();
const lastReconcileAt = new Map<string, number>();
const lastSettlementAt = new Map<string, number>();
const lastGuardOutcomeSettlementAt = new Map<string, number>();
const RECONCILE_INTERVAL_MS = 30_000;
const SETTLEMENT_INTERVAL_MS = 20_000;

export const contrarianExposureRegistry = new ContrarianExposureRegistry();

let regularExposureSync: (
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  ticker: string,
) => boolean = () => true;

export function setContrarianRegularExposureReader(
  reader: typeof regularExposureSync,
): void {
  regularExposureSync = reader;
}

function effectiveConfig(): ContrarianConfig {
  return {
    ...configRecord.config,
    circuitBreaker: breakerLatchedInMemory,
    circuitBreakerReason: breakerReasonInMemory,
  };
}

function enqueueConfigWork<T>(work: () => Promise<T>): Promise<T> {
  const result = configTail.then(work, work);
  configTail = result.then(() => undefined, () => undefined);
  return result;
}

async function persistConfigMutation(
  mutate: (current: ContrarianConfig) => ContrarianConfig,
): Promise<ContrarianConfigRecord> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await loadContrarianConfigRecord();
    const next = mutate({
      ...current.config,
      circuitBreaker: breakerLatchedInMemory,
      circuitBreakerReason: breakerReasonInMemory,
    });
    const errors = validateContrarianConfig(next);
    if (errors.length) throw new Error(errors.join("; "));
    const saved = await saveContrarianConfig(next, current.version);
    if (saved) {
      configRecord = saved;
      return saved;
    }
  }
  throw new Error("contrarian config changed concurrently; retry the update");
}

export async function initContrarianExperiment(): Promise<void> {
  await runContrarianMigrations();
  configRecord = await loadContrarianConfigRecord();
  const configErrors = validateContrarianConfig(configRecord.config);
  if (configErrors.length) {
    logger.error(
      { errors: configErrors },
      "[kalshi-scalper-contrarian] invalid persisted config; disabling experiment",
    );
    configRecord.config = {
      ...DEFAULT_CONTRARIAN_CONFIG,
      circuitBreakerEnabled: true,
      circuitBreaker: true,
      circuitBreakerReason: "invalid_persisted_config",
    };
  }
  breakerLatchedInMemory = configRecord.config.circuitBreaker;
  breakerReasonInMemory = configRecord.config.circuitBreakerReason;
  contrarianExposureRegistry.replace(await getActiveContrarianExposures());
  const unresolved = await getUnknownContrarianOrders();
  if (unresolved.length > 0) {
    await tripContrarianBreaker("unresolved_submission_recovered");
  }
}

export function getContrarianConfig(): ContrarianConfig {
  return { ...effectiveConfig() };
}

export async function updateContrarianConfig(
  patch: ContrarianConfigPatch,
): Promise<ContrarianConfig> {
  return enqueueConfigWork(async () => {
    await persistConfigMutation((current) => ({
      ...current,
      ...patch,
      circuitBreaker: breakerLatchedInMemory,
      circuitBreakerReason: breakerReasonInMemory,
    }));
    return getContrarianConfig();
  });
}

async function tripContrarianBreaker(reason: string): Promise<void> {
  breakerGeneration += 1;
  breakerLatchedInMemory = true;
  breakerReasonInMemory = reason;
  await enqueueConfigWork(async () => {
    await persistConfigMutation((current) => ({
      ...current,
      circuitBreaker: true,
      circuitBreakerReason: reason,
    }));
  });
}

export async function resetContrarianBreaker(): Promise<ContrarianConfig> {
  return enqueueConfigWork(async () => {
    const resetGeneration = breakerGeneration;
    const unresolved = await getUnknownContrarianOrders();
    if (unresolved.length > 0) {
      throw new Error(
        "Cannot reset the contrarian breaker while a live submission is unresolved",
      );
    }
    if (resetGeneration !== breakerGeneration) {
      throw new Error("A newer contrarian incident occurred during reset");
    }
    await persistConfigMutation((current) => ({
      ...current,
      circuitBreaker: false,
      circuitBreakerReason: null,
    }));
    if (resetGeneration !== breakerGeneration) {
      await persistConfigMutation((current) => ({
        ...current,
        circuitBreaker: true,
        circuitBreakerReason: breakerReasonInMemory,
      }));
      throw new Error("A newer contrarian incident occurred during reset");
    }
    breakerLatchedInMemory = false;
    breakerReasonInMemory = null;
    return getContrarianConfig();
  });
}

function configMatchesSnapshot(snapshot: ConfigSnapshot): boolean {
  const current = effectiveConfig();
  return (
    configRecord.version === snapshot.version
    && current.enabled === snapshot.config.enabled
    && current.mode === snapshot.config.mode
    && current.budgetDollars === snapshot.config.budgetDollars
    && current.dailyCapDollars === snapshot.config.dailyCapDollars
    && current.openCapDollars === snapshot.config.openCapDollars
    && current.perWindowCapDollars === snapshot.config.perWindowCapDollars
    && current.maxDirectContractCost === snapshot.config.maxDirectContractCost
    && current.circuitBreakerEnabled === snapshot.config.circuitBreakerEnabled
    && current.circuitBreaker === snapshot.config.circuitBreaker
  );
}

function breakerBlocks(snapshot: ConfigSnapshot): boolean {
  // An unresolved live incident always blocks live submissions, even if an
  // operator disabled optional breaker enforcement.
  return snapshot.config.circuitBreaker
    && (snapshot.config.circuitBreakerEnabled || snapshot.config.mode === "live");
}

async function persistObservation(input: {
  trigger: ContrarianTriggerInput;
  snapshot: ConfigSnapshot;
  eligible: boolean;
  reason: string;
  context?: ContrarianFreshGuardContext | null;
  evidence?: Record<string, unknown>;
}): Promise<ContrarianObservation | null> {
  const oppositeSide: ContrarianSide =
    input.trigger.protectedSide === "yes" ? "no" : "yes";
  try {
    // Monitoring runs frequently; retain one identical strict decision per
    // symbol/window/reason per short interval while preserving state changes.
    const dedupeKey = `${input.snapshot.config.mode}:${input.trigger.symbol.toUpperCase()}:${input.trigger.windowKey}:${input.eligible}:${input.reason}`;
    const now = Date.now();
    // Keep this process-local anti-spam map bounded even over long-running
    // processes and many completed windows.
    for (const [key, expiresAt] of recentObservationKeys) {
      if (expiresAt + 60_000 <= now) recentObservationKeys.delete(key);
    }
    if ((recentObservationKeys.get(dedupeKey) ?? 0) + 30_000 > now) return null;
    recentObservationKeys.set(dedupeKey, now);
    return await recordContrarianObservation({
      executionMode: input.snapshot.config.mode,
      sourceMode: input.trigger.sourceMode,
      symbol: input.trigger.symbol.toUpperCase(),
      windowKey: input.trigger.windowKey,
      ticker: input.trigger.ticker,
      protectedSide: input.trigger.protectedSide,
      oppositeSide,
      eligible: input.eligible,
      reason: input.reason,
      evidence: {
        ...(input.context?.evidence ?? {}),
        freshGuard: input.context?.decision?.guardResult ?? null,
        targetPrice: input.context?.targetPrice ?? null,
        closeTime: input.context?.closeTime ?? null,
        ...(input.evidence ?? {}),
      },
      yesAsk: input.context?.yesAsk ?? null,
      noAsk: input.context?.noAsk ?? null,
      directAsk: input.context == null
        ? null
        : oppositeSide === "yes"
          ? input.context.yesAsk
          : input.context.noAsk,
    });
  } catch (error) {
    logger.error(
      { error, reason: input.reason, symbol: input.trigger.symbol },
      "[kalshi-scalper-contrarian] observation persistence failed",
    );
    return null;
  }
}

function guardOutcomePayloadToInput(
  payload: ScalpGuardOutcomeStudyRecoveryPayload,
): ContrarianGuardOutcomeStudyInput | null {
  if (
    payload.version !== 1
    || (payload.mode !== "paper" && payload.mode !== "live")
    || !payload.symbol
    || !payload.windowKey
    || !payload.ticker
    || (payload.protectedSide !== "yes" && payload.protectedSide !== "no")
    || (payload.oppositeSide !== "yes" && payload.oppositeSide !== "no")
    || payload.protectedSide === payload.oppositeSide
    || (
      payload.crossingType !== "target_crossed"
      && payload.crossingType !== "projected_target_crossing"
    )
    || typeof payload.guardReason !== "string"
    || typeof payload.quoteSupported !== "boolean"
    || !Number.isInteger(payload.hypotheticalContracts)
    || payload.hypotheticalContracts < 0
    || !Number.isFinite(payload.hypotheticalBudget)
    || payload.hypotheticalBudget < 0
    || typeof payload.evidence !== "object"
    || payload.evidence === null
  ) {
    return null;
  }
  const closeTime = new Date(payload.closeTime);
  const observedAt = new Date(payload.observedAt);
  if (
    Number.isNaN(closeTime.valueOf())
    || Number.isNaN(observedAt.valueOf())
  ) {
    return null;
  }
  const nullableFinite = (value: number | null): boolean =>
    value === null || Number.isFinite(value);
  if (
    !nullableFinite(payload.secondsRemaining)
    || !nullableFinite(payload.yesAsk)
    || !nullableFinite(payload.noAsk)
    || !nullableFinite(payload.oppositeAsk)
    || !nullableFinite(payload.hypotheticalAvgYesPrice)
  ) {
    return null;
  }
  return {
    mode: payload.mode,
    symbol: payload.symbol.toUpperCase(),
    windowKey: payload.windowKey,
    ticker: payload.ticker,
    closeTime,
    guardReason: payload.guardReason,
    crossingType: payload.crossingType,
    protectedSide: payload.protectedSide,
    oppositeSide: payload.oppositeSide,
    secondsRemaining: payload.secondsRemaining,
    yesAsk: payload.yesAsk,
    noAsk: payload.noAsk,
    oppositeAsk: payload.oppositeAsk,
    quoteSupported: payload.quoteSupported,
    hypotheticalContracts: payload.hypotheticalContracts,
    hypotheticalBudget: payload.hypotheticalBudget,
    hypotheticalAvgYesPrice: payload.hypotheticalAvgYesPrice,
    evidence: payload.evidence,
    observedAt,
  };
}

async function recordGuardOutcomePayload(
  payload: ScalpGuardOutcomeStudyRecoveryPayload,
): Promise<boolean> {
  const input = guardOutcomePayloadToInput(payload);
  if (!input) throw new Error("invalid guard outcome study outbox payload");
  return recordContrarianGuardOutcomeStudy(input);
}

export async function replayContrarianGuardOutcomeStudyOutbox(
  dependencies: {
    getPending?: typeof getPendingContrarianGuardOutcomeStudyOutbox;
    record?: typeof recordGuardOutcomePayload;
  } = {},
): Promise<{ attempted: number; inserted: number; deduplicated: number; failed: number }> {
  const getPending =
    dependencies.getPending ?? getPendingContrarianGuardOutcomeStudyOutbox;
  const record = dependencies.record ?? recordGuardOutcomePayload;
  const pending = await getPending();
  const result = await replayContrarianGuardOutcomeRows(pending, record);
  if (result.failed > 0) {
    logger.warn(
      { failed: result.failed, attempted: result.attempted },
      "[kalshi-scalper-contrarian] guard outcome outbox replay deferred",
    );
  }
  return result;
}

function validateFreshContext(
  trigger: ContrarianTriggerInput,
  context: ContrarianFreshGuardContext,
  config: ContrarianConfig,
): {
  ok: true;
  directAsk: number;
  plan: Extract<ContrarianOrderPlan, { ok: true }>;
  decision: FreefallPreSubmitDecision;
} | { ok: false; reason: string } {
  if (!context.ok || !context.decision) {
    return { ok: false, reason: context.reason ?? "fresh_revalidation_failed" };
  }
  if (context.closeTime !== trigger.closeTime) {
    return { ok: false, reason: "fresh_identity_changed" };
  }
  const freshEligibility = evaluateContrarianGuardEligibility(
    context.decision,
    trigger.protectedSide,
    config.strictEligibility,
  );
  if (!freshEligibility.eligible) {
    return { ok: false, reason: `fresh_guard_${freshEligibility.reason}` };
  }
  const expectedOpposite: ContrarianSide =
    trigger.protectedSide === "yes" ? "no" : "yes";
  if (freshEligibility.oppositeSide !== expectedOpposite) {
    return { ok: false, reason: "fresh_opposite_side_changed" };
  }
  if (
    context.yesAsk == null
    || context.noAsk == null
    || !Number.isFinite(context.yesAsk)
    || !Number.isFinite(context.noAsk)
    || context.yesAsk <= 0
    || context.yesAsk >= 1
    || context.noAsk <= 0
    || context.noAsk >= 1
  ) {
    return { ok: false, reason: "fresh_authenticated_quote_invalid" };
  }
  const directAsk = expectedOpposite === "yes" ? context.yesAsk : context.noAsk;
  const plan = planContrarianOrder({
    budgetDollars: config.budgetDollars,
    maxDirectContractCost: config.maxDirectContractCost,
    minDirectContractCost: config.strictEligibility.minDirectAsk,
    directAsk,
    oppositeSide: expectedOpposite,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };
  return { ok: true, directAsk, plan, decision: context.decision };
}

async function rejectAfterClaim(input: {
  trigger: ContrarianTriggerInput;
  snapshot: ConfigSnapshot;
  reservation: ContrarianReservation;
  reason: string;
  context?: ContrarianFreshGuardContext | null;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  await releaseContrarianReservation(input.reservation.id, input.reason);
  if (input.snapshot.config.mode === "live") {
    contrarianExposureRegistry.remove(
      input.trigger.sourceMode,
      input.trigger.symbol,
      input.trigger.windowKey,
    );
  }
  await persistObservation({
    trigger: input.trigger,
    snapshot: input.snapshot,
    eligible: false,
    reason: input.reason,
    context: input.context,
    evidence: input.evidence,
  });
}

function synchronousFinalReason(
  trigger: ContrarianTriggerInput,
  snapshot: ConfigSnapshot,
): string | null {
  if (!configMatchesSnapshot(snapshot)) return "experiment_config_changed";
  if (breakerBlocks(snapshot)) return "experiment_breaker_before_submit";
  if (
    regularExposureSync(
      trigger.sourceMode,
      trigger.symbol,
      trigger.windowKey,
      trigger.ticker,
    )
  ) {
    return "regular_position_exposure";
  }
  return trigger.finalValidationSync();
}

export async function triggerContrarianFromNormalGuard(
  trigger: ContrarianTriggerInput,
): Promise<void> {
  const config = effectiveConfig();
  if (!config.enabled) return;
  const snapshot: ConfigSnapshot = {
    version: configRecord.version,
    config: { ...config },
  };
  const initialEligibility = evaluateContrarianGuardEligibility(
    trigger.decision,
    trigger.protectedSide,
    snapshot.config.strictEligibility,
  );
  if (!initialEligibility.eligible) {
    await persistObservation({
      trigger,
      snapshot,
      eligible: false,
      reason: initialEligibility.reason,
      evidence: { strictEligibility: initialEligibility.evidence ?? null, monitoringPhase: "strict_classifier" },
    });
    return;
  }
  const key = `${config.mode}:${trigger.symbol.toUpperCase()}:${trigger.windowKey}`;
  if (attemptsInFlight.has(key)) return;
  attemptsInFlight.add(key);

  let reservation: ContrarianReservation | null = null;
  try {
    if (breakerBlocks(snapshot)) {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: "experiment_breaker_latched",
        evidence: { breakerReason: snapshot.config.circuitBreakerReason },
      });
      return;
    }
    if (snapshot.config.mode === "live" && trigger.sourceMode !== "live") {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: "live_experiment_requires_live_source",
      });
      return;
    }
    const initialObservation = await persistObservation({
      trigger,
      snapshot,
      eligible: true,
      reason: initialEligibility.reason,
      evidence: { guard: initialEligibility.guard, phase: "source_guard" },
    });
    // Audit is mandatory before this lane may proceed.
    if (!initialObservation) return;

    const firstContext = await trigger.refreshAndRevalidate().catch(
      (error): ContrarianFreshGuardContext => ({
        ok: false,
        reason: "fresh_revalidation_threw",
        decision: null,
        yesAsk: null,
        noAsk: null,
        targetPrice: null,
        closeTime: null,
        evidence: { error: String(error) },
      }),
    );
    const first = validateFreshContext(trigger, firstContext, snapshot.config);
    if (!first.ok) {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: first.reason,
        context: firstContext,
      });
      return;
    }
    if (!configMatchesSnapshot(snapshot)) {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: "experiment_config_changed",
        context: firstContext,
      });
      return;
    }
    if (
      regularExposureSync(
        trigger.sourceMode,
        trigger.symbol,
        trigger.windowKey,
        trigger.ticker,
      )
    ) {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: "regular_position_exposure",
        context: firstContext,
      });
      return;
    }
    if (
      await hasNormalScalpExposure(
        trigger.sourceMode,
        trigger.symbol.toUpperCase(),
        trigger.windowKey,
        trigger.ticker,
      )
    ) {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: "normal_scalper_exposure",
        context: firstContext,
      });
      return;
    }

    if (snapshot.config.mode === "live") {
      const balance = await getBalance().catch(() => null);
      if (
        !balance
        || !Number.isFinite(balance.availableBalance)
        || balance.availableBalance < first.plan.maxExposure
      ) {
        await persistObservation({
          trigger,
          snapshot,
          eligible: false,
          reason: balance ? "insufficient_balance" : "balance_unavailable",
          context: firstContext,
          evidence: {
            availableBalance: balance?.availableBalance ?? null,
            requiredBalance: first.plan.maxExposure,
          },
        });
        return;
      }
    }

    const claim = await claimContrarianReservation({
      executionMode: snapshot.config.mode,
      sourceMode: trigger.sourceMode,
      symbol: trigger.symbol.toUpperCase(),
      windowKey: trigger.windowKey,
      ticker: trigger.ticker,
      requestedBudget: snapshot.config.budgetDollars,
      dailyCap: snapshot.config.dailyCapDollars,
      openCap: snapshot.config.openCapDollars,
      perWindowCap: snapshot.config.perWindowCapDollars,
      reason: initialEligibility.reason,
    });
    if (!claim.claimed) {
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: claim.reason,
        context: firstContext,
        evidence: {
          dailyCommitted: claim.dailyCommitted,
          openCommitted: claim.openCommitted,
          windowCommitted: claim.windowCommitted,
        },
      });
      return;
    }
    reservation = claim.reservation;
    if (snapshot.config.mode === "live") {
      contrarianExposureRegistry.add(
        trigger.sourceMode,
        trigger.symbol,
        trigger.windowKey,
      );
    }

    // Reacquire everything after the atomic claim; no original quote or guard
    // result may cross this boundary.
    const [finalContext, finalBalance] = await Promise.all([
      trigger.refreshAndRevalidate().catch(
        (error): ContrarianFreshGuardContext => ({
          ok: false,
          reason: "final_revalidation_threw",
          decision: null,
          yesAsk: null,
          noAsk: null,
          targetPrice: null,
          closeTime: null,
          evidence: { error: String(error) },
        }),
      ),
      snapshot.config.mode === "live"
        ? getBalance().catch(() => null)
        : Promise.resolve(null),
    ]);
    const final = validateFreshContext(trigger, finalContext, snapshot.config);
    if (!final.ok) {
      await rejectAfterClaim({
        trigger,
        snapshot,
        reservation,
        reason: final.reason,
        context: finalContext,
      });
      return;
    }
    if (
      snapshot.config.mode === "live"
      && (
        !finalBalance
        || !Number.isFinite(finalBalance.availableBalance)
        || finalBalance.availableBalance < final.plan.maxExposure
      )
    ) {
      await rejectAfterClaim({
        trigger,
        snapshot,
        reservation,
        reason: finalBalance
          ? "insufficient_balance_after_reservation"
          : "balance_unavailable_after_reservation",
        context: finalContext,
        evidence: {
          availableBalance: finalBalance?.availableBalance ?? null,
          requiredBalance: final.plan.maxExposure,
        },
      });
      return;
    }
    if (
      await hasNormalScalpExposure(
        trigger.sourceMode,
        trigger.symbol.toUpperCase(),
        trigger.windowKey,
        trigger.ticker,
      )
    ) {
      await rejectAfterClaim({
        trigger,
        snapshot,
        reservation,
        reason: "normal_scalper_exposure_final",
        context: finalContext,
      });
      return;
    }
    const finalReason = synchronousFinalReason(trigger, snapshot);
    if (finalReason) {
      await rejectAfterClaim({
        trigger,
        snapshot,
        reservation,
        reason: finalReason,
        context: finalContext,
      });
      return;
    }

    const oppositeSide: ContrarianSide =
      trigger.protectedSide === "yes" ? "no" : "yes";
    const clientOrderId = snapshot.config.mode === "live"
      ? `scalp-contrarian-${crypto.randomUUID()}`
      : `paper-scalp-contrarian-${crypto.randomUUID()}`;
    const order = await insertContrarianOrderIntent({
      reservationId: reservation.id,
      executionMode: snapshot.config.mode,
      sourceMode: trigger.sourceMode,
      symbol: trigger.symbol.toUpperCase(),
      windowKey: trigger.windowKey,
      ticker: trigger.ticker,
      protectedSide: trigger.protectedSide,
      oppositeSide,
      contractCount: final.plan.contractCount,
      yesLimitPrice: final.plan.yesLimitPrice,
      directAsk: final.directAsk,
      yesAsk: finalContext.yesAsk,
      noAsk: finalContext.noAsk,
      clientOrderId,
      evidence: {
        sourceGuard: initialEligibility.guard,
        finalGuard: final.decision.guardResult,
        targetPrice: finalContext.targetPrice,
        closeTime: finalContext.closeTime,
        maxExposure: final.plan.maxExposure,
        configVersion: snapshot.version,
      },
    });

    const postIntentReason = synchronousFinalReason(trigger, snapshot);
    if (postIntentReason) {
      await finalizeContrarianZeroFill({
        orderId: order.id,
        reason: `pre_submit_abort:${postIntentReason}`,
        evidence: { exchangeCalled: false },
      });
      if (snapshot.config.mode === "live") {
        contrarianExposureRegistry.remove(
          trigger.sourceMode,
          trigger.symbol,
          trigger.windowKey,
        );
      }
      await persistObservation({
        trigger,
        snapshot,
        eligible: false,
        reason: postIntentReason,
        context: finalContext,
        evidence: { exchangeCalled: false },
      });
      return;
    }

    if (snapshot.config.mode === "paper") {
      const budgetSpent =
        final.plan.contractCount * final.directAsk;
      await finalizeContrarianPaper({
        orderId: order.id,
        filledCount: final.plan.contractCount,
        avgYesFillPrice: final.plan.hypotheticalAvgYesPrice,
        budgetSpent,
        reason: "paper_simulation",
        evidence: {
          simulated: true,
          assumedImmediateFillAtDirectAsk: true,
        },
      });
      await persistObservation({
        trigger,
        snapshot,
        eligible: true,
        reason: "paper_simulation_recorded",
        context: finalContext,
        evidence: {
          orderId: order.id,
          contractCount: final.plan.contractCount,
          budgetSpent,
        },
      });
      return;
    }

    // There is intentionally no await between the final synchronous validation
    // above and invoking the strict POST primitive.
    let submitted;
    try {
      submitted = await placeScalpOrderStrict({
        ticker: order.ticker,
        side: order.oppositeSide,
        count: order.contractCount,
        limitPrice: order.yesLimitPrice,
        clientOrderId: order.clientOrderId,
      });
    } catch (error) {
      await finalizeContrarianUnknown({
        orderId: order.id,
        reason: "live_submission_unknown",
        evidence: { error: String(error) },
      }).catch((persistError) => {
        logger.error(
          { persistError, orderId: order.id },
          "[kalshi-scalper-contrarian] failed to persist unknown submit",
        );
      });
      await tripContrarianBreaker("live_submission_unknown");
      return;
    }

    if (submitted.outcome === "unknown") {
      await finalizeContrarianUnknown({
        orderId: order.id,
        reason: submitted.reason,
        evidence: { strictResponseReason: submitted.reason },
      });
      await tripContrarianBreaker(submitted.reason);
      return;
    }
    if (submitted.outcome === "zero_fill") {
      const finalized = await finalizeContrarianZeroFill({
        orderId: order.id,
        exchangeOrderId: submitted.orderId,
        filledCount: 0,
        budgetSpent: 0,
        reason: submitted.reason,
      });
      if (!finalized) {
        await tripContrarianBreaker("post_submit_zero_fill_transition_conflict");
        logger.error(
          { orderId: order.id },
          "[kalshi-scalper-contrarian] zero-fill finalization lost a concurrent transition",
        );
        return;
      }
      contrarianExposureRegistry.remove(
        trigger.sourceMode,
        trigger.symbol,
        trigger.windowKey,
      );
      await persistObservation({
        trigger,
        snapshot,
        eligible: true,
        reason: "live_zero_fill",
        context: finalContext,
        evidence: { orderId: order.id },
      });
      return;
    }

    const confirmedFilledCount = submitted.filledCount;
    const confirmedAvgYesPrice = submitted.avgFillPrice;
    if (
      confirmedFilledCount == null
      || confirmedAvgYesPrice == null
      || confirmedFilledCount <= 0
    ) {
      await finalizeContrarianUnknown({
        orderId: order.id,
        exchangeOrderId: submitted.orderId,
        reason: "confirmed_fill_missing_economics",
        evidence: { submitted },
      });
      await tripContrarianBreaker("confirmed_fill_missing_economics");
      return;
    }
    const actualSpend = computeContrarianFillSpend(
      order.oppositeSide,
      confirmedFilledCount,
      confirmedAvgYesPrice,
    );
    if (
      actualSpend == null
      || actualSpend > snapshot.config.budgetDollars + 1e-8
    ) {
      await finalizeContrarianUnknown({
        orderId: order.id,
        exchangeOrderId: submitted.orderId,
        reason: "fill_economics_exceeded_reserved_budget",
        evidence: { submitted },
      });
      await tripContrarianBreaker("fill_economics_exceeded_reserved_budget");
      return;
    }
    try {
      const finalized = await finalizeContrarianFilled({
        orderId: order.id,
        exchangeOrderId: submitted.orderId,
        filledCount: confirmedFilledCount,
        avgYesFillPrice: confirmedAvgYesPrice,
        budgetSpent: actualSpend,
        reason: submitted.reason,
      });
      if (!finalized) {
        throw new Error("contrarian fill finalization lost a concurrent transition");
      }
    } catch (error) {
      logger.error(
        { error, orderId: order.id },
        "[kalshi-scalper-contrarian] post-submit fill persistence failed",
      );
      await tripContrarianBreaker("post_submit_fill_persistence_failed");
      return;
    }
    await persistObservation({
      trigger,
      snapshot,
      eligible: true,
      reason: "live_fill_confirmed",
      context: finalContext,
      evidence: {
        orderId: order.id,
        exchangeOrderId: submitted.orderId,
        filledCount: confirmedFilledCount,
        budgetSpent: actualSpend,
      },
    });
  } finally {
    attemptsInFlight.delete(key);
  }
}

async function reconcileOrder(order: ContrarianOrder): Promise<ContrarianOrder> {
  const result = await reconcileScalpOrderStrict({
    ticker: order.ticker,
    side: order.oppositeSide,
    count: order.contractCount,
    limitPrice: order.yesLimitPrice,
    clientOrderId: order.clientOrderId,
    exchangeOrderId: order.exchangeOrderId,
    createdAt: order.createdAt,
  });
  if (result.outcome === "ambiguous") {
    await finalizeContrarianUnknown({
      orderId: order.id,
      reason: `reconcile_ambiguous:${result.reason}`,
      evidence: result.evidence,
    });
    throw new Error(`Reconciliation remains ambiguous: ${result.reason}`);
  }
  if (result.outcome === "zero_fill") {
    const updated = await finalizeContrarianZeroFill({
      orderId: order.id,
      exchangeOrderId: result.orderId,
      filledCount: 0,
      budgetSpent: 0,
      reason: result.reason,
      evidence: result.evidence,
    });
    if (!updated) throw new Error("Contrarian order changed during reconciliation");
    contrarianExposureRegistry.remove(
      order.sourceMode,
      order.symbol,
      order.windowKey,
    );
    return updated;
  }
  if (result.budgetSpent > order.contractCount * (
    order.oppositeSide === "yes"
      ? order.yesLimitPrice
      : 1 - order.yesLimitPrice
  ) + 1e-8) {
    await finalizeContrarianUnknown({
      orderId: order.id,
      reason: "reconciled_fill_exceeds_persisted_limit",
      evidence: result.evidence,
    });
    throw new Error("Reconciled fill exceeds persisted limit");
  }
  const updated = await finalizeContrarianFilled({
    orderId: order.id,
    exchangeOrderId: result.orderId,
    filledCount: result.filledCount,
    avgYesFillPrice: result.avgFillPrice,
    budgetSpent: result.budgetSpent,
    reason: result.reason,
    evidence: result.evidence,
  });
  if (!updated) throw new Error("Contrarian order disappeared during reconciliation");
  return updated;
}

export async function reconcileContrarianUnknown(
  id: string,
): Promise<{ ok: true; order: ContrarianOrder }> {
  const order = await getContrarianOrder(id);
  if (
    !order
    || order.executionMode !== "live"
    || (order.status !== "unknown" && order.status !== "submitting")
  ) {
    throw new Error("Unresolved live contrarian order not found");
  }
  const reconciled = await reconcileOrder(order);
  return { ok: true, order: reconciled };
}

async function resolveMarketResult(
  ticker: string,
): Promise<ContrarianSide | null> {
  const direct = await fetchKalshiMarketResult(ticker).catch(() => null);
  if (direct?.result === "yes" || direct?.result === "no") {
    return direct.result;
  }
  const series = ticker.split("-")[0];
  if (!series) return null;
  const settled = await fetchKalshiSettledMarkets(series, 50).catch(
    (): Array<{
      ticker: string;
      result: "yes" | "no";
      closeTime: string;
      floorStrike: number;
    }> => [],
  );
  return settled.find((market) => market.ticker === ticker)?.result ?? null;
}

async function settleFilledOrder(order: ContrarianOrder): Promise<void> {
  if (
    order.status !== "filled"
    || order.avgYesFillPrice == null
    || order.filledCount <= 0
  ) {
    return;
  }
  const result = await resolveMarketResult(order.ticker);
  if (!result) return;
  const pnl = computeContrarianPnl({
    side: order.oppositeSide,
    count: order.filledCount,
    avgYesPrice: order.avgYesFillPrice,
    result,
  });
  const settled = await settleContrarianOrder(
    order.id,
    result,
    pnl >= 0 ? "win" : "loss",
    pnl,
    { source: "authoritative_kalshi_result" },
  );
  if (settled?.executionMode === "live") {
    contrarianExposureRegistry.remove(
      settled.sourceMode,
      settled.symbol,
      settled.windowKey,
    );
  }
}

async function settleGuardOutcomeStudy(
  study: Awaited<ReturnType<
    typeof getUnsettledContrarianGuardOutcomeStudies
  >>[number],
): Promise<void> {
  const result = await resolveMarketResult(study.ticker);
  if (!result) return;
  const originalOutcome: "win" | "loss" =
    result === study.protectedSide ? "win" : "loss";
  const oppositeOutcome: "win" | "loss" =
    result === study.oppositeSide ? "win" : "loss";
  const hypotheticalPnl =
    study.quoteSupported
    && study.hypotheticalContracts > 0
    && study.hypotheticalAvgYesPrice != null
      ? computeContrarianPnl({
          side: study.oppositeSide,
          count: study.hypotheticalContracts,
          avgYesPrice: study.hypotheticalAvgYesPrice,
          result,
        })
      : null;
  await settleContrarianGuardOutcomeStudy({
    mode: study.mode,
    symbol: study.symbol,
    windowKey: study.windowKey,
    settlementResult: result,
    originalOutcome,
    oppositeOutcome,
    hypotheticalPnl,
  });
}

export async function evaluateContrarianLifecycle(): Promise<void> {
  const now = Date.now();
  await replayContrarianGuardOutcomeStudyOutbox().catch((error) =>
    logger.warn(
      { error },
      "[kalshi-scalper-contrarian] guard outcome outbox scan deferred",
    )
  );
  const unresolved = await getUnknownContrarianOrders();
  for (const order of unresolved) {
    if (now - (lastReconcileAt.get(order.id) ?? 0) < RECONCILE_INTERVAL_MS) {
      continue;
    }
    lastReconcileAt.set(order.id, now);
    await reconcileOrder(order).catch((error) =>
      logger.warn(
        { error, orderId: order.id },
        "[kalshi-scalper-contrarian] reconciliation remains unresolved",
      ),
    );
  }
  const unsettled = await getUnsettledContrarianOrders();
  for (const order of unsettled) {
    if (now - (lastSettlementAt.get(order.id) ?? 0) < SETTLEMENT_INTERVAL_MS) {
      continue;
    }
    lastSettlementAt.set(order.id, now);
    await settleFilledOrder(order).catch((error) =>
      logger.warn(
        { error, orderId: order.id },
        "[kalshi-scalper-contrarian] settlement failed",
      ),
    );
  }
  const guardOutcomes = await getUnsettledContrarianGuardOutcomeStudies();
  for (const study of guardOutcomes) {
    const key = `${study.mode}:${study.symbol}:${study.windowKey}`;
    if (
      now - (lastGuardOutcomeSettlementAt.get(key) ?? 0)
      < SETTLEMENT_INTERVAL_MS
    ) {
      continue;
    }
    lastGuardOutcomeSettlementAt.set(key, now);
    await settleGuardOutcomeStudy(study).catch((error) =>
      logger.warn(
        { error, key },
        "[kalshi-scalper-contrarian] guard outcome study settlement failed",
      )
    );
  }
}

export async function getContrarianReport() {
  const [
    recentOrders,
    recentObservations,
    recentIncidents,
    paper,
    live,
    counts,
    guardOutcomeStudy,
  ] =
    await Promise.all([
      getContrarianOrders(undefined, 100),
      getRecentContrarianObservations(100),
      getRecentContrarianIncidents(50),
      getContrarianTotals("paper"),
      getContrarianTotals("live"),
      getContrarianReportCounts(),
      getContrarianGuardOutcomeStudyReport(),
    ]);
  return {
    config: getContrarianConfig(),
    summary: {
      paper,
      live,
      totalOrders: counts.totalOrders,
      unresolvedLiveOrders: counts.unresolvedLiveOrders,
    },
    guardOutcomeStudy,
    recentOrders,
    recentObservations,
    recentIncidents,
    disclaimer:
      "Contrarian Spike is an isolated experiment. Paper rows are simulations, not exchange fills. Its P&L, caps, orders, incidents, settlement, calibration evidence, and breaker state are excluded from the normal Scalper, Shadow Study, and regular bot.",
  };
}