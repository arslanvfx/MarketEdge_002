/**
 * Pure, deliberately non-operational Smart Exit replay and calibration.
 * This module scores supplied, settled lifecycles only.  It neither reads
 * persistence nor changes a Smart Exit configuration.
 */
import type { SmartExitEvaluationRecord } from "./kalshi-smart-exit-types.ts";
import {
  assessSmartExitCrossingRisk,
  SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS,
} from "./kalshi-smart-exit-policy.ts";

export type SmartExitReplayOwner = "regular" | "scalper";
export type SmartExitReplayStatus = "insufficient_data" | "validated" | "rejected";

export interface SmartExitCandidateExit {
  readonly timestampSeconds: number;
  /** Winning-side contract sale price, in dollars (for example, 0.42). */
  readonly contractPrice: number;
  readonly reason: string;
}

export interface SmartExitReplayLifecycle {
  readonly owner: SmartExitReplayOwner;
  readonly symbol: string;
  readonly regime: string;
  readonly entryTimestampSeconds: number;
  readonly expiryTimestampSeconds: number;
  readonly entryContractCost: number;
  readonly quantity: number;
  /** Realized P&L had the position been held through settlement. */
  readonly holdToExpiryPnl: number;
  readonly candidateExit: SmartExitCandidateExit | null;
}

export interface SmartExitSlippageAssumption {
  readonly bps?: number;
  /** Absolute cents deducted from the candidate's exit price. */
  readonly cents?: number;
}

export interface SmartExitOutcomeMetrics {
  readonly samples: number;
  readonly totalPnl: number;
  /** Mean absolute loss across losing observations; zero when there are none. */
  readonly averageLoss: number;
  /** The 10th percentile of P&L; more negative means a worse tail. */
  readonly tenthPercentilePnl: number;
  /** Mean absolute loss in the lowest ten percent of P&Ls. */
  readonly tailLoss: number;
  readonly winRate: number;
}

export interface SmartExitComparison {
  readonly hold: SmartExitOutcomeMetrics;
  readonly candidate: SmartExitOutcomeMetrics;
  readonly totalPnlDelta: number;
  readonly averageLossDelta: number;
  readonly winRateDelta: number;
  readonly falseExits: number;
  /** Exits on positions that ultimately won; explicit alias for operators. */
  readonly missedWins: number;
  readonly avoidedLosses: number;
  readonly avoidedLossDollars: number;
  readonly missedWinDollars: number;
}

export interface SmartExitSlippageResult {
  readonly assumption: Required<SmartExitSlippageAssumption>;
  readonly comparison: SmartExitComparison;
}

export interface SmartExitReplayReport {
  readonly chronologicalLifecycles: readonly SmartExitReplayLifecycle[];
  readonly overall: SmartExitComparison;
  readonly slippage: readonly SmartExitSlippageResult[];
  readonly byOwner: Readonly<Record<string, SmartExitComparison>>;
  readonly bySymbol: Readonly<Record<string, SmartExitComparison>>;
  readonly byRegime: Readonly<Record<string, SmartExitComparison>>;
}

export interface SmartExitCalibrationOptions {
  readonly minSamples?: number;
  readonly holdoutFraction?: number;
  readonly minTrainingSamples?: number;
  readonly minHoldoutSamples?: number;
  /** Largest permitted candidate P&L decline versus hold. */
  readonly maxTotalPnlSacrifice?: number;
  readonly maxWinRateDrop?: number;
  readonly minSegmentSamples?: number;
  /** Applies to every supplied slippage scenario. */
  readonly maxSlippageTotalPnlSacrifice?: number;
  readonly slippageAssumptions?: readonly SmartExitSlippageAssumption[];
}

export interface SmartExitCalibrationResult {
  readonly status: SmartExitReplayStatus;
  /** Always false: this module is analysis only and can never apply anything. */
  readonly applied: false;
  readonly reasons: readonly string[];
  readonly report: SmartExitReplayReport;
  readonly training: SmartExitComparison | null;
  readonly holdout: SmartExitComparison | null;
}

export interface SmartExitDurableSettlement {
  readonly owner: SmartExitReplayOwner;
  readonly positionId: string;
  readonly symbol: string;
  readonly regime: string;
  readonly entryTimestampSeconds: number;
  readonly expiryTimestampSeconds: number;
  readonly entryContractCost: number;
  readonly quantity: number;
  /** Must come from an authoritative settlement, not an inferred spot result. */
  readonly holdToExpiryPnl: number;
}

