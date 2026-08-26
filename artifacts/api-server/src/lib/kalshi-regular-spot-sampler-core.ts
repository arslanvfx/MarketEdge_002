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
}

export interface RegularSpotSample {
  price: number;
  ts: number;
  oraclePublishedAtMs?: number | null;
  oracleAgeMs?: number | null;
}

export function shouldRunRegularSpotSampler(
  state: RegularSpotSamplerState,
): boolean {
  return state.enabled
    && !state.paused
    && state.decisionMode !== "conviction";
}

export async function collectRegularEntrySpotSamples(input: {
  products: readonly RegularSpotProduct[];
  fetchFresh: (product: string) => Promise<RegularSpotEvidence | number>;
  samples: Map<string, RegularSpotSample[]>;
  nowMs: number;
  /** Defaults to nowMs for deterministic callers; production supplies Date.now. */
  receiptClock?: () => number;
}): Promise<void> {
  await Promise.allSettled(input.products.map(async ({ symbol, product }) => {
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
    existing.push(evidence.publishedAtMs == null
      ? { price: evidence.price, ts: receivedAt }
      : {
        price: evidence.price,
        ts: receivedAt,
        oraclePublishedAtMs: evidence.publishedAtMs,
        oracleAgeMs: receivedAt - evidence.publishedAtMs,
      });
    if (existing.length > REGULAR_SPOT_SAMPLE_LIMIT) {
      existing.splice(0, existing.length - REGULAR_SPOT_SAMPLE_LIMIT);
    }
    input.samples.set(key, existing);
  }));
}