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

export function shouldRunRegularSpotSampler(
  state: RegularSpotSamplerState,
): boolean {
  return state.enabled
    && !state.paused
    && state.botMode === "live"
    && state.decisionMode !== "conviction";
}

export async function collectRegularEntrySpotSamples(input: {
  products: readonly RegularSpotProduct[];
  fetchFresh: (product: string) => Promise<number>;
  samples: Map<string, Array<{ price: number; ts: number }>>;
  nowMs: number;
}): Promise<void> {
  const windowStartMs = Math.floor(input.nowMs / WINDOW_MS) * WINDOW_MS;
  await Promise.allSettled(input.products.map(async ({ symbol, product }) => {
    const price = await input.fetchFresh(product);
    if (!Number.isFinite(price) || price <= 0) return;
    const key = symbol.toUpperCase();
    const existing = (input.samples.get(key) ?? [])
      .filter((sample) =>
        Number.isFinite(sample.ts)
        && sample.ts >= windowStartMs
        && sample.ts <= input.nowMs
      );
    existing.push({ price, ts: input.nowMs });
    if (existing.length > REGULAR_SPOT_SAMPLE_LIMIT) {
      existing.splice(0, existing.length - REGULAR_SPOT_SAMPLE_LIMIT);
    }
    input.samples.set(key, existing);
  }));
}