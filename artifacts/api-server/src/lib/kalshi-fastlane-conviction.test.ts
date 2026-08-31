import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  computeFastLaneLimitPrice,
  computeFastLaneContractCount,
  computeConvictionDecision,
  computeKalshi15mTicker,
  evaluateConvictionFillZone,
  FASTLANE_EMERGENCY_EXIT_THRESHOLD_CENTS,
  isPriceTriggeredDecisionMode,
  resolveFastLaneEmergencyExitThresholdCents,
  shouldEmergencyExitFastLaneFill,
} from "./kalshi-bot-engine-core.ts";
import {
  CONVICTION_MAX_ZERO_FILL_ATTEMPTS,
  CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS,
  regularZeroFillMaxAttempts,
  regularZeroFillRetryCooldownMs,
} from "./kalshi-regular-zero-fill-policy.ts";

test("FastLane is a price-triggered mode without changing existing modes", () => {
  assert.equal(isPriceTriggeredDecisionMode("fastlane"), true);
  assert.equal(isPriceTriggeredDecisionMode("conviction"), true);
  assert.equal(isPriceTriggeredDecisionMode("ml_gate"), false);
});

test("FastLane caps YES and NO orders at the far edge of the side-cost band", () => {
  assert.equal(computeFastLaneLimitPrice("yes", 0.91), 0.91);
  assert.equal(computeFastLaneLimitPrice("no", 0.91), 0.09);
  assert.equal(computeFastLaneLimitPrice("yes", 0.955), 0.95);
  assert.equal(computeFastLaneLimitPrice("no", 0.955), 0.05);
});

test("FastLane band detection includes both boundaries for YES and NO", () => {
  const base = {
    yesPrice: 0.5,
    lockPrice: 0.82,
    lockPriceCap: 0.91,
    minConfidence: 0,
  };
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.82, yesBid: 0.1, noAsk: 0.9 }).action,
    "BET_YES",
  );
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.91, yesBid: 0.1, noAsk: 0.9 }).action,
    "BET_YES",
  );
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.1, yesBid: 0.18, noAsk: 0.82 }).action,
    "BET_NO",
  );
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.1, yesBid: 0.09, noAsk: 0.91 }).action,
    "BET_NO",
  );
});

test("FastLane contract sizing cannot spend above the target at the band edge", () => {
  const yesLimit = computeFastLaneLimitPrice("yes", 0.91);
  const noLimit = computeFastLaneLimitPrice("no", 0.91);
  assert.equal(computeFastLaneContractCount(10, "yes", yesLimit), 10);
  assert.equal(computeFastLaneContractCount(10, "no", noLimit), 10);
  assert.ok(computeFastLaneContractCount(10, "yes", yesLimit) * 0.91 <= 10);
  assert.ok(computeFastLaneContractCount(10, "no", noLimit) * 0.91 <= 10);
});

test("FastLane emergency-exit gap is configurable and includes the exact boundary", () => {
  assert.equal(FASTLANE_EMERGENCY_EXIT_THRESHOLD_CENTS, 15);
  assert.equal(shouldEmergencyExitFastLaneFill(0.68, 0.83, 15), true);
  assert.equal(shouldEmergencyExitFastLaneFill(0.6801, 0.83, 15), false);
  assert.equal(shouldEmergencyExitFastLaneFill(0.73, 0.83, 10), true);
  assert.equal(shouldEmergencyExitFastLaneFill(0.72, 0.83, 12), false);
  assert.equal(shouldEmergencyExitFastLaneFill(0.67, 0.82, 15), true);
  assert.equal(shouldEmergencyExitFastLaneFill(0.68, 0.82, 15), false);
});

test("FastLane emergency-exit gap uses normalized side cost for YES and NO", () => {
  const yesFill = evaluateConvictionFillZone("yes", 0.68, 0.83, 0.95);
  const noFill = evaluateConvictionFillZone("no", 0.32, 0.83, 0.95);
  assert.equal(yesFill.sideCost, 0.68);
  assert.ok(Math.abs((noFill.sideCost ?? 0) - 0.68) < 1e-9);
  assert.equal(shouldEmergencyExitFastLaneFill(yesFill.sideCost, 0.83, 15), true);
  assert.equal(shouldEmergencyExitFastLaneFill(noFill.sideCost, 0.83, 15), true);
});

