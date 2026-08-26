export const REGULAR_FREEFALL_TELEMETRY_REFRESH_MS = 30_000;

interface PersistenceState {
  reason: string;
  persistedAt: number;
}

const persistenceState = new Map<string, PersistenceState>();

export function shouldPersistRegularFreefallSkip(input: {
  symbol: string;
  windowKey: string;
  mode: "paper" | "live";
  reason: string;
  nowMs: number;
}): boolean {
  const key = `${input.symbol.toUpperCase()}:${input.windowKey}:${input.mode}`;
  const previous = persistenceState.get(key);
  if (
    previous
    && previous.reason === input.reason
    && input.nowMs - previous.persistedAt < REGULAR_FREEFALL_TELEMETRY_REFRESH_MS
  ) {
    return false;
  }
  persistenceState.set(key, {
    reason: input.reason,
    persistedAt: input.nowMs,
  });
  return true;
}

export function clearRegularFreefallTelemetryCoalescing(): void {
  persistenceState.clear();
}