// Pure tally helper — no database or external imports.
// Shared by routes/crypto.ts (prediction-history/summary endpoint) and unit
// tests, so any change to the formula is immediately covered by both.

export interface TallyResult {
  hits: number;
  total: number;
  pct: number | null;
}

// Count correct predictions in a slice of evaluated records. Callers are
// responsible for pre-filtering to the desired source / status before calling.
export function tally(records: { correct: boolean | null }[]): TallyResult {
  const hits = records.filter((r) => r.correct === true).length;
  return {
    hits,
    total: records.length,
    pct: records.length > 0 ? Math.round((hits / records.length) * 100) : null,
  };
}
