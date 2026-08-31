export const REGULAR_SPOT_SAMPLE_LIMIT = 300;
const WINDOW_MS = 15 * 60_000;

export interface RegularSpotSamplerState {
  enabled: boolean;
  paused: boolean;
  botMode: "paper" | "live";
  decisionMode: string;
}

export interface RegularSpotProduct {
  symbol: string;
  product: string;
}

export interface RegularSpotEvidence {
  price: number;
  publishedAtMs: number | null;
  sourceSequence?: string | null;
  source?: string;
  sourceIndex?: string | null;
  websocketSequence?: number | null;
}

export interface RegularSpotSample {
  price: number;
  ts: number;
  oraclePublishedAtMs?: number | null;
  oracleAgeMs?: number | null;
  sourceSequence?: string | null;
  source?: string;
  sourceIndex?: string | null;
  websocketSequence?: number | null;
}

export function shouldRunRegularSpotSampler(
  state: RegularSpotSamplerState,
): boolean {
  return state.enabled
    && !state.paused
    && state.decisionMode !== "conviction";
}

export function isRegularSpotSampleOwnerActive(input: {
  capturedGeneration: number;
  currentGeneration: number;
  samplerRunning: boolean;
  capturedWindowStartMs: number;
  currentWindowStartMs: number | null;
  clockWindowStartMs: number;
}): boolean {
  return input.capturedGeneration === input.currentGeneration
    && input.samplerRunning
    && input.currentWindowStartMs === input.capturedWindowStartMs
    && input.clockWindowStartMs === input.capturedWindowStartMs;
}

export async function collectRegularEntrySpotSample(input: {
  product: RegularSpotProduct;
  fetchFresh: (product: string) => Promise<RegularSpotEvidence | number>;
  samples: Map<string, RegularSpotSample[]>;
  nowMs: number;
  receiptClock?: () => number;
}): Promise<void> {
  const { symbol, product } = input.product;
  const fetched = await input.fetchFresh(product);
  const receivedAt = input.receiptClock?.() ?? input.nowMs;
  const windowStartMs = Math.floor(receivedAt / WINDOW_MS) * WINDOW_MS;
  const evidence = typeof fetched === "number"
    ? { price: fetched, publishedAtMs: null }
    : fetched;
  if (!Number.isFinite(evidence.price) || evidence.price <= 0) return;
  const key = symbol.toUpperCase();
  const existing = (input.samples.get(key) ?? [])
    .filter((sample) =>
      Number.isFinite(sample.ts)
      && sample.ts >= windowStartMs
      && sample.ts <= receivedAt
    );
  if (
    evidence.sourceSequence
    && existing.some((sample) => sample.sourceSequence === evidence.sourceSequence)
  ) {
    input.samples.set(key, existing);
    return;
  }
  const sourceMetadata = {
    ...(evidence.sourceSequence != null ? { sourceSequence: evidence.sourceSequence } : {}),
    ...(evidence.source != null ? { source: evidence.source } : {}),
    ...(evidence.sourceIndex != null ? { sourceIndex: evidence.sourceIndex } : {}),
    ...(evidence.websocketSequence != null
      ? { websocketSequence: evidence.websocketSequence }
      : {}),
  };
  existing.push(evidence.publishedAtMs == null
    ? {
      price: evidence.price,
      ts: receivedAt,
      ...sourceMetadata,
    }
    : {
      price: evidence.price,
      ts: receivedAt,
      oraclePublishedAtMs: evidence.publishedAtMs,
      oracleAgeMs: receivedAt - evidence.publishedAtMs,
      ...sourceMetadata,
    });
  if (existing.length > REGULAR_SPOT_SAMPLE_LIMIT) {
    existing.splice(0, existing.length - REGULAR_SPOT_SAMPLE_LIMIT);
  }
  input.samples.set(key, existing);
}

export async function collectRegularEntrySpotSamples(input: {
  products: readonly RegularSpotProduct[];
  fetchFresh: (product: string) => Promise<RegularSpotEvidence | number>;
  samples: Map<string, RegularSpotSample[]>;
  nowMs: number;
  /** Defaults to nowMs for deterministic callers; production supplies Date.now. */
  receiptClock?: () => number;
}): Promise<void> {
  await Promise.allSettled(input.products.map((product) =>
    collectRegularEntrySpotSample({
      product,
      fetchFresh: input.fetchFresh,
      samples: input.samples,
      nowMs: input.nowMs,
      receiptClock: input.receiptClock,
    })
  ));
}