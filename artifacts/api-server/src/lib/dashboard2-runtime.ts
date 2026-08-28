import { CRYPTO_COINS, getKalshiCachedData } from "./crypto.ts";
import { getBotState, getWindowEvaluation } from "./kalshi-bot.ts";
import { getAllPipelineResults, getInFlightDetails } from "./kalshi-bot-pipeline.ts";
import { createDashboard2Policy } from "./dashboard2-policy.ts";
import { dashboard2KalshiOrderbookService } from "./kalshi-orderbook-service.ts";
import type { Dashboard2ExecutionOwner } from "./dashboard2-ownership.ts";
import { evaluateDashboard2SafetyGate } from "./dashboard2-safety-gate.ts";

type ReadinessStatus = "ready" | "warming" | "blocked" | "stale";
type WindowPhase = "preparing" | "armed" | "eligible" | "blocked";

function asIsoString(value: unknown, fallback: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

export function getDashboard2RuntimeStatus(
  owner: Dashboard2ExecutionOwner,
  ownershipUpdatedAt = new Date().toISOString(),
) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const windowStart = Math.floor(now / (15 * 60_000)) * (15 * 60_000);
  const windowKey = new Date(windowStart).toISOString().slice(0, 16);
  const bot = getBotState();
  const policy = createDashboard2Policy(bot.config.maxBetSize);
  const results = getAllPipelineResults().filter((result) => result.windowKey === windowKey);
  const resultBySymbol = new Map(results.map((result) => [result.sym.toUpperCase(), result]));
  const inFlight = new Set(
    getInFlightDetails()
      .filter((entry) => entry.windowKey === windowKey)
      .map((entry) => entry.sym.toUpperCase()),
  );
  const evaluations = new Map(
    getWindowEvaluation()
      .filter((entry) => entry.windowKey === windowKey)
      .map((entry) => [entry.symbol.toUpperCase(), entry]),
  );

  const elapsedSeconds = Math.max(0, Math.floor((now - windowStart) / 1_000));
  const entryOpensInSeconds = Math.max(0, policy.minEntryMinute * 60 - elapsedSeconds);
  const cachedMarkets = CRYPTO_COINS.map(({ symbol }) => {
    const normalized = symbol.toUpperCase();
    const pipeline = resultBySymbol.get(normalized);
    const market = getKalshiCachedData(normalized);
    const ticker = market?.ticker;
    const executable = ticker
      ? (["yes", "no"] as const)
          .map(side => dashboard2KalshiOrderbookService.getExecutable(
            ticker, side, policy.maxContracts, policy.sideCostFloor, policy.sideCostCeiling,
          ))
          .filter((book): book is NonNullable<typeof book> => book !== null)
          .sort((a, b) => a.sideCost - b.sideCost)[0] ?? null
      : null;
    // The book helper has already constrained this side to the inclusive
    // policy range and capped visible depth. Timing/Safety Gate remain a
    // separate observation-only concern, so the dashboard can show the
    // actual qualifying quote before the entry window opens.
    const eligibleSide = executable;
    const bookFresh = Boolean(ticker && dashboard2KalshiOrderbookService.isFresh(ticker));

    const safetyDecision = evaluateDashboard2SafetyGate({
      expectedIdentity: {
        symbol: normalized, ticker: ticker ?? null, windowKey, side: eligibleSide?.side ?? null,
        bookVersion: eligibleSide?.bookVersion ?? null,
      },
      evidence: {
        identity: {
          symbol: normalized, ticker: ticker ?? null, windowKey, side: eligibleSide?.side ?? null,
          bookVersion: eligibleSide?.bookVersion ?? null,
        },
        elapsedMinutes: elapsedSeconds / 60,
        sideCost: eligibleSide?.sideCost ?? null,
        sequenceValid: eligibleSide ? true : null,
        bookFresh: ticker ? bookFresh : null,
        signalPreparationComplete: pipeline
          ? pipeline.statAbove !== null && pipeline.claudeAbove !== null && pipeline.mlAbove !== null
          : null,
        // These require legacy state or broad imports; Dashboard 2 observes them
        // as unknown rather than reading or mutating execution state.
        hasDuplicateOrOpenPosition: null, quietHoursAllows: null, directionEvidencePositive: null,
        targetProximityPositive: null, availableFunding: null, exposureAllowance: null,
      },
      policy, visibleExecutableDepth: eligibleSide?.visibleContracts ?? null,
      observationOnly: true, owner,
    });
    const reason = safetyDecision.blockingReason ?? "execution_observation_only";

    return {
      symbol: normalized,
      ticker: ticker ?? null,
      side: eligibleSide?.side ?? null,
      sideCost: eligibleSide?.sideCost ?? null,
      visibleContracts: eligibleSide?.visibleContracts ?? 0,
      bookFresh,
       safety: safetyDecision.shadowQualified ? ("waiting" as const) : ("blocked" as const),
      reason,
      signalsReady: Boolean(
        pipeline &&
          pipeline.statAbove !== null &&
          pipeline.claudeAbove !== null &&
          pipeline.mlAbove !== null,
      ),
      preparing: inFlight.has(normalized),
    };
  });
  const preparedMarketCount = cachedMarkets.filter((market) => market.ticker !== null).length;
  const signalsReadyCount = cachedMarkets.filter((market) => market.signalsReady).length;
  const bookConnection = dashboard2KalshiOrderbookService.getStatus();
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
      status: signalsReadyCount > 0 ? "ready" : results.length > 0 ? "warming" : "stale",
      detail: `${signalsReadyCount}/${cachedMarkets.length} signal sets complete; ${inFlight.size} in flight`,
      updatedAt: results.length > 0 ? nowIso : null,
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
      detail: "Authorization contracts are installed; live evaluation remains observation-only",
      updatedAt: nowIso,
    },
    {
      id: "buy-executor",
      label: "Buy executor",
      status: "blocked",
      detail: "No Dashboard 2.0 broker submission authority exists",
      updatedAt: null,
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
      observationOnly: true,
      updatedAt: ownershipUpdatedAt,
      bookConnection,
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
    recentEvents: Array.from(evaluations.values())
      .sort(
        (a, b) =>
          asIsoString(b.evaluatedAt, nowIso).localeCompare(asIsoString(a.evaluatedAt, nowIso)),
      )
      .slice(0, 20)
      .map((evaluation, index) => ({
        id: `${evaluation.symbol}-${asIsoString(evaluation.evaluatedAt, nowIso)}-${index}`,
        at: asIsoString(evaluation.evaluatedAt, nowIso),
        type: "window_evaluation",
        message: `${evaluation.symbol}: ${evaluation.action} — ${evaluation.reason}`,
        severity:
          evaluation.action === "BET_YES" || evaluation.action === "BET_NO"
            ? ("success" as const)
            : evaluation.action === "SKIP"
              ? ("warning" as const)
              : ("info" as const),
      })),
  };
}