export interface SmartExitCrossingCandidateOptions {
  readonly debounceCount?: number;
  readonly confirmationLevel?: number;
  readonly minMarketLossFraction?: number;
  readonly minExitEdge?: number;
  readonly crossingReserveFraction?: number;
  readonly minCrossingReserveSeconds?: number;
  readonly maxCrossingReserveSeconds?: number;
  readonly fatTailVolatilityMultiplier?: number;
  readonly minVolatilityLogReturnPerSqrtSecond?: number;
  /** Maximum gap between samples that can count as sustained one-second evidence. */
  readonly maxSampleGapSeconds?: number;
}

const DEFAULTS = {
  minSamples: 20,
  holdoutFraction: 0.25,
  minTrainingSamples: 10,
  minHoldoutSamples: 5,
  maxTotalPnlSacrifice: 0,
  maxWinRateDrop: 0.05,
  minSegmentSamples: 5,
  maxSlippageTotalPnlSacrifice: 0,
} as const;

interface ResolvedCalibrationOptions {
  readonly minSamples: number;
  readonly holdoutFraction: number;
  readonly minTrainingSamples: number;
  readonly minHoldoutSamples: number;
  readonly maxTotalPnlSacrifice: number;
  readonly maxWinRateDrop: number;
  readonly minSegmentSamples: number;
  readonly maxSlippageTotalPnlSacrifice: number;
  readonly slippageAssumptions: readonly SmartExitSlippageAssumption[];
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function validateLifecycle(item: SmartExitReplayLifecycle): void {
  finite(item.entryTimestampSeconds, "entryTimestampSeconds");
  finite(item.expiryTimestampSeconds, "expiryTimestampSeconds");
  finite(item.entryContractCost, "entryContractCost");
  finite(item.quantity, "quantity");
  finite(item.holdToExpiryPnl, "holdToExpiryPnl");
  if (item.expiryTimestampSeconds < item.entryTimestampSeconds) {
    throw new Error("expiryTimestampSeconds must not precede entryTimestampSeconds");
  }
  if (item.entryContractCost < 0 || item.quantity <= 0) throw new Error("cost must be non-negative and quantity positive");
  if (item.candidateExit) {
    finite(item.candidateExit.timestampSeconds, "candidate exit timestampSeconds");
    finite(item.candidateExit.contractPrice, "candidate exit contractPrice");
    if (item.candidateExit.timestampSeconds < item.entryTimestampSeconds ||
        item.candidateExit.timestampSeconds > item.expiryTimestampSeconds) {
      throw new Error("candidate exit must occur between entry and expiry");
    }
  }
}

function chronological(items: readonly SmartExitReplayLifecycle[]): SmartExitReplayLifecycle[] {
  return [...items].map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.entryTimestampSeconds - b.item.entryTimestampSeconds || a.index - b.index)
    .map(({ item }) => item);
}

function candidatePnl(item: SmartExitReplayLifecycle, slippage: Required<SmartExitSlippageAssumption>): number {
  if (!item.candidateExit) return item.holdToExpiryPnl;
  const reduction = item.candidateExit.contractPrice * slippage.bps / 10_000 + slippage.cents / 100;
  return (item.candidateExit.contractPrice - reduction - item.entryContractCost) * item.quantity;
}

function metrics(values: readonly number[]): SmartExitOutcomeMetrics {
  const sorted = [...values].sort((a, b) => a - b);
  const losses = values.filter((value) => value < 0).map((value) => -value);
  const tailCount = Math.max(1, Math.ceil(values.length * 0.1));
  const tail = sorted.slice(0, tailCount).filter((value) => value < 0).map((value) => -value);
  const percentileIndex = values.length === 0 ? 0 : (values.length - 1) * 0.1;
  const lower = Math.floor(percentileIndex);
  const upper = Math.ceil(percentileIndex);
  const tenth = values.length === 0 ? 0 : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (percentileIndex - lower);
  const sum = (numbers: readonly number[]) => numbers.reduce((total, value) => total + value, 0);
  return {
    samples: values.length, totalPnl: sum(values),
    averageLoss: losses.length ? sum(losses) / losses.length : 0,
    tenthPercentilePnl: tenth, tailLoss: tail.length ? sum(tail) / tail.length : 0,
    winRate: values.length ? values.filter((value) => value > 0).length / values.length : 0,
  };
}

