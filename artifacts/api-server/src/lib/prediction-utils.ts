// Pure prediction helpers — no database or external imports.
// Extracted from crypto.ts so they can be imported by unit tests without
// pulling in the DB layer. Production code (crypto.ts / routes/crypto.ts)
// calls these functions directly, so any change here is caught by the tests.

export const SNAP_QUARTER_MS = 15 * 60 * 1_000;

// Minimal shape required by computeStatWindowCall — matches the relevant
// fields of PredictionRecord in crypto.ts.
export interface SnapRecord {
  targetTime: string;
  source: string;
  predictedPrice: number;
  kalshiTarget: number | null;
  predictedDirection: string;
  confidence: number;
  snappedAt: string;
}

export interface StatWindowCallResult {
  direction: "up" | "down" | "flat";
  aboveKalshi: boolean | null;
  predictedPrice: number;
  confidence: number;
  snappedAt: string;
}

// ── ML snap encoding ─────────────────────────────────────────────────────────

// Encode the ML binary prediction as a synthetic price 0.1% above/below
// the Kalshi strike. Storing a price (rather than a flag) means evaluation
// reuses the same predictedPrice ≥ kalshiTarget comparison as every other
// source — no special-case scoring logic is needed.
export function mlSnapPrice(above: boolean, kalshiTarget: number): number {
  return above ? kalshiTarget * 1.001 : kalshiTarget * 0.999;
}

// Given a predicted price and the actual close price, return whether the
// ABOVE / BELOW call against a Kalshi target was correct. Both the
// predicted-price encoding (mlSnapPrice) and this evaluation must agree on
// what "above" means: predictedPrice >= kalshiTarget.
export function evalMLCorrect(
  predictedPrice: number,
  kalshiTarget: number,
  actualPrice: number,
): boolean {
  return (predictedPrice >= kalshiTarget) === (actualPrice >= kalshiTarget);
}

// ── Stat window call ─────────────────────────────────────────────────────────

// Pure algorithm: given the full record list for a coin and the current
// millisecond timestamp, return the stat model's call for the next 15-min
// quarter-boundary window, or null if it hasn't been snapped yet.
// crypto.ts calls this after reading from historyStore; tests can call it
// directly with hand-crafted record slices.
export function computeStatWindowCall(
  records: SnapRecord[],
  nowMs: number,
): StatWindowCallResult | null {
  const nextBoundary = new Date(Math.ceil(nowMs / SNAP_QUARTER_MS) * SNAP_QUARTER_MS);
  const targetISO = nextBoundary.toISOString();
  const rec = records.find((r) => r.targetTime === targetISO && r.source === "stat");
  if (!rec) return null;
  const predPrice = Number(rec.predictedPrice);
  const aboveKalshi =
    rec.kalshiTarget != null ? predPrice >= Number(rec.kalshiTarget) : null;
  return {
    direction: rec.predictedDirection as "up" | "down" | "flat",
    aboveKalshi,
    predictedPrice: predPrice,
    confidence: rec.confidence,
    snappedAt: rec.snappedAt,
  };
}
