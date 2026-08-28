import { CRYPTO_COINS, getCachedPrediction, getKalshiCachedData, predCache } from "./crypto.ts";
import { dashboard2KalshiOrderbookService } from "./kalshi-orderbook-service.ts";
import { isDashboard2ExecutionOwnerCurrent, readDashboard2ExecutionOwner, type Dashboard2ExecutionOwner } from "./dashboard2-ownership.ts";
import { evaluateDashboard2SafetyGate } from "./dashboard2-safety-gate.ts";
import { completeDashboard2PaperExit, dashboard2SafetyAuthorizations, dashboard2V2EntryState, dashboard2V2LiveReadiness, dashboard2V2OpenPositionsForExit, dashboard2V2RecentEvents, isDashboard2V2ConfigCurrent, readDashboard2V2Config, readDashboard2V2SelectedMode, reconcileDashboard2V2LiveUnknowns, reserveDashboard2V2Entry, reserveDashboard2V2Exit, runDashboard2PaperCandidate, settleDashboard2V2PriorWindows, submitDashboard2LiveExit, submitDashboard2LiveIoc } from "./dashboard2-v2.ts";
import { getBalance } from "./kalshi-trader.ts";
import { readCanonicalBotConfig } from "./kalshi-bot-state.ts";
import { applyDashboard2CanonicalPolicy } from "./dashboard2-canonical-policy.ts";

type ReadinessStatus = "ready" | "warming" | "blocked" | "stale";
type WindowPhase = "preparing" | "armed" | "eligible" | "blocked";
type Dashboard2DisplayQuote = {
  ticker: string;
  side: "yes" | "no";
  sideCost: number;
  marginalLimitCost: number;
  visibleContracts: number;
  seq: number;
  updatedAt: number;
  bookVersion: string;
};

type Dashboard2MarketDisplaySnapshot = {
  windowKey: string;
  ticker: string | null;
  target: number | null;
  quote: Dashboard2DisplayQuote | null;
};

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
  return { spotPrice: spotPrice ?? null, spotFresh, distancePct, direction: spot?.indicators.trend ?? null };
}

function contractCeilingForDollarStake(config: { maxDollarBudget: number; sideCostFloor: number }): number {
  if (!Number.isFinite(config.maxDollarBudget) || config.maxDollarBudget <= 0) return 0;
  if (!Number.isFinite(config.sideCostFloor) || config.sideCostFloor <= 0) return 0;
  return Math.max(1, Math.ceil(config.maxDollarBudget / config.sideCostFloor));
}