function compare(items: readonly SmartExitReplayLifecycle[], slippage: Required<SmartExitSlippageAssumption>): SmartExitComparison {
  const holdValues = items.map((item) => item.holdToExpiryPnl);
  const candidateValues = items.map((item) => candidatePnl(item, slippage));
  const hold = metrics(holdValues);
  const candidate = metrics(candidateValues);
  const falseExits = items.filter((item) => item.candidateExit !== null && item.holdToExpiryPnl > 0).length;
  const avoidedLosses = items.filter((item, index) =>
    item.candidateExit !== null && item.holdToExpiryPnl < 0 && candidateValues[index]! > item.holdToExpiryPnl,
  ).length;
  const avoidedLossDollars = items.reduce((total, item, index) =>
    item.candidateExit !== null && item.holdToExpiryPnl < 0
      ? total + Math.max(0, candidateValues[index]! - item.holdToExpiryPnl)
      : total, 0);
  const missedWinDollars = items.reduce((total, item, index) =>
    item.candidateExit !== null && item.holdToExpiryPnl > 0
      ? total + Math.max(0, item.holdToExpiryPnl - candidateValues[index]!)
      : total, 0);
  return {
    hold, candidate, totalPnlDelta: candidate.totalPnl - hold.totalPnl,
    averageLossDelta: candidate.averageLoss - hold.averageLoss,
    winRateDelta: candidate.winRate - hold.winRate,
    falseExits,
    missedWins: falseExits,
    avoidedLosses,
    avoidedLossDollars,
    missedWinDollars,
  };
}

function evaluationTimeSeconds(evaluation: SmartExitEvaluationRecord): number {
  return Date.parse(evaluation.timestamp) / 1_000;
}

/**
 * Reconstructs a candidate from durable one-second evaluations. It deliberately
 * accepts authoritative settlements separately so a price sample can never
 * invent the final result. The first fully executable evaluation satisfying
 * the shared crossing policy becomes the candidate exit.
 */
