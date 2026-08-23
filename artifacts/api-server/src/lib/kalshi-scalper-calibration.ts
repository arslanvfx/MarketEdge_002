// Pure, observational calibration. Shadow quotes are deliberately not fills.
import type {
  ScalpMode,
  ScalpPerMarketOverride,
} from "./kalshi-scalper-types.ts";

export interface ScalpCalibrationSettings {
  bandMin: number;
  bandMax: number;
  windowSeconds: number;
  budgetDollars: number;
}

export interface ScalpCalibrationRealOrderEvidence {
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  attemptedAt: string;
  settledAt: string | null;
  pnl: number | null;
}

export interface ScalpCalibrationReservationEvidence {
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  createdAt: string;
  blocker: string | null;
}

export interface ScalpCalibrationFunnelEvidence {
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  occurredAt: string;
  blocker: string | null;
}

export interface ScalpCalibrationShadowEvidence {
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  variantSeconds: number;
  observedAt: string;
  /** A qualifying counterfactual quote, not proof of an order fill. */
  candidate: boolean;
  settledAt: string | null;
  hypotheticalPnl: number | null;
}

export interface ScalpCalibrationRecommendationEvidence {
  attemptedUniqueWindows: number;
  settledRealFills: number;
  orders: number;
  reservations: number;
  funnelEvents: number;
  shadowRecords: number;
  shadowCandidates: number;
  shadowSettlements: number;
}

export type ScalpCalibrationRecommendationStatus =
  | "insufficient_data"
  | "no_change"
  | "recommended"
  | "applied"
  | "reverted"
  | "superseded";

export interface ScalpCalibrationTimingSummary {
  variantSeconds: number;
  candidateCoverage: number;
  trainingCandidates: number;
  holdoutCandidates: number;
  trainingSettlements: number;
  holdoutSettlements: number;
  trainingPnl: number;
  holdoutPnl: number;
}

export interface ScalpCalibrationRecommendation {
  id: string;
  version: number;
  mode: ScalpMode;
  symbol: string;
  status: ScalpCalibrationRecommendationStatus;
  currentSettings: ScalpCalibrationSettings;
  proposedSettings: ScalpCalibrationSettings;
  evidenceCutoff: string;
  analysisStart: string;
  evidence: ScalpCalibrationRecommendationEvidence;
  chronologicalHoldout: {
    current: ScalpCalibrationTimingSummary | null;
    proposed: ScalpCalibrationTimingSummary | null;
  };
  dominantBlockers: Array<{ blocker: string; count: number }>;
  confidence: "low" | "moderate" | "high";
  rationale: string[];
  shadowDisclaimer: string;
  createdAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
}

export interface ScalpCalibrationReport {
  mode: ScalpMode;
  analysisDays: number;
  generatedAt: string | null;
  recommendations: ScalpCalibrationRecommendation[];
  /** Applied records remain available for explicit rollback after a later refresh. */
  activeApplications: ScalpCalibrationRecommendation[];
}

export interface BuildScalpCalibrationRecommendationInput {
  id?: string;
  version?: number;
  mode: ScalpMode;
  symbol: string;
  currentSettings: ScalpCalibrationSettings;
  analysisStart: string;
  evidenceCutoff: string;
  createdAt: string;
  realOrders: ScalpCalibrationRealOrderEvidence[];
  reservations: ScalpCalibrationReservationEvidence[];
  funnelEvents: ScalpCalibrationFunnelEvidence[];
  shadowRecords: ScalpCalibrationShadowEvidence[];
}

const SHADOW_DISCLAIMER =
  "Shadow evidence is hypothesis only: cached quotes do not prove an order would have filled.";

/** Exact-field equality for persisted settings before an apply or revert. */
export function scalpCalibrationSettingsEqual(
  left: ScalpCalibrationSettings,
  right: ScalpCalibrationSettings,
): boolean {
  return left.bandMin === right.bandMin
    && left.bandMax === right.bandMax
    && left.windowSeconds === right.windowSeconds
    && left.budgetDollars === right.budgetDollars;
}

export function buildScalpCalibrationTimingOverride(
  priorOverride: ScalpPerMarketOverride | null,
  symbol: string,
  windowSeconds: number,
): ScalpPerMarketOverride {
  return {
    ...(priorOverride ?? {}),
    symbol: symbol.toUpperCase(),
    windowSeconds,
  };
}

function inScope<T extends { mode: ScalpMode; symbol: string }>(
  rows: T[], input: BuildScalpCalibrationRecommendationInput,
): T[] {
  return rows.filter((row) => row.mode === input.mode && row.symbol === input.symbol);
}

function timingSummary(rows: ScalpCalibrationShadowEvidence[], variantSeconds: number): ScalpCalibrationTimingSummary {
  const ordered = rows
    .filter((row) => row.variantSeconds === variantSeconds)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const split = Math.floor(ordered.length * 0.7);
  const summary = (part: ScalpCalibrationShadowEvidence[]) => {
    const candidates = part.filter((row) => row.candidate);
    const settled = candidates.filter((row) => row.settledAt != null && row.hypotheticalPnl != null);
    return { candidates: candidates.length, settlements: settled.length,
      pnl: settled.reduce((total, row) => total + (row.hypotheticalPnl ?? 0), 0) };
  };
  const training = summary(ordered.slice(0, split));
  const holdout = summary(ordered.slice(split));
  return {
    variantSeconds, candidateCoverage: training.candidates + holdout.candidates,
    trainingCandidates: training.candidates, holdoutCandidates: holdout.candidates,
    trainingSettlements: training.settlements, holdoutSettlements: holdout.settlements,
    trainingPnl: training.pnl, holdoutPnl: holdout.pnl,
  };
}

