import { CRYPTO_COINS, getCachedPrediction, getKalshiCachedData, predCache } from "./crypto.ts";
import { dashboard2KalshiOrderbookService } from "./kalshi-orderbook-service.ts";
import { isDashboard2ExecutionOwnerCurrent, readDashboard2ExecutionOwner, type Dashboard2ExecutionOwner } from "./dashboard2-ownership.ts";
import { evaluateDashboard2SafetyGate } from "./dashboard2-safety-gate.ts";
import { completeDashboard2PaperExit, dashboard2SafetyAuthorizations, dashboard2V2EntryState, dashboard2V2LiveReadiness, dashboard2V2OpenPositionsForExit, dashboard2V2RecentEvents, isDashboard2V2ConfigCurrent, readDashboard2V2Config, readDashboard2V2SelectedMode, reconcileDashboard2V2LiveUnknowns, reserveDashboard2V2Entry, reserveDashboard2V2Exit, runDashboard2PaperCandidate, settleDashboard2V2PriorWindows, submitDashboard2LiveExit, submitDashboard2LiveIoc } from "./dashboard2-v2.ts";
import { getBalance } from "./kalshi-trader.ts";
import { readCanonicalBotConfig } from "./kalshi-bot-state.ts";
import { applyDashboard2CanonicalPolicy } from "./dashboard2-canonical-policy.ts";
import { selectDashboard2KalshiDirection } from "./dashboard2-kalshi-direction.ts";
import {
  retainDashboard2MarketDisplay,
  type Dashboard2MarketDisplaySnapshot,
} from "./dashboard2-display-retention.ts";

type ReadinessStatus = "ready" | "warming" | "blocked" | "stale";
type WindowPhase = "preparing" | "armed" | "eligible" | "blocked";

const lastMarketDisplayBySymbol = new Map<string, Dashboard2MarketDisplaySnapshot>();

/** Scheduler-owned V2 entry and protective-exit execution primitive. */
const fresh = (at: unknown, now: number, maxAgeMs = 30_000) => typeof at === "number" && now - at >= 0 && now - at <= maxAgeMs;
export function dashboard2QuietHoursAllows(config: { enabled: boolean; startUtc: number; endUtc: number }, now: number): boolean {
  if (!config.enabled) return true;
  const h = new Date(now).getUTCHours();
  return config.startUtc === config.endUtc ? false : config.startUtc < config.endUtc ? !(h >= config.startUtc && h < config.endUtc) : !(h >= config.startUtc || h < config.endUtc);
}
function directionAndProximity(symbol: string, target: number | null | undefined, now: number) {
  const spot = getCachedPrediction(symbol);
  const spotPrice = spot?.price;
  const spotFresh = Boolean(spot && fresh(predCache.get(symbol)?.at, now));
  const distancePct = target != null && spotPrice != null && spotPrice > 0 ? Math.abs(target - spotPrice) / spotPrice * 100 : null;
  return { spotPrice: spotPrice ?? null, spotFresh, distancePct };
}

function contractCeilingForDollarStake(config: { maxDollarBudget: number; sideCostFloor: number }): number {
  if (!Number.isFinite(config.maxDollarBudget) || config.maxDollarBudget <= 0) return 0;
  if (!Number.isFinite(config.sideCostFloor) || config.sideCostFloor <= 0) return 0;
  return Math.max(1, Math.ceil(config.maxDollarBudget / config.sideCostFloor));
}

function distanceFromEntryBand(cost: number, floor: number, ceiling: number): number {
  return cost < floor ? floor - cost : cost > ceiling ? cost - ceiling : 0;
}

function kalshiDirectionEvidence(selection: NonNullable<ReturnType<typeof selectDashboard2KalshiDirection>>) {
  const snapshot = selection.snapshot;
  return {
    source: "dashboard2_kalshi_websocket_top_of_book",
    selectedSide: selection.side,
    selectedAsk: selection.ask,
    yesAsk: snapshot.yesAsk,
    yesBid: snapshot.yesBid,
    noAsk: snapshot.noAsk,
    noBid: snapshot.noBid,
    ticker: snapshot.ticker,
    updatedAt: new Date(snapshot.updatedAt).toISOString(),
    ageMs: Math.max(0, Date.now() - snapshot.updatedAt),
    bookVersion: snapshot.bookVersion,
  };
}

