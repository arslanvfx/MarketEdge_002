export type RegularSpotEvidenceClass = "clear" | "unavailable" | "adverse";

interface MutableRegularSpotTelemetry {
  symbol: string;
  product: string;
  lastFetchAttemptAtMs: number | null;
  lastFetchSuccessAtMs: number | null;
  lastFetchFailureAtMs: number | null;
  fetchFailureReason: string | null;
  consecutiveFailures: number;
  latestPublicationAtMs: number | null;
  unavailableCandidateBlocks: number;
  adverseCandidateBlocks: number;
  latestCandidateEvidenceClass: RegularSpotEvidenceClass | null;
  latestCandidateReason: string | null;
  latestCandidateAtMs: number | null;
  latestCandidateWindowKey: string | null;
  latestCandidateMode: "paper" | "live" | null;
}

export interface RegularSpotTelemetrySnapshot extends MutableRegularSpotTelemetry {
  sampleCount: number;
  distinctPublicationCount: number;
  latestReceiptAtMs: number | null;
  latestReceiptAgeMs: number | null;
  retainedCoverageMs: number | null;
  latestPublicationAgeMs: number | null;
}

const state = new Map<string, MutableRegularSpotTelemetry>();

function entry(symbol: string, product: string): MutableRegularSpotTelemetry {
  const key = symbol.toUpperCase();
  let value = state.get(key);
  if (!value) {
    value = {
      symbol: key,
      product,
      lastFetchAttemptAtMs: null,
      lastFetchSuccessAtMs: null,
      lastFetchFailureAtMs: null,
      fetchFailureReason: null,
      consecutiveFailures: 0,
      latestPublicationAtMs: null,
      unavailableCandidateBlocks: 0,
      adverseCandidateBlocks: 0,
      latestCandidateEvidenceClass: null,
      latestCandidateReason: null,
      latestCandidateAtMs: null,
      latestCandidateWindowKey: null,
      latestCandidateMode: null,
    };
    state.set(key, value);
  }
  value.product = product;
  return value;
}

export function recordRegularSpotFetchAttempt(symbol: string, product: string, atMs: number): void {
  entry(symbol, product).lastFetchAttemptAtMs = atMs;
}

export function recordRegularSpotFetchSuccess(input: {
  symbol: string;
  product: string;
  atMs: number;
  publishedAtMs: number | null;
}): void {
  const value = entry(input.symbol, input.product);
  value.lastFetchSuccessAtMs = input.atMs;
  value.fetchFailureReason = null;
  value.consecutiveFailures = 0;
  if (input.publishedAtMs != null) value.latestPublicationAtMs = input.publishedAtMs;
}

export function recordRegularSpotFetchFailure(input: {
  symbol: string;
  product: string;
  atMs: number;
  reason: string;
}): void {
  const value = entry(input.symbol, input.product);
  value.lastFetchFailureAtMs = input.atMs;
  value.fetchFailureReason = input.reason;
  value.consecutiveFailures += 1;
}

export function recordRegularSpotCandidateDecision(input: {
  symbol: string;
  product: string;
  evidenceClass: RegularSpotEvidenceClass;
  reason: string | null;
  atMs: number;
  windowKey: string;
  mode: "paper" | "live";
}): void {
  const value = entry(input.symbol, input.product);
  value.latestCandidateEvidenceClass = input.evidenceClass;
  value.latestCandidateReason = input.reason;
  value.latestCandidateAtMs = input.atMs;
  value.latestCandidateWindowKey = input.windowKey;
  value.latestCandidateMode = input.mode;
  if (input.evidenceClass === "unavailable") value.unavailableCandidateBlocks += 1;
  if (input.evidenceClass === "adverse") value.adverseCandidateBlocks += 1;
}

export function getRegularSpotTelemetrySnapshot(
  samples: Map<string, Array<{
    ts?: number | null;
    oraclePublishedAtMs?: number | null;
    sourceSequence?: string | null;
  }>>,
  nowMs = Date.now(),
): Record<string, RegularSpotTelemetrySnapshot> {
  return Object.fromEntries([...state.entries()].map(([symbol, value]) => {
    const symbolSamples = samples.get(symbol) ?? [];
    const oldestSample = symbolSamples[0];
    const latestSample = symbolSamples[symbolSamples.length - 1];
    const latestPublicationAtMs =
      latestSample?.oraclePublishedAtMs ?? value.latestPublicationAtMs;
    return [symbol, {
      ...value,
      sampleCount: symbolSamples.length,
      distinctPublicationCount: new Set(symbolSamples.map((sample) =>
        sample.sourceSequence
        ?? (sample.oraclePublishedAtMs == null
          ? null
          : `published:${sample.oraclePublishedAtMs}`)
      ).filter((identity): identity is string => identity != null)).size,
      latestReceiptAtMs: latestSample?.ts ?? null,
      latestReceiptAgeMs: latestSample?.ts == null
        ? null
        : Math.max(0, nowMs - latestSample.ts),
      retainedCoverageMs:
        latestSample?.ts == null || oldestSample?.ts == null
          ? null
          : Math.max(0, latestSample.ts - oldestSample.ts),
      latestPublicationAtMs,
      latestPublicationAgeMs: latestPublicationAtMs == null
        ? null
        : Math.max(0, nowMs - latestPublicationAtMs),
    }];
  }));
}

export function clearRegularSpotTelemetry(): void {
  state.clear();
}