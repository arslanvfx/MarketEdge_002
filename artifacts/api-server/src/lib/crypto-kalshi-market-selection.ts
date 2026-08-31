export interface KalshiMarketCandidate {
  close_time?: string;
  floor_strike?: number | string;
}

const MAX_CLOSE_TIME_DRIFT_MS = 8 * 60_000;

export function parseKalshiFloorStrike(
  value: number | string | undefined,
): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function selectKalshiMarket<T extends KalshiMarketCandidate>(
  markets: readonly T[],
  targetTime?: Date,
): T | undefined {
  if (!targetTime) return markets[0];

  const targetMs = targetTime.getTime();
  const withCloseTime = markets.filter((market) => market.close_time);
  if (withCloseTime.length === 0) return markets[0];

  let selected: T | undefined;
  let bestDiff = Infinity;
  for (const market of withCloseTime) {
    const closeMs = new Date(market.close_time!).getTime();
    if (!Number.isFinite(closeMs)) continue;
    const diff = Math.abs(closeMs - targetMs);
    if (diff < MAX_CLOSE_TIME_DRIFT_MS && diff < bestDiff) {
      selected = market;
      bestDiff = diff;
    }
  }
  return selected;
}