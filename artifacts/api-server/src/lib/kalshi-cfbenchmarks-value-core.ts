export interface KalshiCfBenchmarksValueEvidence {
  indexId: string;
  price: number;
  sourceTsMs: number;
  receivedAtMs: number;
  websocketSequence: number;
  sourceSequence: string;
  average60s: number | null;
  provenance: "websocket" | "event_live_data";
}

export function parseKalshiCfBenchmarksValueFrame(
  raw: unknown,
  nowMs: number,
): KalshiCfBenchmarksValueEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as {
    type?: unknown;
    seq?: unknown;
    msg?: {
      index_id?: unknown;
      received_at?: unknown;
      data?: unknown;
      avg_60s_data?: { value?: unknown };
    };
  };
  if (event.type !== "cfbenchmarks_value" || !event.msg) return null;
  if (typeof event.msg.data !== "string") {
    throw new Error("Kalshi cfbenchmarks_value frame has no data payload");
  }
  let data: { type?: unknown; time?: unknown; id?: unknown; value?: unknown };
  try {
    data = JSON.parse(event.msg.data) as typeof data;
  } catch {
    throw new Error("Kalshi cfbenchmarks_value data payload is malformed");
  }
  const indexId = event.msg.index_id;
  const payloadIndexId = data.id;
  const price = Number(data.value);
  const sourceTsMs = Number(data.time);
  const receivedAtMs = Number(event.msg.received_at);
  const websocketSequence = Number(event.seq);
  if (
    typeof indexId !== "string"
    || !indexId
    || payloadIndexId !== indexId
    || data.type !== "value"
    || !Number.isFinite(price)
    || price <= 0
    || !Number.isFinite(sourceTsMs)
    || sourceTsMs <= 0
    || !Number.isSafeInteger(websocketSequence)
    || websocketSequence < 0
  ) {
    throw new Error("Kalshi cfbenchmarks_value frame is malformed or mismatched");
  }
  if (sourceTsMs > nowMs + 5_000) {
    throw new Error(`Kalshi CF Benchmarks publication is in the future for ${indexId}`);
  }
  return {
    indexId,
    price,
    sourceTsMs,
    receivedAtMs: Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : nowMs,
    websocketSequence,
    sourceSequence: `${indexId}:${sourceTsMs}:${String(data.value)}`,
    average60s: Number.isFinite(Number(event.msg.avg_60s_data?.value))
      ? Number(event.msg.avg_60s_data?.value)
      : null,
    provenance: "websocket",
  };
}