function distanceFromEntryBand(cost: number, floor: number, ceiling: number): number {
  return cost < floor ? floor - cost : cost > ceiling ? cost - ceiling : 0;
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
    const quotes = ticker
      ? (["yes", "no"] as const)
        .map(side => dashboard2KalshiOrderbookService.getExecutable(ticker, side, dollarDerivedMaxContracts, config.sideCostFloor, config.sideCostCeiling))
        .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
        .sort((a, b) => a.sideCost - b.sideCost)
      : [];
    const quote = quotes[0];
    if (!quote) continue; // never consume a window before exact executable depth
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
      directionEvidencePositive: !config.directionGuard.enabled || (quote.side === "yes" ? signal.direction === "up" : signal.direction === "down"),
      targetProximityPositive: !config.proximityGuard.enabled || (signal.distancePct != null && signal.distancePct >= config.proximityGuard.minPct),
      availableFunding: funding, exposureAllowance: state.exposure >= config.maxTotalExposure ? 0 : Math.floor((config.maxTotalExposure - state.exposure) / config.sideCostCeiling),
    };
    // Paper is intentionally an observation authorization: it never acquires
    // broker capability and therefore does not require the live owner.
    const decision = evaluateDashboard2SafetyGate({ expectedIdentity: evidence.identity, evidence, policy, visibleExecutableDepth: quote.visibleContracts, observationOnly: mode === "paper" ? true : !(owner.owner === "dashboard2_bot"), owner: owner.owner });
    const canonicalPolicy = applyDashboard2CanonicalPolicy({
      canonicalConfig: readCanonicalBotConfig(), symbol, mode, sideCost: quote.sideCost,
      dashboardBudget: config.maxDollarBudget, maxContracts: dollarDerivedMaxContracts,
      intendedQuantity: decision.capital.quantity, now: new Date(now),
    });
    if (mode === "paper") {
      if (!decision.shadowQualified || !canonicalPolicy.allowed) continue;
      const claim = await runDashboard2PaperCandidate({ symbol, windowKey, elapsedMinutes, quote, config, authorizedCount: canonicalPolicy.cappedQuantity });
      if (claim !== "blocked" && claim !== "duplicate") {
        remainingFunding = Math.max(0, (remainingFunding ?? 0) - canonicalPolicy.cappedQuantity * config.sideCostCeiling);
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
    const reservation = await reserveDashboard2V2Entry({ mode: "live", symbol, windowKey, quote, requestedContracts: placementPolicy.cappedQuantity, config });
    if (!reservation) continue;
    remainingFunding = Math.max(0, (remainingFunding ?? 0) - placementPolicy.cappedQuantity * config.sideCostCeiling);
    const authorization = dashboard2SafetyAuthorizations.issue({ mode, symbol, ticker: exactTicker, windowKey, side: quote.side, bookVersion: quote.bookVersion }, policy);
    await submitDashboard2LiveIoc({ symbol, windowKey, quote, count: placementPolicy.cappedQuantity, owner: owner.owner, activationReady: true, reservation, preSubmitGuard: () => {
      const current = dashboard2KalshiOrderbookService.getExecutable(exactTicker, quote.side, dollarDerivedMaxContracts, config.sideCostFloor, config.sideCostCeiling);
      const finalPolicy = applyDashboard2CanonicalPolicy({
        canonicalConfig: readCanonicalBotConfig(), symbol, mode, sideCost: quote.sideCost,
        dashboardBudget: config.maxDollarBudget, maxContracts: dollarDerivedMaxContracts,
        intendedQuantity: placementPolicy.cappedQuantity,
      });
      const consumed = dashboard2SafetyAuthorizations.consume(authorization.token, { mode, symbol, ticker: exactTicker, windowKey, side: quote.side, policyVersion: policy.version, bookVersion: quote.bookVersion });
      return consumed.accepted &&
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
    const retainedDisplay = previousDisplay?.windowKey === windowKey ? previousDisplay : null;
    const ticker = market?.ticker ?? retainedDisplay?.ticker ?? null;
    const target = market?.value ?? retainedDisplay?.target ?? null;
    const liveQuotes = ticker
      ? (["yes", "no"] as const)
          .map(side => dashboard2KalshiOrderbookService.getExecutable(
            ticker, side, policy.maxContracts, 0.01, 0.99,
          ))
          .filter((book): book is NonNullable<typeof book> => book !== null)
          .sort((a, b) =>
            distanceFromEntryBand(a.sideCost, policy.sideCostFloor, policy.sideCostCeiling)
            - distanceFromEntryBand(b.sideCost, policy.sideCostFloor, policy.sideCostCeiling)
          )
      : [];
    const freshDisplayQuote = liveQuotes[0] ?? null;
    const displayQuote = freshDisplayQuote
      ?? (retainedDisplay?.quote?.ticker === ticker ? retainedDisplay.quote : null);
    lastMarketDisplayBySymbol.set(normalized, {
      windowKey,
      ticker,
      target,
      quote: displayQuote,
    });
    const quoteInBand = Boolean(
      displayQuote
      && displayQuote.sideCost >= policy.sideCostFloor
      && displayQuote.sideCost <= policy.sideCostCeiling,
    );
    const eligibleSide = quoteInBand ? displayQuote : null;
    const bookFresh = Boolean(ticker && dashboard2KalshiOrderbookService.isFresh(ticker));
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
         symbol: normalized, ticker: ticker ?? null, windowKey, side: displayQuote?.side ?? null,
         bookVersion: displayQuote?.bookVersion ?? null,
      },
      evidence: {
        identity: {
           symbol: normalized, ticker: ticker ?? null, windowKey, side: displayQuote?.side ?? null,
           bookVersion: displayQuote?.bookVersion ?? null,
        },
        elapsedMinutes: elapsedSeconds / 60,
         sideCost: displayQuote?.sideCost ?? null,
         sequenceValid: freshDisplayQuote ? true : displayQuote ? null : null,
        bookFresh: ticker ? bookFresh : null,
        signalPreparationComplete: null,
        // These require legacy state or broad imports; Dashboard 2 observes them
        // as unknown rather than reading or mutating execution state.
        hasDuplicateOrOpenPosition: null, quietHoursAllows: eligibleSide ? canonicalPolicy!.allowed : null, directionEvidencePositive: null,
        targetProximityPositive: null, availableFunding: null, exposureAllowance: null,
      },
       policy, visibleExecutableDepth: displayQuote?.visibleContracts ?? null,
      observationOnly: true, owner,
    });
    const reason = !freshDisplayQuote && displayQuote
      ? "book_stale"
      : canonicalPolicy?.reason ?? safetyDecision.blockingReason ?? "execution_observation_only";

    return {
      symbol: normalized,
      ticker: ticker ?? null,
      side: displayQuote?.side ?? null,
      sideCost: displayQuote?.sideCost ?? null,
      visibleContracts: displayQuote?.visibleContracts ?? 0,
      target,
      spot: signal.spotPrice,
      distancePct: signal.distancePct,
      intendedQuantity: canonicalPolicy?.cappedQuantity ?? 0,
      effectiveBudget: canonicalPolicy?.effectiveBudget ?? null,
      sizingReason: canonicalPolicy?.limitingReason ?? null,
      bookVersion: displayQuote?.bookVersion ?? null,
      bookFresh,
       safety: safetyDecision.shadowQualified ? ("waiting" as const) : ("blocked" as const),
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
    const action = inBand && !market.reason?.startsWith("canonical_") ? "WATCH" : "SKIP";
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
       status: "stale",
       detail: "V2 safety evidence is scheduler-owned and is not read from legacy bot state",
       updatedAt: null,
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
        ? `${cachedMarkets.filter(market => market.visibleContracts > 0).length}/${cachedMarkets.length} markets have fresh 79–85¢ executable depth`
        : `Authenticated stream disconnected; reconnect attempt ${bookConnection.reconnectAttempt}`,
      updatedAt: bookConnection.connectedAt,
    },
    {
      id: "safety-gate",
      label: "Safety Gate",
      status: "blocked",
       detail: selected.selectedMode === "live" ? (liveReadiness.activationReady ? "Live Safety Gate is ready" : liveReadiness.reasons.join(", ")) : "Paper Safety Gate evaluates selected-mode evidence",
      updatedAt: nowIso,
    },
    {
      id: "buy-executor",
      label: "Buy executor",
      status: "blocked",
       detail: selected.selectedMode === "live" ? "IOC executor is guarded by one-use authorization" : "Paper ledger executor",
      updatedAt: null,
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