function decisionReasonLabel(reason: string | null): string {
  const labels: Record<string, string> = {
    side_cost_below_floor: "ask is below the entry band",
    side_cost_above_ceiling: "ask is above the entry band",
    book_stale: "order book is refreshing; showing the last same-window quote",
    book_freshness_unknown: "waiting for a fresh order book",
    side_cost_unknown: "waiting for a live ask",
    entry_window_not_open: "entry window has not opened",
    canonical_smart_hours_blocked: "Smart Hours blocked this entry",
    canonical_smart_hours_forced_paper: "Smart Hours allows paper observation only",
    canonical_coin_paused: "this market is paused",
    canonical_budget_below_one_contract: "dollar stake is below one contract",
    kalshi_direction_ambiguous: "both YES and NO asks are in range; no direction selected",
    no_direct_ask_in_entry_band: "neither direct ask is inside the entry band",
    no_executable_depth: "selected direction has no complete executable contract",
    awaiting_current_window_quote: "showing the previous window while the current market warms up",
    waiting_for_first_quote: "waiting for the first authenticated quote",
    execution_observation_only: "monitoring current candidate",
  };
  return reason ? labels[reason] ?? reason.replaceAll("_", " ") : "monitoring";
}

/** Selected-mode executor. Both modes build precisely the same evidence and
 * only diverge after the pure safety decision has authorized a quantity. */