export function buildScalpCalibrationRecommendation(
  input: BuildScalpCalibrationRecommendationInput,
): ScalpCalibrationRecommendation {
  const orders = inScope(input.realOrders, input);
  const reservations = inScope(input.reservations, input);
  const funnel = inScope(input.funnelEvents, input);
  const shadows = inScope(input.shadowRecords, input);
  const attempted = new Set([
    ...orders.map((row) => row.windowKey),
    ...reservations.map((row) => row.windowKey),
    ...funnel.map((row) => row.windowKey),
  ]);
  const realFills = orders.filter((row) => row.settledAt != null && row.pnl != null);
  const evidence = {
    attemptedUniqueWindows: attempted.size, settledRealFills: realFills.length,
    orders: orders.length, reservations: reservations.length, funnelEvents: funnel.length,
    shadowRecords: shadows.length, shadowCandidates: shadows.filter((row) => row.candidate).length,
    shadowSettlements: shadows.filter((row) => row.candidate && row.settledAt != null && row.hypotheticalPnl != null).length,
  };
  const blockers = new Map<string, number>();
  for (const row of [...reservations, ...funnel]) {
    if (row.blocker) blockers.set(row.blocker, (blockers.get(row.blocker) ?? 0) + 1);
  }
  const dominantBlockers = [...blockers.entries()].map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker));
  const current = timingSummary(shadows, input.currentSettings.windowSeconds);
  const variants = [...new Set(shadows.map((row) => row.variantSeconds))]
    .filter((seconds) => seconds >= 60 && seconds <= 180
      && seconds > input.currentSettings.windowSeconds
      && Math.abs(seconds - input.currentSettings.windowSeconds) <= 30)
    .sort((a, b) => a - b)
    .map((seconds) => timingSummary(shadows, seconds));
  const minimumReasons: string[] = [];
  if (evidence.attemptedUniqueWindows < 12) minimumReasons.push("requires_at_least_12_attempted_unique_windows");
  if (evidence.settledRealFills < 8) minimumReasons.push("requires_at_least_8_settled_real_fills");
  const sufficientSplit = (summary: ScalpCalibrationTimingSummary) =>
    summary.trainingSettlements >= 8 && summary.holdoutSettlements >= 4;
  const noEarlierVariantExistsWithinRange =
    input.currentSettings.windowSeconds >= 180;
  if (!sufficientSplit(current)
    || (!noEarlierVariantExistsWithinRange && !variants.some(sufficientSplit))) {
    minimumReasons.push("requires_shadow_training_and_holdout_evidence");
  }
  const base = {
    id: input.id ?? `${input.mode}:${input.symbol}:${input.evidenceCutoff}`,
    version: input.version ?? 1, mode: input.mode, symbol: input.symbol,
    currentSettings: { ...input.currentSettings },
    proposedSettings: { ...input.currentSettings }, evidenceCutoff: input.evidenceCutoff,
    analysisStart: input.analysisStart, evidence, dominantBlockers,
    shadowDisclaimer: SHADOW_DISCLAIMER, createdAt: input.createdAt,
    appliedAt: null, appliedBy: null, revertedAt: null, revertedBy: null,
  } satisfies Omit<ScalpCalibrationRecommendation, "status" | "confidence" | "rationale" | "chronologicalHoldout">;
  if (minimumReasons.length) {
    return { ...base, status: "insufficient_data", confidence: "low",
      chronologicalHoldout: { current, proposed: null },
      rationale: [...minimumReasons, "Band and budget are unchanged because this analysis evaluates timing only."] };
  }
  const proposed = variants.find((candidate) => sufficientSplit(candidate)
    && candidate.candidateCoverage > current.candidateCoverage
    && candidate.trainingCandidates >= current.trainingCandidates
    && candidate.holdoutCandidates >= current.holdoutCandidates
    && candidate.trainingPnl >= 0 && candidate.holdoutPnl >= 0);
  if (!proposed) {
    return { ...base, status: "no_change", confidence: "moderate",
      chronologicalHoldout: { current, proposed: null },
      rationale: [
        noEarlierVariantExistsWithinRange
          ? "No earlier entry timing exists within the conservative 60–180 second calibration range."
          : "No earlier entry timing independently improved coverage with non-negative chronological training and holdout P&L.",
        "Band and budget are unchanged because this analysis evaluates timing only.",
      ] };
  }
  return { ...base, status: "recommended", confidence: "high",
    proposedSettings: { ...input.currentSettings, windowSeconds: proposed.variantSeconds },
    chronologicalHoldout: { current, proposed },
    rationale: [`Starting at ${proposed.variantSeconds}s remaining improved candidate coverage over ${current.variantSeconds}s remaining.`, "Training and holdout hypothetical P&L are non-negative.", "Band and budget are unchanged because this analysis evaluates timing only."] };
}