export function buildCrossingRiskReplayLifecycles(
  settlements: readonly SmartExitDurableSettlement[],
  evaluations: readonly SmartExitEvaluationRecord[],
  options: SmartExitCrossingCandidateOptions = {},
): SmartExitReplayLifecycle[] {
  const settings = {
    debounceCount: options.debounceCount ?? 3,
    confirmationLevel: options.confirmationLevel ?? 0.35,
    minMarketLossFraction: options.minMarketLossFraction ?? 0.25,
    minExitEdge: options.minExitEdge ?? 0.01,
    crossingReserveFraction: options.crossingReserveFraction ?? 0.2,
    minCrossingReserveSeconds: options.minCrossingReserveSeconds ?? 5,
    maxCrossingReserveSeconds: options.maxCrossingReserveSeconds ?? 30,
    fatTailVolatilityMultiplier: options.fatTailVolatilityMultiplier ?? 1.25,
    minVolatilityLogReturnPerSqrtSecond:
      options.minVolatilityLogReturnPerSqrtSecond ?? 0.000001,
    maxSampleGapSeconds:
      options.maxSampleGapSeconds ?? SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS,
  };
  const numericSettings = Object.entries(settings);
  for (const [name, value] of numericSettings) finite(value, name);
  if (settings.debounceCount < 1
      || settings.confirmationLevel < 0
      || settings.minMarketLossFraction < 0
      || settings.minExitEdge < 0
      || settings.crossingReserveFraction < 0
      || settings.minCrossingReserveSeconds < 0
      || settings.maxCrossingReserveSeconds < settings.minCrossingReserveSeconds
      || settings.fatTailVolatilityMultiplier <= 0
      || settings.minVolatilityLogReturnPerSqrtSecond <= 0
      || settings.maxSampleGapSeconds <= 0) {
    throw new Error("crossing candidate settings are invalid");
  }

  const evaluationsByPosition = new Map<string, SmartExitEvaluationRecord[]>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.owner}:${evaluation.positionId}`;
    (evaluationsByPosition.get(key) ?? (() => {
      const value: SmartExitEvaluationRecord[] = [];
      evaluationsByPosition.set(key, value);
      return value;
    })()).push(evaluation);
  }

  return settlements.map((settlement) => {
    const key = `${settlement.owner}:${settlement.positionId}`;
    const samples = [...(evaluationsByPosition.get(key) ?? [])]
      .filter((sample) => {
        const at = evaluationTimeSeconds(sample);
        return Number.isFinite(at)
          && at >= settlement.entryTimestampSeconds
          && at <= settlement.expiryTimestampSeconds;
      })
      .sort((a, b) => evaluationTimeSeconds(a) - evaluationTimeSeconds(b));
    let directionalCount = 0;
    let previousSampleAt: number | null = null;
    let candidateExit: SmartExitCandidateExit | null = null;
    for (const sample of samples) {
      const sampleAt = evaluationTimeSeconds(sample);
      const sampleElapsedSeconds = previousSampleAt === null
        ? null
        : sampleAt - previousSampleAt;
      const crossing = sample.underlyingPrice !== null
        && sample.underlyingPrice > 0
        && sample.strikePrice > 0
        && sample.volatilityLogReturnPerSqrtSecond !== null
        ? assessSmartExitCrossingRisk({
            side: sample.side,
            underlyingPrice: sample.underlyingPrice,
            strikePrice: sample.strikePrice,
            remainingSeconds: sample.secondsRemaining,
            volatilityLogReturnPerSqrtSecond: sample.volatilityLogReturnPerSqrtSecond,
            minVolatilityLogReturnPerSqrtSecond:
              settings.minVolatilityLogReturnPerSqrtSecond,
            fatTailVolatilityMultiplier: settings.fatTailVolatilityMultiplier,
            adverseVelocityPerSecond: sample.adverseVelocityPerSecond,
            adverseAccelerationPerSecond2: sample.adverseAccelerationPerSecond2,
            continuationScore: sample.continuationScore,
            confirmationLevel: settings.confirmationLevel,
            previousDirectionalCount: directionalCount,
            sampleElapsedSeconds,
            debounceCount: settings.debounceCount,
            crossingReserveFraction: settings.crossingReserveFraction,
            minCrossingReserveSeconds: settings.minCrossingReserveSeconds,
            maxCrossingReserveSeconds: settings.maxCrossingReserveSeconds,
            maxSampleGapSeconds: settings.maxSampleGapSeconds,
          })
        : null;
      directionalCount = crossing?.directionalCount ?? 0;
      previousSampleAt = sampleAt;
      const fullyExecutable = sample.executionEvidenceReady
        && sample.estimatedSaleValue !== null
        && sample.remainingQuantity > 0
        && sample.liquidityCoverage !== null
        && sample.liquidityCoverage >= 1;
      if (
        crossing?.crossingRiskConfirmed
        && (
          crossing.targetAlreadyCrossed
          || (
            sample.marketLossFraction !== null
            && sample.marketLossFraction >= settings.minMarketLossFraction
          )
        )
        && sample.exitEdgePerContract !== null
        && sample.exitEdgePerContract >= settings.minExitEdge
        && fullyExecutable
      ) {
        candidateExit = {
          timestampSeconds: sampleAt,
          contractPrice: sample.estimatedSaleValue! / sample.remainingQuantity,
          reason: crossing.targetAlreadyCrossed
            ? "actual target crossing with full executable evidence"
            : "sustained projected target crossing with full executable evidence",
        };
        break;
      }
    }
    return {
      owner: settlement.owner,
      symbol: settlement.symbol,
      regime: settlement.regime,
      entryTimestampSeconds: settlement.entryTimestampSeconds,
      expiryTimestampSeconds: settlement.expiryTimestampSeconds,
      entryContractCost: settlement.entryContractCost,
      quantity: settlement.quantity,
      holdToExpiryPnl: settlement.holdToExpiryPnl,
      candidateExit,
    };
  });
}

function groups(items: readonly SmartExitReplayLifecycle[], key: keyof Pick<SmartExitReplayLifecycle, "owner" | "symbol" | "regime">): Record<string, SmartExitReplayLifecycle[]> {
  return items.reduce<Record<string, SmartExitReplayLifecycle[]>>((result, item) => {
    const value = item[key];
    (result[value] ??= []).push(item);
    return result;
  }, {});
}

function groupComparisons(items: readonly SmartExitReplayLifecycle[], key: keyof Pick<SmartExitReplayLifecycle, "owner" | "symbol" | "regime">): Record<string, SmartExitComparison> {
  return Object.fromEntries(Object.entries(groups(items, key)).map(([name, group]) => [name, compare(group, { bps: 0, cents: 0 })]));
}

/** Replay supplied settled lifecycles.  Output order is always entry-time order. */
export function replaySmartExit(lifecycles: readonly SmartExitReplayLifecycle[], slippageAssumptions: readonly SmartExitSlippageAssumption[] = []): SmartExitReplayReport {
  lifecycles.forEach(validateLifecycle);
  const ordered = chronological(lifecycles);
  const normalize = (assumption: SmartExitSlippageAssumption): Required<SmartExitSlippageAssumption> => ({
    bps: assumption.bps ?? 0, cents: assumption.cents ?? 0,
  });
  const assumptions = slippageAssumptions.map(normalize);
  assumptions.forEach((assumption) => {
    if (assumption.bps < 0 || assumption.cents < 0 || !Number.isFinite(assumption.bps) || !Number.isFinite(assumption.cents)) {
      throw new Error("slippage assumptions must be finite and non-negative");
    }
  });
  return {
    chronologicalLifecycles: ordered, overall: compare(ordered, { bps: 0, cents: 0 }),
    slippage: assumptions.map((assumption) => ({ assumption, comparison: compare(ordered, assumption) })),
    byOwner: groupComparisons(ordered, "owner"),
    bySymbol: groupComparisons(ordered, "symbol"),
    byRegime: groupComparisons(ordered, "regime"),
  };
}

function failsStability(label: string, comparison: SmartExitComparison, options: ResolvedCalibrationOptions): string | null {
  if (comparison.totalPnlDelta < -options.maxTotalPnlSacrifice) return `${label} sacrifices too much total P&L`;
  if (comparison.missedWinDollars > comparison.avoidedLossDollars
      && comparison.totalPnlDelta < 0) return `${label} forfeits more through missed wins than it saves from avoided losses`;
  if (comparison.winRateDelta < -options.maxWinRateDrop) return `${label} has an unstable win rate`;
  if (comparison.averageLossDelta > 0) return `${label} increases average loss`;
  return null;
}

/**
 * Scores a candidate using oldest observations for training and newest for
 * holdout.  It never applies a candidate or accepts a mutable configuration.
 */
export function calibrateSmartExit(lifecycles: readonly SmartExitReplayLifecycle[], options: SmartExitCalibrationOptions = {}): SmartExitCalibrationResult {
  const settings: ResolvedCalibrationOptions = {
    minSamples: options.minSamples ?? DEFAULTS.minSamples,
    holdoutFraction: options.holdoutFraction ?? DEFAULTS.holdoutFraction,
    minTrainingSamples: options.minTrainingSamples ?? DEFAULTS.minTrainingSamples,
    minHoldoutSamples: options.minHoldoutSamples ?? DEFAULTS.minHoldoutSamples,
    maxTotalPnlSacrifice: options.maxTotalPnlSacrifice ?? DEFAULTS.maxTotalPnlSacrifice,
    maxWinRateDrop: options.maxWinRateDrop ?? DEFAULTS.maxWinRateDrop,
    minSegmentSamples: options.minSegmentSamples ?? DEFAULTS.minSegmentSamples,
    maxSlippageTotalPnlSacrifice: options.maxSlippageTotalPnlSacrifice ?? DEFAULTS.maxSlippageTotalPnlSacrifice,
    slippageAssumptions: options.slippageAssumptions ?? [],
  };
  const report = replaySmartExit(lifecycles, settings.slippageAssumptions);
  const ordered = report.chronologicalLifecycles;
  const holdoutSize = Math.ceil(ordered.length * settings.holdoutFraction);
  const trainingItems = ordered.slice(0, Math.max(0, ordered.length - holdoutSize));
  const holdoutItems = ordered.slice(trainingItems.length);
  const training = trainingItems.length ? compare(trainingItems, { bps: 0, cents: 0 }) : null;
  const holdout = holdoutItems.length ? compare(holdoutItems, { bps: 0, cents: 0 }) : null;
  const enough = ordered.length >= settings.minSamples &&
    trainingItems.length >= settings.minTrainingSamples && holdoutItems.length >= settings.minHoldoutSamples;
  if (!enough) {
    return { status: "insufficient_data", applied: false, reasons: ["insufficient chronological training or holdout samples"], report, training, holdout };
  }

  const reasons: string[] = [];
  const add = (reason: string | null) => { if (reason) reasons.push(reason); };
  add(failsStability("overall result", report.overall, settings));
  add(failsStability("holdout result", holdout!, settings));
  for (const result of report.slippage) {
    if (result.comparison.totalPnlDelta < -settings.maxSlippageTotalPnlSacrifice) reasons.push("slippage result sacrifices too much total P&L");
    if (result.comparison.averageLossDelta > 0) reasons.push("slippage result increases average loss");
    if (result.comparison.winRateDelta < -settings.maxWinRateDrop) reasons.push("slippage result has an unstable win rate");
  }
  for (const [dimension, records] of [["owner", report.byOwner], ["symbol", report.bySymbol], ["regime", report.byRegime]] as const) {
    for (const [name, comparison] of Object.entries(records)) {
      if (comparison.hold.samples >= settings.minSegmentSamples) add(failsStability(`${dimension}:${name} segment`, comparison, settings));
    }
  }
  return { status: reasons.length ? "rejected" : "validated", applied: false, reasons, report, training, holdout };
}