export async function runDashboard2Orchestrator(now = Date.now()): Promise<void> {
  // Settlement progresses even while entries are paused or after a restart.
  await settleDashboard2V2PriorWindows();
  const windowStart = Math.floor(now / (15 * 60_000)) * (15 * 60_000);
  const windowKey = new Date(windowStart).toISOString().slice(0, 16);
  const elapsedMinutes = (now - windowStart) / 60_000;
  // Dashboard2 owns the complete lifecycle of its positions. Entry ownership
  // and the selected mode never disable protective exits.
  const exitConfigs = {
    paper: (await readDashboard2V2Config("paper")).config,
    live: (await readDashboard2V2Config("live")).config,
  };
  for (const position of await dashboard2V2OpenPositionsForExit()) {
    const exitConfig = exitConfigs[position.mode];
    if (!exitConfig.stopLoss.enabled || elapsedMinutes < exitConfig.stopLoss.activationMinute) continue;
    const remaining = position.filledContracts - position.exitedContracts;
    const quote = dashboard2KalshiOrderbookService.getExecutableSell(position.ticker, position.side, remaining);
    if (!quote || quote.sideProceeds > exitConfig.stopLoss.floor) continue;
    const count = Math.min(remaining, quote.visibleContracts);
    const reservation = await reserveDashboard2V2Exit(position, quote, count);
    if (!reservation) continue;
    if (position.mode === "paper") {
      await completeDashboard2PaperExit(reservation.id, quote, count);
    } else {
      await submitDashboard2LiveExit({
        position, quote, count, reservation,
        preSubmitGuard: () => {
          const current = dashboard2KalshiOrderbookService.getExecutableSell(position.ticker, position.side, remaining);
          return isDashboard2V2ConfigCurrent("live", exitConfig) &&
            current?.bookVersion === quote.bookVersion &&
            current.sideProceeds === quote.sideProceeds &&
            current.visibleContracts >= count;
        },
      });
    }
  }
  const selected = await readDashboard2V2SelectedMode();
  const mode = selected.selectedMode;
  const config = (await readDashboard2V2Config(mode)).config;
  const dollarDerivedMaxContracts = contractCeilingForDollarStake(config);
  const owner = await readDashboard2ExecutionOwner();
  if (!config.enabled) return;
  if (mode === "live") await reconcileDashboard2V2LiveUnknowns();
  const liveReadiness = mode === "live" ? await dashboard2V2LiveReadiness() : null;
  if (mode === "live" && (!liveReadiness?.activationReady || owner.owner !== "dashboard2_bot")) return;
  let remainingFunding = mode === "live"
    ? await getBalance()
        .then((balance) => Math.max(0, Math.min(config.maxDollarBudget, balance.availableBalance - config.minAccountBalance)))
        .catch(() => null)
    : config.maxDollarBudget;
  // Do not consume the unique per-window ledger key before entry is legal.
  // A pre-entry observation is not an execution attempt.
  for (const { symbol } of CRYPTO_COINS) {
    if (!config.enabledSymbols.includes(symbol.toUpperCase())) continue;
    const target = getKalshiCachedData(symbol);
    const ticker = target?.ticker;
    const topOfBook = ticker ? dashboard2KalshiOrderbookService.getTopOfBook(ticker) : null;
    const directionSelection = selectDashboard2KalshiDirection(
      topOfBook,
      config.sideCostFloor,
      config.sideCostCeiling,
    );
    const quote = ticker && directionSelection
      ? dashboard2KalshiOrderbookService.getExecutable(
          ticker,
          directionSelection.side,
          dollarDerivedMaxContracts,
          config.sideCostFloor,
          config.sideCostCeiling,
        )
      : null;
    if (!quote) continue; // never consume a window before exact executable depth
    const entryDecisionEvidence = kalshiDirectionEvidence(directionSelection!);
    const exactTicker = quote.ticker;
    const state = await dashboard2V2EntryState(mode, symbol, windowKey);
    const signal = directionAndProximity(symbol, target?.value, now);
    const funding = remainingFunding;
    // Canonical controls are evaluated independently of Dashboard 2's legacy
    // UTC quiet-hours switch. A missing snapshot is deliberately a block.
    const canonicalPreview = applyDashboard2CanonicalPolicy({
      canonicalConfig: readCanonicalBotConfig(), symbol, mode, sideCost: quote.sideCost,
      dashboardBudget: config.maxDollarBudget, maxContracts: dollarDerivedMaxContracts,
      intendedQuantity: dollarDerivedMaxContracts, now: new Date(now),
    });
    const policy = { version: `dashboard2-v2-${config.version}`, minEntryMinute: config.minEntryMinute, sideCostFloor: config.sideCostFloor, sideCostCeiling: config.sideCostCeiling, maxContracts: dollarDerivedMaxContracts };
    const circuitOpen = config.circuitBreaker.enabled && (
       state.dailyPnl <= -config.circuitBreaker.maxDailyLoss ||
       state.consecutiveLosses >= config.circuitBreaker.maxConsecutiveLosses
    );
    const evidence = {
      identity: { symbol, ticker: exactTicker, windowKey, side: quote.side, bookVersion: quote.bookVersion }, elapsedMinutes, sideCost: quote.sideCost,
      sequenceValid: true, bookFresh: dashboard2KalshiOrderbookService.isFresh(exactTicker), signalPreparationComplete: fresh(target?.at, now) && signal.spotFresh,
      hasDuplicateOrOpenPosition: state.conflict || state.positions >= config.maxConcurrentPositions,
      quietHoursAllows: dashboard2QuietHoursAllows(config.quietHours, now) && !circuitOpen && canonicalPreview.allowed,
       directionEvidencePositive: !config.directionGuard.enabled || quote.side === directionSelection!.side,
      targetProximityPositive: !config.proximityGuard.enabled || (signal.distancePct != null && signal.distancePct >= config.proximityGuard.minPct),
      availableFunding: funding, exposureAllowance: state.exposure >= config.maxTotalExposure ? 0 : Math.floor((config.maxTotalExposure - state.exposure) / config.sideCostCeiling),
    };
    // Paper clears the full non-broker gate but never acquires broker
    // capability and therefore does not require the live execution owner.
    const decision = evaluateDashboard2SafetyGate({
      expectedIdentity: evidence.identity,
      evidence,
      policy,
      visibleExecutableDepth: quote.visibleContracts,
      observationOnly: mode === "live" && owner.owner !== "dashboard2_bot",
      paperSimulation: mode === "paper",
      owner: owner.owner,
    });
    const canonicalPolicy = applyDashboard2CanonicalPolicy({
      canonicalConfig: readCanonicalBotConfig(), symbol, mode, sideCost: quote.sideCost,
      dashboardBudget: config.maxDollarBudget, maxContracts: dollarDerivedMaxContracts,
      intendedQuantity: decision.capital.quantity, now: new Date(now),
    });
    if (mode === "paper") {
      if (!decision.executionAuthorized || !canonicalPolicy.allowed) continue;
      const placementPolicy = applyDashboard2CanonicalPolicy({
        canonicalConfig: readCanonicalBotConfig(),
        symbol,
        mode,
        sideCost: quote.sideCost,
        dashboardBudget: config.maxDollarBudget,
        maxContracts: dollarDerivedMaxContracts,
        intendedQuantity: canonicalPolicy.cappedQuantity,
        now: new Date(),
      });
      if (!placementPolicy.allowed) continue;
      const claim = await runDashboard2PaperCandidate({
        symbol,
        windowKey,
        elapsedMinutes,
        quote,
        config,
        authorizedCount: placementPolicy.cappedQuantity,
        decisionEvidence: entryDecisionEvidence,
        preSubmitGuard: (finalState) => {
          try {
            const finalConfig = finalState.config;
            const finalNow = Date.now();
            const finalTarget = getKalshiCachedData(symbol);
            const finalSignal = directionAndProximity(symbol, finalTarget?.value, finalNow);
            const finalTargetFresh = Boolean(
              finalTarget?.value != null
              && finalTarget.ticker === exactTicker
              && fresh(finalTarget.at, finalNow),
            );
            const finalDirectionSelection = selectDashboard2KalshiDirection(
              dashboard2KalshiOrderbookService.getTopOfBook(exactTicker),
              finalConfig.sideCostFloor,
              finalConfig.sideCostCeiling,
            );
            const current = dashboard2KalshiOrderbookService.getExecutable(
              exactTicker,
              quote.side,
              dollarDerivedMaxContracts,
              finalConfig.sideCostFloor,
              finalConfig.sideCostCeiling,
            );
            const finalPolicy = applyDashboard2CanonicalPolicy({
              canonicalConfig: readCanonicalBotConfig(),
              symbol,
              mode,
              sideCost: quote.sideCost,
              dashboardBudget: finalConfig.maxDollarBudget,
              maxContracts: dollarDerivedMaxContracts,
              intendedQuantity: placementPolicy.cappedQuantity,
              now: new Date(finalNow),
            });
            if (
              finalDirectionSelection?.side !== quote.side
              || !current
              || current.bookVersion !== quote.bookVersion
              || current.sideCost !== quote.sideCost
              || current.marginalLimitCost !== quote.marginalLimitCost
              || current.visibleContracts < placementPolicy.cappedQuantity
              || !finalPolicy.allowed
              || finalPolicy.cappedQuantity < placementPolicy.cappedQuantity
              || !isDashboard2V2ConfigCurrent("paper", config)
              || !dashboard2KalshiOrderbookService.isFresh(exactTicker)
            ) return false;
            const finalCircuitOpen = finalConfig.circuitBreaker.enabled && (
              finalState.dailyPnl <= -finalConfig.circuitBreaker.maxDailyLoss
              || finalState.consecutiveLosses >= finalConfig.circuitBreaker.maxConsecutiveLosses
            );
            const finalEvidence = {
              identity: {
                symbol,
                ticker: exactTicker,
                windowKey,
                side: current.side,
                bookVersion: current.bookVersion,
              },
              elapsedMinutes: (finalNow - windowStart) / 60_000,
              sideCost: current.sideCost,
              sequenceValid: true,
              bookFresh: true,
              signalPreparationComplete: finalTargetFresh && finalSignal.spotFresh,
              hasDuplicateOrOpenPosition: finalState.conflict
                || finalState.positions >= finalConfig.maxConcurrentPositions,
              quietHoursAllows: dashboard2QuietHoursAllows(finalConfig.quietHours, finalNow)
                && !finalCircuitOpen
                && finalPolicy.allowed,
              directionEvidencePositive: !finalConfig.directionGuard.enabled
                || current.side === finalDirectionSelection.side,
              targetProximityPositive: !finalConfig.proximityGuard.enabled
                || (
                  finalSignal.distancePct != null
                  && finalSignal.distancePct >= finalConfig.proximityGuard.minPct
                ),
              availableFunding: remainingFunding,
              exposureAllowance: finalState.exposure >= finalConfig.maxTotalExposure
                ? 0
                : Math.floor(
                    (finalConfig.maxTotalExposure - finalState.exposure)
                    / finalConfig.sideCostCeiling,
                  ),
            };
            const finalDecision = evaluateDashboard2SafetyGate({
              expectedIdentity: finalEvidence.identity,
              evidence: finalEvidence,
              policy: {
                version: `dashboard2-v2-${finalConfig.version}`,
                minEntryMinute: finalConfig.minEntryMinute,
                sideCostFloor: finalConfig.sideCostFloor,
                sideCostCeiling: finalConfig.sideCostCeiling,
                maxContracts: dollarDerivedMaxContracts,
              },
              visibleExecutableDepth: current.visibleContracts,
              observationOnly: false,
              paperSimulation: true,
              owner: owner.owner,
            });
            return finalDecision.executionAuthorized
              && finalDecision.capital.quantity >= placementPolicy.cappedQuantity;
          } catch {
            return false;
          }
        },
      });
      if (claim !== "blocked" && claim !== "duplicate") {
        remainingFunding = Math.max(0, (remainingFunding ?? 0) - placementPolicy.cappedQuantity * config.sideCostCeiling);
      }
      continue;
    }
    if (!decision.executionAuthorized || !canonicalPolicy.allowed) continue;
    // Re-resolve just before the durable claim. The config snapshot is never
    // retained across this boundary, so an operator pause/cap wins the race.
    const placementPolicy = applyDashboard2CanonicalPolicy({
      canonicalConfig: readCanonicalBotConfig(), symbol, mode, sideCost: quote.sideCost,
      dashboardBudget: config.maxDollarBudget, maxContracts: dollarDerivedMaxContracts,
      intendedQuantity: canonicalPolicy.cappedQuantity, now: new Date(),
    });
    if (!placementPolicy.allowed) continue;
    const reservation = await reserveDashboard2V2Entry({
      mode: "live",
      symbol,
      windowKey,
      quote,
      requestedContracts: placementPolicy.cappedQuantity,
      config,
      decisionEvidence: entryDecisionEvidence,
    });
    if (!reservation) continue;
    remainingFunding = Math.max(0, (remainingFunding ?? 0) - placementPolicy.cappedQuantity * config.sideCostCeiling);
    const authorization = dashboard2SafetyAuthorizations.issue({ mode, symbol, ticker: exactTicker, windowKey, side: quote.side, bookVersion: quote.bookVersion }, policy);
    await submitDashboard2LiveIoc({ symbol, windowKey, quote, count: placementPolicy.cappedQuantity, owner: owner.owner, activationReady: true, reservation, preSubmitGuard: () => {
      const finalDirectionSelection = selectDashboard2KalshiDirection(
        dashboard2KalshiOrderbookService.getTopOfBook(exactTicker),
        config.sideCostFloor,
        config.sideCostCeiling,
      );
      const current = dashboard2KalshiOrderbookService.getExecutable(exactTicker, quote.side, dollarDerivedMaxContracts, config.sideCostFloor, config.sideCostCeiling);
      const finalPolicy = applyDashboard2CanonicalPolicy({
        canonicalConfig: readCanonicalBotConfig(), symbol, mode, sideCost: quote.sideCost,
        dashboardBudget: config.maxDollarBudget, maxContracts: dollarDerivedMaxContracts,
        intendedQuantity: placementPolicy.cappedQuantity,
      });
      const consumed = dashboard2SafetyAuthorizations.consume(authorization.token, { mode, symbol, ticker: exactTicker, windowKey, side: quote.side, policyVersion: policy.version, bookVersion: quote.bookVersion });
      return consumed.accepted &&
        finalDirectionSelection?.side === quote.side &&
        finalPolicy.allowed &&
        finalPolicy.cappedQuantity >= placementPolicy.cappedQuantity &&
        isDashboard2ExecutionOwnerCurrent("dashboard2_bot") &&
        isDashboard2V2ConfigCurrent("live", config) &&
        current?.bookVersion === quote.bookVersion &&
         current.sideCost === quote.sideCost &&
         current.marginalLimitCost === quote.marginalLimitCost &&
          current.visibleContracts >= placementPolicy.cappedQuantity;
    }});
  }
}
export const runDashboard2PaperOrchestrator = runDashboard2Orchestrator;

