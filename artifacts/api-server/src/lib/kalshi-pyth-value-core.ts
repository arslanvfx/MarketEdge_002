export interface KalshiPythValueEvidence {
  underlyingTicker: string;
  price: number;
  sourceTsMs: number;
  receivedAtMs: number;
  sourceSequence: string;
}

export function parseKalshiPythValueFrame(
  raw: unknown,
  nowMs: number,
): KalshiPythValueEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as {
    type?: unknown;
    seq?: unknown;
    msg?: {
      underlying_ticker?: unknown;
      value_usd?: unknown;
      source_ts_ms?: unknown;
      received_at?: unknown;
    };
  };
  if (event.type !== "pyth_value" || !event.msg) return null;
  const underlyingTicker = event.msg.underlying_ticker;
  const price = Number(event.msg.value_usd);
  const sourceTsMs = Number(event.msg.source_ts_ms);
  const receivedAt = Number(event.msg.received_at);
  if (
    typeof underlyingTicker !== "string"
    || underlyingTicker.length === 0
    || !Number.isFinite(price)
    || price <= 0
    || !Number.isFinite(sourceTsMs)
    || sourceTsMs <= 0
  ) {
    throw new Error("Kalshi pyth_value frame is malformed");
  }
  if (sourceTsMs > nowMs + 5_000) {
    throw new Error(`Kalshi Pyth publication is in the future for ${underlyingTicker}`);
  }
  const receivedAtMs = Number.isFinite(receivedAt) && receivedAt > 0
    ? receivedAt
    : nowMs;
  // Distinctness is tied to upstream publication evidence, not the local poll
  // cadence or websocket sequence. A repeated publication remains one sample.
  return {
    underlyingTicker,
    price,
    sourceTsMs,
    receivedAtMs,
    sourceSequence: `${sourceTsMs}:${String(event.msg.value_usd)}`,
  };
}