test("FastLane emergency-exit threshold rejects invalid configuration values", () => {
  assert.equal(shouldEmergencyExitFastLaneFill(0.68, 0.83, 0), false);
  assert.equal(shouldEmergencyExitFastLaneFill(0.68, 0.83, 100), false);
  assert.equal(shouldEmergencyExitFastLaneFill(null, 0.83, 15), false);
  assert.equal(shouldEmergencyExitFastLaneFill(0.68, null, 15), false);
});

test("FastLane invalid or missing persisted thresholds restore the safe default", () => {
  assert.equal(resolveFastLaneEmergencyExitThresholdCents(undefined), 15);
  assert.equal(resolveFastLaneEmergencyExitThresholdCents(0), 15);
  assert.equal(resolveFastLaneEmergencyExitThresholdCents(100), 15);
  assert.equal(resolveFastLaneEmergencyExitThresholdCents(9), 9);
});

test("exact Kalshi ticker conversion honors both EST and EDT", () => {
  assert.equal(
    computeKalshi15mTicker("btc", "2026-01-15T00:15"),
    "KXBTC15M-26JAN141930-30",
  );
  assert.equal(
    computeKalshi15mTicker("btc", "2026-07-18T00:15"),
    "KXBTC15M-26JUL172030-30",
  );
});

test("FastLane confirmed zero fills use the controlled five-second, ten-attempt policy", () => {
  assert.equal(
    regularZeroFillRetryCooldownMs("fastlane"),
    CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS,
  );
  assert.equal(
    regularZeroFillMaxAttempts("fastlane"),
    CONVICTION_MAX_ZERO_FILL_ATTEMPTS,
  );
});