function asIsoString(value: unknown, fallback: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

export async function getDashboard2RuntimeStatus(
  owner: Dashboard2ExecutionOwner,
  ownershipUpdatedAt = new Date().toISOString(),
) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const windowStart = Math.floor(now / (15 * 60_000)) * (15 * 60_000);
  const windowKey = new Date(windowStart).toISOString().slice(0, 16);
  const selected = await readDashboard2V2SelectedMode();
  const selectedConfig = await readDashboard2V2Config(selected.selectedMode);
  const dollarDerivedMaxContracts = contractCeilingForDollarStake(selectedConfig.config);
  const canonicalConfigAvailable = readCanonicalBotConfig() !== null;
  const liveReadiness = selected.selectedMode === "live" ? await dashboard2V2LiveReadiness() : { activationReady: false, reasons: [] as string[] };
  const policy = { version: `dashboard2-v2-${selectedConfig.config.version}`, minEntryMinute: selectedConfig.config.minEntryMinute, sideCostFloor: selectedConfig.config.sideCostFloor, sideCostCeiling: selectedConfig.config.sideCostCeiling, maxContracts: dollarDerivedMaxContracts } as const;

  const elapsedSeconds = Math.max(0, Math.floor((now - windowStart) / 1_000));
  const entryOpensInSeconds = Math.max(0, policy.minEntryMinute * 60 - elapsedSeconds);
  const cachedMarkets = CRYPTO_COINS.map(({ symbol }) => {
    const normalized = symbol.toUpperCase();
    const market = getKalshiCachedData(normalized);
    const signal = directionAndProximity(normalized, market?.value, now);
    const previousDisplay = lastMarketDisplayBySymbol.get(normalized);
    const currentTicker = market?.ticker ?? null;
    const topOfBook = currentTicker ? dashboard2KalshiOrderbookService.getTopOfBook(currentTicker) : null;
    const executionDirectionSelection = selectDashboard2KalshiDirection(
      topOfBook,
      policy.sideCostFloor,
      policy.sideCostCeiling,
    );
    const displayDirectionSelection = selectDashboard2KalshiDirection(
      topOfBook,
      policy.sideCostFloor,
      policy.sideCostCeiling,
      true,
    );
    const liveQuotes = currentTicker
      ? (["yes", "no"] as const)
          .map(side => dashboard2KalshiOrderbookService.getExecutable(
            currentTicker, side, policy.maxContracts, 0.01, 0.99,
          ))
          .filter((book): book is NonNullable<typeof book> => book !== null)
          .sort((a, b) =>
            distanceFromEntryBand(a.sideCost, policy.sideCostFloor, policy.sideCostCeiling)
            - distanceFromEntryBand(b.sideCost, policy.sideCostFloor, policy.sideCostCeiling)
          )
      : [];
    const currentDisplayQuote = displayDirectionSelection
      ? liveQuotes.find(quote => quote.side === displayDirectionSelection.side) ?? null
      : null;
    const currentDisplaySnapshot: Dashboard2MarketDisplaySnapshot | null =
      currentTicker && topOfBook
        ? {
            sourceWindowKey: windowKey,
            ticker: currentTicker,
            target: market?.value ?? null,
            side: displayDirectionSelection?.side ?? null,
            selectedAsk: displayDirectionSelection?.ask ?? null,
            yesAsk: topOfBook.yesAsk,
            noAsk: topOfBook.noAsk,
            executableCost: currentDisplayQuote?.sideCost ?? null,
            visibleContracts: currentDisplayQuote?.visibleContracts ?? 0,
            bookVersion: topOfBook.bookVersion,
            observedAt: topOfBook.updatedAt,
          }
        : null;
    const retainedDisplay = retainDashboard2MarketDisplay(
      previousDisplay ?? null,
      currentDisplaySnapshot,
      windowKey,
    );
    if (currentDisplaySnapshot) lastMarketDisplayBySymbol.set(normalized, currentDisplaySnapshot);
    const display = retainedDisplay.snapshot;
    const target = market?.value ?? display?.target ?? null;
    const quoteInBand = Boolean(
      currentDisplayQuote
      && executionDirectionSelection
      && currentDisplayQuote.side === executionDirectionSelection.side,
    );
    const eligibleSide = quoteInBand ? currentDisplayQuote : null;
    const dualInBand = Boolean(
      topOfBook
      && topOfBook.yesAsk !== null
      && topOfBook.noAsk !== null
      && topOfBook.yesAsk >= policy.sideCostFloor
      && topOfBook.yesAsk <= policy.sideCostCeiling
      && topOfBook.noAsk >= policy.sideCostFloor
      && topOfBook.noAsk <= policy.sideCostCeiling,
    );
    const bookFresh = Boolean(
      currentTicker
      && dashboard2KalshiOrderbookService.isFresh(currentTicker)
      && display?.ticker === currentTicker
      && retainedDisplay.state === "live",
    );
    const canonicalPolicy = eligibleSide
      ? applyDashboard2CanonicalPolicy({
          canonicalConfig: readCanonicalBotConfig(), symbol: normalized, mode: selected.selectedMode,
          sideCost: eligibleSide.sideCost, dashboardBudget: selectedConfig.config.maxDollarBudget,
          maxContracts: dollarDerivedMaxContracts, intendedQuantity: dollarDerivedMaxContracts,
          now: new Date(now),
        })
      : null;

    const safetyDecision = evaluateDashboard2SafetyGate({
      expectedIdentity: {
         symbol: normalized, ticker: currentTicker, windowKey, side: currentDisplayQuote?.side ?? null,
         bookVersion: currentDisplayQuote?.bookVersion ?? null,
      },
      evidence: {
        identity: {
           symbol: normalized, ticker: currentTicker, windowKey, side: currentDisplayQuote?.side ?? null,
           bookVersion: currentDisplayQuote?.bookVersion ?? null,
        },
        elapsedMinutes: elapsedSeconds / 60,
         sideCost: currentDisplayQuote?.sideCost ?? null,
         sequenceValid: currentDisplayQuote ? true : null,
        bookFresh: currentTicker ? bookFresh : null,
        signalPreparationComplete: null,
        // These require legacy state or broad imports; Dashboard 2 observes them
        // as unknown rather than reading or mutating execution state.
        hasDuplicateOrOpenPosition: null, quietHoursAllows: eligibleSide ? canonicalPolicy!.allowed : null, directionEvidencePositive: null,
        targetProximityPositive: null, availableFunding: null, exposureAllowance: null,
      },
       policy, visibleExecutableDepth: currentDisplayQuote?.visibleContracts ?? null,
      observationOnly: true, owner,
    });
    const reason = dualInBand
      ? "kalshi_direction_ambiguous"
      : retainedDisplay.state === "previous_window"
      ? "awaiting_current_window_quote"
      : retainedDisplay.state === "refreshing"
      ? "book_stale"
      : retainedDisplay.state === "waiting"
      ? "waiting_for_first_quote"
      : !executionDirectionSelection
      ? "no_direct_ask_in_entry_band"
      : !currentDisplayQuote
      ? "no_executable_depth"
      : canonicalPolicy?.reason ?? safetyDecision.blockingReason ?? "execution_observation_only";

    return {
      symbol: normalized,
      ticker: display?.ticker ?? currentTicker,
      side: display?.side ?? null,
      sideCost: display?.selectedAsk ?? null,
      executableCost: display?.executableCost ?? null,
      yesAsk: display?.yesAsk ?? null,
      noAsk: display?.noAsk ?? null,
      quoteAgeMs: display ? Math.max(0, now - display.observedAt) : null,
      displayState: retainedDisplay.state,
      displaySourceWindowKey: display?.sourceWindowKey ?? null,
      visibleContracts: display?.visibleContracts ?? 0,
      target,
      spot: signal.spotPrice,
      distancePct: signal.distancePct,
      intendedQuantity: canonicalPolicy?.cappedQuantity ?? 0,
      effectiveBudget: canonicalPolicy?.effectiveBudget ?? null,
      sizingReason: canonicalPolicy?.limitingReason ?? null,
      bookVersion: display?.bookVersion ?? null,
      bookFresh,
       safety: eligibleSide && canonicalPolicy?.allowed ? ("waiting" as const) : ("blocked" as const),
      reason,
      signalsReady: false, preparing: false,
    };
  });
  const preparedMarketCount = cachedMarkets.filter((market) => market.ticker !== null).length;
  const bookConnection = dashboard2KalshiOrderbookService.getStatus();
  const persistedEvents = await dashboard2V2RecentEvents(selected.selectedMode, 20);
  const activeDecisionEvents = cachedMarkets.map((market) => {
    const hasAsk = market.side !== null && market.sideCost !== null;
    const inBand = hasAsk
      && market.sideCost! >= policy.sideCostFloor
      && market.sideCost! <= policy.sideCostCeiling;
    const action = inBand
      && market.reason !== "kalshi_direction_ambiguous"
      && !market.reason?.startsWith("canonical_")
      ? "WATCH"
      : "SKIP";
    const ask = hasAsk ? ` ${market.side!.toUpperCase()} ${(market.sideCost! * 100).toFixed(1)}c` : "";
    return {
      id: `decision:${windowKey}:${market.symbol}:${market.side ?? "none"}:${market.reason ?? "none"}`,
      at: nowIso,
      type: `decision.${action.toLowerCase()}`,
      message: `${action} ${market.symbol}${ask} - ${decisionReasonLabel(market.reason)}`,
      severity: action === "SKIP" ? ("warning" as const) : ("info" as const),
    };
  });
  const recentEvents = [...activeDecisionEvents, ...persistedEvents].slice(0, 32);
  const readiness: Array<{
    id: string;
    label: string;
    status: ReadinessStatus;
    detail: string;
    updatedAt: string | null;
  }> = [
    {
      id: "market-discovery",
      label: "Market discovery",
      status: preparedMarketCount > 0 ? "ready" : "warming",
      detail: `${preparedMarketCount}/${cachedMarkets.length} current tickers prepared`,
      updatedAt: nowIso,
    },
    {
      id: "strategy-preparation",
      label: "Strategy preparation",
       status: canonicalConfigAvailable ? "ready" : "blocked",
       detail: "Fresh market identity, direction, proximity, portfolio, and capital evidence is rebuilt for every entry",
       updatedAt: canonicalConfigAvailable ? nowIso : null,
    },
    {
      id: "entry-timing",
      label: "Entry timing",
      status: entryOpensInSeconds === 0 ? "ready" : "warming",
      detail:
        entryOpensInSeconds === 0
          ? `Configured T+${policy.minEntryMinute}m boundary is open`
          : `Preparing for ${entryOpensInSeconds}s before entry eligibility`,
      updatedAt: nowIso,
    },
    {
      id: "live-book-depth",
      label: "Qualifying book depth",
      status: bookConnection.ready
        ? cachedMarkets.some(market => market.visibleContracts > 0) ? "ready" : "warming"
        : "stale",
      detail: bookConnection.ready
        ? `${cachedMarkets.filter(market => market.visibleContracts > 0).length}/${cachedMarkets.length} markets have fresh ${Math.round(policy.sideCostFloor * 100)}–${Math.round(policy.sideCostCeiling * 100)}¢ executable depth`
        : `Authenticated stream disconnected; reconnect attempt ${bookConnection.reconnectAttempt}`,
      updatedAt: bookConnection.connectedAt,
    },
    {
      id: "safety-gate",
      label: "Safety Gate",
      status: selected.selectedMode === "paper"
        ? selectedConfig.config.enabled && canonicalConfigAvailable ? "ready" : "blocked"
        : liveReadiness.activationReady ? "ready" : "blocked",
       detail: selected.selectedMode === "live"
         ? (liveReadiness.activationReady ? "Live Safety Gate is ready" : liveReadiness.reasons.join(", "))
         : "Paper fills require the complete live-equivalent Safety Gate; only broker ownership and submission are simulated",
      updatedAt: nowIso,
    },
    {
      id: "buy-executor",
      label: "Buy executor",
      status: selected.selectedMode === "paper"
        ? selectedConfig.config.enabled ? "ready" : "blocked"
        : liveReadiness.activationReady && owner === "dashboard2_bot" ? "ready" : "blocked",
       detail: selected.selectedMode === "live"
         ? "IOC executor is guarded by one-use authorization"
         : "Paper executor simulates a fill only after final quote, policy, and portfolio revalidation",
      updatedAt: nowIso,
    },
    {
      id: "canonical-entry-controls",
      label: "Canonical entry controls",
      status: canonicalConfigAvailable ? "ready" : "blocked",
      detail: canonicalConfigAvailable
        ? "Smart Quiet Hours and per-coin overrides are enforced at sizing and placement"
        : "Canonical BotConfig is unavailable; Dashboard 2 entries fail closed",
      updatedAt: canonicalConfigAvailable ? nowIso : null,
    },
  ];
  const phase: WindowPhase =
    owner === "paused"
      ? "blocked"
      : entryOpensInSeconds > 60
        ? "preparing"
        : entryOpensInSeconds > 0
          ? "armed"
          : "eligible";

  return {
    system: {
      executionOwner: owner,
       observationOnly: selected.selectedMode !== "live" || owner !== "dashboard2_bot" || !liveReadiness.activationReady,
      updatedAt: ownershipUpdatedAt,
      bookConnection,
      selectedMode: selected.selectedMode,
      running: selectedConfig.config.enabled,
       readiness: liveReadiness,
    },
    policy,
    window: {
      key: windowKey,
      elapsedSeconds,
      entryOpensInSeconds,
      phase,
    },
    readiness,
    markets: cachedMarkets.map(({ signalsReady: _signalsReady, preparing: _preparing, ...market }) => market),
    recentEvents,
  };
}