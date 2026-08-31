export interface PythWindowCloseSeries {
  t?: number[];
  c?: number[];
}

/**
 * Select an exact Pyth candle close. Callers deriving a live contract target
 * must require the requested timestamp; settlement repair may explicitly allow
 * the historical last-point fallback for legacy behavior.
 */
export function selectPythWindowClose(
  series: PythWindowCloseSeries,
  targetTimestampSeconds: number,
  requireExactTimestamp: boolean,
): number | null {
  if (!series.t?.length || !series.c?.length) return null;
  const idx = series.t.lastIndexOf(targetTimestampSeconds);
  if (idx < 0 && requireExactTimestamp) return null;
  const close = idx >= 0 ? series.c[idx] : series.c[series.c.length - 1];
  return Number.isFinite(close) && Number(close) > 0 ? Number(close) : null;
}