test("FastLane bypasses authenticated-book quote and revalidation for every market", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  assert.match(source, /const useAuthenticatedBook =\s*!isFastLane/);
  assert.doesNotMatch(source, /fastLaneCommodityRequiresAuthenticatedBook/);
  assert.doesNotMatch(source, /commodity FastLane IOC requires/);
  assert.match(source, /\[kalshi-bot\] FastLane range hit — submitting edge-capped IOC/);
  assert.match(source, /timeInForce: entryTimeInForce/);
  assert.match(source, /claimRegularOrderIntent\(/);
  assert.match(source, /markRegularOrderIntentUnknown\(/);
  assert.match(source, /authenticatedBookQuote\?\.revalidate\(\) \?\? true/);
});

test("FastLane honors enabled proximity and freefall guards without adding waits or requests", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const proximityStart = source.indexOf("Price-triggered strike-proximity re-check (tick-time)");
  const freefallStart = source.indexOf("const regularFreefallEnabled");
  const intentStart = source.indexOf("claimRegularOrderIntent", freefallStart);

  assert.ok(proximityStart >= 0);
  assert.match(
    source.slice(proximityStart, freefallStart),
    /isPriceTriggeredMode\s*&& \(S\.config\.convictionProximityGuardEnabled \?\? true\)[\s\S]*computeStrikeProximityGate/,
  );
  assert.ok(freefallStart > proximityStart);
  assert.ok(intentStart > freefallStart);
  assert.match(
    source.slice(freefallStart, intentStart),
    /enabled: regularFreefallEnabled,\s*samples: regularFreefallEnabled \? \(convictionPriceTicks\.get\(sym\) \?\? \[\]\) : \[\]/,
  );
  assert.doesNotMatch(source.slice(proximityStart, intentStart), /await getTickerFresh|setTimeout|sleep\(/);
});

test("FastLane persists a bad fill before dispatching its emergency sell inline", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const closeSource = readFileSync(new URL("./kalshi-bot-close.ts", import.meta.url), "utf8");
  const persistIndex = source.indexOf("await persistBetRecord({", source.indexOf("const newPosition"));
  const emergencyIndex = source.indexOf(
    'if (entryMode === "live" && fastLaneEmergencyExit != null)',
    persistIndex,
  );
  const closeIndex = source.indexOf(
    '"fastlane_fill_below_configured_floor_threshold"',
    emergencyIndex,
  );
  assert.ok(persistIndex >= 0, "FastLane entry must be persisted");
  assert.ok(emergencyIndex > persistIndex, "emergency exit must follow durable entry persistence");
  assert.ok(closeIndex > emergencyIndex, "emergency close must run inline in the fill flow");
  assert.match(source, /fastLaneEmergencyExitDetails: fastLaneEmergencyExit/);
  assert.match(source, /reconcileActiveRegularExitIntent\(pos\.id\)/);
  assert.match(source, /reconciledLiveFill:/);
  assert.match(
    source,
    /"fastlane_fill_below_configured_floor_threshold",\s*false,\s*\{\s*reconciledLiveFill:/,
  );
  assert.match(
    closeSource,
    /if \(pos\.entryMode === "live" && !isExpiry && reconciledLiveFill\)[\s\S]*else if \(pos\.entryMode === "live" && !isExpiry\)/,
  );
  assert.match(closeSource, /markRegularExitIntentFinalized\(completedLiveExitIntentId\)/);
  assert.match(source, /position remains tracked/);
});

test("confirmed emergency exits finalize before pause and daily-loss gates", () => {
  const tickSource = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(new URL("../routes/kalshi-bot.ts", import.meta.url), "utf8");
  const reconcileSource = readFileSync(
    new URL("./kalshi-regular-order-reconcile.ts", import.meta.url),
    "utf8",
  );
  const recoveryIndex = tickSource.indexOf("const recoveryPos = openPositions.get(sym)");
  const dailyLimitIndex = tickSource.indexOf("if (S.dailyPnl <= -getEffectiveDailyLossLimit())");
  const pauseIndex = tickSource.indexOf("if (S.paused) return");
  assert.ok(recoveryIndex >= 0 && recoveryIndex < dailyLimitIndex);
  assert.ok(recoveryIndex < pauseIndex);
  assert.match(routeSource, /await finalizeReconciledFastLaneExit\(/);
  assert.match(
    routeSource,
    /result\.outcome === "confirmed_fill" && "positionId" in result/,
  );
  assert.doesNotMatch(
    routeSource,
    /result\.outcome === "confirmed_fill" && "avgYesPrice" in result/,
  );
  assert.match(
    tickSource,
    /\.where\(eq\(kalshiBotBetsTable\.id, params\.positionId\)\)[\s\S]*reconstructedFromDb = true/,
  );
  assert.match(tickSource, /reconstructedFromDb,/);
  assert.match(routeSource, /positionId: result\.positionId/);
  assert.match(reconcileSource, /status IN \('reserved','unknown'\)[\s\S]*status = 'filled'[\s\S]*b\.exited_at IS NULL/);
  assert.match(reconcileSource, /created_at DESC/);
});

test("FastLane honors the configured per-window minimum entry wait with no early-price bypass", () => {
  const tickSource = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const loopSource = readFileSync(new URL("./kalshi-bot-loop.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(new URL("../routes/kalshi-bot.ts", import.meta.url), "utf8");
  assert.match(tickSource, /if \(isPriceTriggeredMode\) \{[\s\S]*getConvictionMinEntryMinute\(sym, S\.config\)/);
  assert.match(
    tickSource,
    /S\.config\.decisionMode === "conviction" &&[\s\S]*S\.config\.convictionEarlyBypassEnabled !== false/,
  );
  assert.match(tickSource, /const modeLabel = isFastLane \? "fastlane" : "conviction"/);
  assert.match(loopSource, /if \(isPriceTriggeredMode\) \{[\s\S]*getConvictionMinEntryMinute\(sym, S\.config\)/);
  assert.match(loopSource, /const _isExtreme = isConviction && _bypassEnabled/);
  const modeDeclaration = loopSource.indexOf(
    "const isPriceTriggeredMode = isPriceTriggeredDecisionMode(S.config.decisionMode)",
  );
  const timingGate = loopSource.indexOf("if (isPriceTriggeredMode) {", modeDeclaration);
  assert.ok(modeDeclaration >= 0, "scheduler must declare its price-triggered mode flag");
  assert.ok(timingGate > modeDeclaration, "scheduler timing gate must use the declared mode flag");
  assert.match(
    tickSource,
    /if \(!isPriceTriggeredMode && minWindowEntryMinutes > 0/,
    "the legacy lockout must not contradict the price-triggered Min Entry Wait",
  );
  assert.match(
    tickSource,
    /preSubmitGuard: \(\) => \{[\s\S]*placementTimingAllowsEntry\([\s\S]*"exchange-pre-submit",[\s\S]*authenticatedBookQuote\?\.marginalLimitCost/,
    "live entry must re-check the current effective wait at the exchange boundary",
  );
  assert.doesNotMatch(
    tickSource,
    /placementTimingAllowsEntry\([\s\S]{0,120}authenticatedBookQuote\?\.worstCaseCost/,
    "the early-price bypass must compare a per-contract side cost, never aggregate order cost",
  );
  assert.match(
    tickSource,
    /entryMode === "paper"[\s\S]*placementTimingAllowsEntry\("paper-pre-submit"/,
    "paper entry must re-check the current effective wait after asynchronous previews",
  );
  assert.match(
    routeSource,
    /hasValidGlobalMinEntryUpdate[\s\S]*mergePerMarketConvictionConfig\([\s\S]*effectiveGlobalMinEntryMinute/,
    "global wait-only updates must revalidate the complete per-market timing map",
  );
});

test("price-triggered settings expose one entry timer and one applicable daily-loss control", () => {
  const source = readFileSync(
    new URL("../../../market-edge/src/pages/bot/bot-config-section.tsx", import.meta.url),
    "utf8",
  );
  const priceTimer = source.indexOf("Single price-triggered entry timer");
  const legacyTimer = source.indexOf("Legacy lockout remains available");
  assert.ok(priceTimer >= 0);
  assert.ok(legacyTimer > priceTimer);
  assert.match(source.slice(priceTimer, legacyTimer), /Allow extreme-price bypass/);
  assert.match(source.slice(legacyTimer), /\{!isPriceTriggeredMode && \(\(\) =>/);
  assert.match(source, /value=\{isConviction \? \(merged\.convictionDailyLossLimit \?\? 50\) : \(merged\.dailyLossLimit \?\? 20\)\}/);
  assert.match(source, /\{isConviction && <label[\s\S]*Daily Total Spend Limit/);
});

test("FastLane has no cross-symbol bets-per-window cap", () => {
  const tickSource = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  assert.match(
    tickSource,
    /maxOrdersPerWindow:\s*isPriceTriggeredMode\s*\?\s*undefined\s*:\s*S\.config\.maxBetsPerWindow/,
  );
  assert.match(
    tickSource,
    /if \(!isPriceTriggeredMode && betsThisWindow >= S\.config\.maxBetsPerWindow\)/,
  );
});

test("FastLane does not inherit legacy Conviction's gross daily spend throttle", () => {
  const tickSource = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  assert.match(
    tickSource,
    /S\.config\.decisionMode === "conviction"\s*&& effectiveMode === "live"\s*&& \(S\.config\.convictionMaxDailySpend \?\? 0\) > 0/,
  );
  assert.match(
    tickSource,
    /paperLiveEligibilityReason == null\s*&& S\.config\.decisionMode === "conviction"\s*&& \(S\.config\.convictionMaxDailySpend \?\? 0\) > 0/,
  );
});

test("a valid FastLane fill uses the shared stop-loss module like every other mode", () => {
  const loopSource = readFileSync(new URL("./kalshi-bot-loop.ts", import.meta.url), "utf8");
  const sharedStopLossStart = loopSource.indexOf("Shared stop-loss module");
  const positionTickStart = loopSource.indexOf(
    "for (const [sym] of Array.from(openPositions.entries()))",
    sharedStopLossStart,
  );
  assert.ok(sharedStopLossStart >= 0, "shared stop-loss module must exist");
  assert.ok(
    positionTickStart > sharedStopLossStart,
    "shared stop-loss must run before ordinary mode-specific position management",
  );
  const stopLossBlock = loopSource.slice(sharedStopLossStart, positionTickStart);
  assert.match(stopLossBlock, /convictionStopLossFloor/);
  assert.match(stopLossBlock, /convictionStopLossActivationMinute/);
  assert.match(stopLossBlock, /convictionStopLossSuppressionMarginPct/);
  assert.match(stopLossBlock, /NEAR_ZERO_STOP_LOSS_FLOOR/);
  assert.match(stopLossBlock, /"conviction_stop_loss"/);
  assert.doesNotMatch(
    stopLossBlock,
    /decisionMode\s*===\s*"conviction"|decisionMode\s*===\s*"fastlane"/,
    "entry decision mode must not gate active-position stop-loss protection",
  );

  const reconciliationIndex = loopSource.indexOf("reconcileActiveRegularExitIntent(pos.id)");
  const expiryIndex = loopSource.indexOf("Always run window-expiry check");
  const pausedGateIndex = loopSource.indexOf(
    "if (!S.config.enabled || S.paused) return",
    reconciliationIndex,
  );
  assert.ok(reconciliationIndex >= 0, "active live exits must be reconciled automatically");
  assert.ok(
    reconciliationIndex < expiryIndex,
    "live-exit reconciliation must run before window-expiry accounting",
  );
  assert.ok(
    reconciliationIndex < pausedGateIndex,
    "live-exit reconciliation must run while trading is paused or disabled",
  );
  assert.match(loopSource, /reconciledLiveFill:/);
  assert.match(loopSource, /positionsWithBlockedExitLifecycle\.has\(stalePos\.id\)/);

  const dbSource = readFileSync(new URL("./kalshi-bot-db.ts", import.meta.url), "utf8");
  assert.match(dbSource, /hasActiveRegularExitIntent\("live", row\.id\)/);
  assert.match(dbSource, /restoring expired-window position with active live exit for reconciliation/);
  assert.match(dbSource, /exit_intent\.status IN \('reserved','unknown','filled'\)/);
  assert.match(dbSource, /historicalExitRecoveryPositions\.set\(row\.id, recoveredPosition\)/);
  assert.doesNotMatch(
    dbSource,
    /if \(windowKey !== currentKey\)[\s\S]{0,1200}openPositions\.set\(row\.symbol/,
    "historical unresolved exits must not overwrite a current same-symbol position",
  );
  assert.match(loopSource, /historicalExitRecoveryPositions\.values\(\)/);
  assert.match(loopSource, /historicalExitRecoveryPositions\.delete\(pos\.id\)/);

  const manualSource = readFileSync(new URL("./kalshi-bot-manual.ts", import.meta.url), "utf8");
  const manualRecoveryGuard = manualSource.indexOf("historicalExitRecoveryPositions.values()");
  const manualBrokerSubmit = manualSource.indexOf("await placeOrderWithRetry(");
  assert.ok(manualRecoveryGuard >= 0, "manual orders must check historical exit recovery");
  assert.ok(
    manualRecoveryGuard < manualBrokerSubmit,
    "manual recovery guard must run before any broker submission",
  );
  assert.match(manualSource, /older live exit still pending reconciliation/);
});

test("one slow market poll cannot serialize every FastLane symbol", () => {
  const source = readFileSync(new URL("./kalshi-conviction-poller.ts", import.meta.url), "utf8");
  assert.match(source, /const marketPollsInFlight = new PerKeyInFlight\(\)/);
  assert.match(source, /marketPollsInFlight\.run\(sym,/);
  assert.match(source, /stopConvictionPoller[\s\S]*marketPollsInFlight\.clear\(\)/);
  assert.doesNotMatch(source, /pollOnceInFlight/);
});