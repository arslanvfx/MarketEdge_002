import WebSocket from "ws";

import { hasKalshiCredentials, makeKalshiSignedHeaders } from "./kalshi-auth.ts";
import { CF_BENCHMARKS_CRYPTO_FEEDS, KALSHI_SERIES } from "./market-defs.ts";
import {
  parseKalshiCfBenchmarksValueFrame,
  type KalshiCfBenchmarksValueEvidence,
} from "./kalshi-cfbenchmarks-value-core.ts";
import { logger } from "./logger.ts";

const WS_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const WS_SIGNING_PATH = "/trade-api/ws/v2";
const CONNECT_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const DEFAULT_FRESHNESS_MS = 5_000;
const INDEX_IDS = Object.values(CF_BENCHMARKS_CRYPTO_FEEDS).map((feed) => feed.streamIndexId);
const PRODUCT_TO_INDEX = new Map(
  Object.values(CF_BENCHMARKS_CRYPTO_FEEDS).map((feed) => [feed.product, feed.streamIndexId]),
);

export interface KalshiCfBenchmarksTickerEvidence {
  price: number;
  publishedAtMs: number;
  sourceSequence: string;
  source: "kalshi_cfbenchmarks";
  sourceIndex: string;
  websocketSequence: number;
  average60s: number | null;
}

export class KalshiCfBenchmarksValueService {
  private socket: WebSocket | null = null;
  private started = false;
  private alive = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private connectedAt: number | null = null;
  private lastFailureReason: string | null = null;
  private connectionGeneration = 0;
  private warmupAbort: AbortController | null = null;
  private readonly latest = new Map<string, KalshiCfBenchmarksValueEvidence>();

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!hasKalshiCredentials()) {
      this.lastFailureReason = "Kalshi credentials unavailable for cfbenchmarks_value feed";
      logger.warn("[kalshi-cfbenchmarks-value] credentials unavailable; crypto guards remain fail-closed");
      return;
    }
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.connectionGeneration += 1;
    this.warmupAbort?.abort();
    this.warmupAbort = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = this.connectTimer = this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.terminate();
    this.latest.clear();
  }

  getFreshEvidence(product: string, nowMs = Date.now(), maxAgeMs = DEFAULT_FRESHNESS_MS): KalshiCfBenchmarksTickerEvidence {
    this.start();
    const indexId = PRODUCT_TO_INDEX.get(product);
    if (!indexId) throw new Error(`Kalshi CF Benchmarks product is not configured: ${product}`);
    const evidence = this.latest.get(indexId);
    if (!evidence) {
      throw new Error(this.lastFailureReason
        ? `Kalshi CF Benchmarks evidence unavailable for ${indexId}: ${this.lastFailureReason}`
        : `Kalshi CF Benchmarks evidence unavailable for ${indexId}: awaiting first publication`);
    }
    const sourceAgeMs = nowMs - evidence.sourceTsMs;
    if (sourceAgeMs < -5_000 || sourceAgeMs > maxAgeMs) {
      throw new Error(`Kalshi CF Benchmarks evidence stale for ${indexId} (${Math.round(sourceAgeMs / 1_000)}s old)`);
    }
    return {
      price: evidence.price,
      publishedAtMs: evidence.sourceTsMs,
      sourceSequence: evidence.sourceSequence,
      source: "kalshi_cfbenchmarks",
      sourceIndex: indexId,
      websocketSequence: evidence.websocketSequence,
      average60s: evidence.average60s,
    };
  }

  getStatus(nowMs = Date.now()) {
    return {
      ownership: "application" as const,
      connected: this.socket?.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      reconnectAttempt: this.reconnectAttempt,
      lastFailureReason: this.lastFailureReason,
      indices: Object.fromEntries(INDEX_IDS.map((indexId) => {
        const evidence = this.latest.get(indexId);
        return [indexId, evidence ? {
          price: evidence.price,
          average60s: evidence.average60s,
          sourceTsMs: evidence.sourceTsMs,
          sourceAgeMs: Math.max(0, nowMs - evidence.sourceTsMs),
          sourceSequence: evidence.sourceSequence,
          websocketSequence: evidence.websocketSequence,
          provenance: evidence.provenance,
        } : null];
      })),
    };
  }

  private connect(): void {
    if (!this.started || this.socket || !hasKalshiCredentials()) return;
    try {
      const ws = new WebSocket(WS_URL, {
        headers: makeKalshiSignedHeaders("GET", WS_SIGNING_PATH, false),
      });
      const connectionGeneration = ++this.connectionGeneration;
      this.socket = ws;
      this.connectTimer = setTimeout(() => {
        if (this.socket === ws && ws.readyState !== WebSocket.OPEN) this.restart(ws, "connection timeout");
      }, CONNECT_TIMEOUT_MS);
      ws.on("open", () => {
        if (!this.isCurrentConnection(ws, connectionGeneration)) return;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.reconnectAttempt = 0;
        this.connectedAt = Date.now();
        this.lastFailureReason = null;
        this.alive = true;
        this.warmupAbort?.abort();
        const warmupAbort = new AbortController();
        this.warmupAbort = warmupAbort;
        ws.send(JSON.stringify({
          id: this.nextId++,
          cmd: "subscribe",
          params: { channels: ["cfbenchmarks_value"], index_ids: INDEX_IDS },
        }));
        // The public event feed is settlement-aligned too. It provides an
        // immediate current-window value while the authenticated stream is
        // delivering its first publication after startup or reconnect.
        void this.warmFromActiveEvents(ws, connectionGeneration, warmupAbort.signal);
        this.pingTimer = setInterval(() => {
          if (!this.alive) return this.restart(ws, "pong timeout");
          this.alive = false;
          ws.ping();
        }, PING_INTERVAL_MS);
        logger.info({ indices: INDEX_IDS }, "[kalshi-cfbenchmarks-value] authenticated crypto stream connected");
      });
      ws.on("pong", () => {
        if (this.isCurrentConnection(ws, connectionGeneration)) this.alive = true;
      });
      ws.on("message", (data) => this.onMessage(data, ws, connectionGeneration));
      ws.on("error", (err) => this.restart(ws, `socket error: ${errorMessage(err)}`));
      ws.on("close", (code, reason) => this.onClose(ws, `closed ${code}: ${reason.toString()}`));
    } catch (err) {
      this.socket = null;
      this.fail(`websocket creation failed: ${errorMessage(err)}`);
      this.scheduleReconnect();
    }
  }

  private onMessage(
    data: WebSocket.RawData,
    ws: WebSocket = this.socket as WebSocket,
    connectionGeneration = this.connectionGeneration,
  ): void {
    if (!this.isCurrentConnection(ws, connectionGeneration)) return;
    try {
      const raw = JSON.parse(data.toString()) as unknown;
      const event = raw as { type?: unknown; msg?: { msg?: unknown; code?: unknown } };
      if (event.type === "error") {
        const reason = `subscription error ${String(event.msg?.code ?? "")}: ${String(event.msg?.msg ?? "unknown")}`;
        if (this.socket === ws) this.restart(ws, reason);
        else this.lastFailureReason = reason;
        return;
      }
      const evidence = parseKalshiCfBenchmarksValueFrame(raw, Date.now());
      if (!evidence) return;
      if (!INDEX_IDS.includes(evidence.indexId)) return;
      const previous = this.latest.get(evidence.indexId);
      if (previous && (
        evidence.sourceTsMs < previous.sourceTsMs
        || (evidence.sourceTsMs === previous.sourceTsMs && evidence.websocketSequence <= previous.websocketSequence)
      )) return;
      this.latest.set(evidence.indexId, evidence);
      this.lastFailureReason = null;
    } catch (err) {
      this.latest.clear();
      this.lastFailureReason = `malformed cfbenchmarks_value frame: ${errorMessage(err)}`;
      logger.warn({ err }, "[kalshi-cfbenchmarks-value] invalid frame; crypto evidence invalidated");
    }
  }

  private isCurrentConnection(ws: WebSocket, connectionGeneration: number): boolean {
    return this.socket === ws && this.connectionGeneration === connectionGeneration;
  }

  private async warmFromActiveEvents(
    ws: WebSocket,
    connectionGeneration: number,
    connectionSignal: AbortSignal,
  ): Promise<void> {
    await Promise.allSettled(Object.entries(CF_BENCHMARKS_CRYPTO_FEEDS).map(
      async ([symbol, feed]) => {
        const seriesTicker = KALSHI_SERIES[symbol];
        if (!seriesTicker) return;
        const marketResponse = await fetch(
          `https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=5`,
          { signal: AbortSignal.any([connectionSignal, AbortSignal.timeout(5_000)]) },
        );
        if (!marketResponse.ok) throw new Error(`market warmup returned ${marketResponse.status}`);
        const marketBody = await marketResponse.json() as {
          markets?: Array<{
            event_ticker?: unknown;
            close_time?: unknown;
            rules_primary?: unknown;
          }>;
        };
        const nowMs = Date.now();
        const market = (marketBody.markets ?? [])
          .filter((candidate) =>
            typeof candidate.event_ticker === "string"
            && typeof candidate.close_time === "string"
            && typeof candidate.rules_primary === "string"
            && extractSettlementIndex(candidate.rules_primary) === feed.indexId
          )
          .sort((a, b) =>
            Math.abs(Date.parse(String(a.close_time)) - nowMs)
            - Math.abs(Date.parse(String(b.close_time)) - nowMs)
          )[0];
        if (!market?.event_ticker) throw new Error(`no active ${feed.indexId} event matched its settlement rules`);
        const liveResponse = await fetch(
          `https://external-api.kalshi.com/trade-api/v2/live_data/events/${encodeURIComponent(String(market.event_ticker))}?range=15min`,
          { signal: AbortSignal.any([connectionSignal, AbortSignal.timeout(5_000)]) },
        );
        if (!liveResponse.ok) throw new Error(`event live-data warmup returned ${liveResponse.status}`);
        const liveBody = await liveResponse.json() as {
          live_data?: {
            type?: unknown;
            details?: {
              coin?: unknown;
              event_ticker?: unknown;
              timeseries?: Array<{ t?: unknown; v?: unknown }>;
            };
          };
        };
        const details = liveBody.live_data?.details;
        if (
          liveBody.live_data?.type !== "crypto"
          ||
          details?.coin !== symbol
          || details.event_ticker !== market.event_ticker
          || !Array.isArray(details.timeseries)
        ) {
          throw new Error(`event live-data identity mismatch for ${feed.indexId}`);
        }
        const latest = details.timeseries
          .map((point) => ({ sourceTsMs: Number(point.t), price: Number(point.v) }))
          .filter((point) =>
            Number.isFinite(point.sourceTsMs)
            && point.sourceTsMs > 0
            && Number.isFinite(point.price)
            && point.price > 0
          )
          .sort((a, b) => b.sourceTsMs - a.sourceTsMs)[0];
        if (!latest || nowMs - latest.sourceTsMs > DEFAULT_FRESHNESS_MS || latest.sourceTsMs > nowMs + 5_000) {
          throw new Error(`event live-data is stale for ${feed.indexId}`);
        }
        const previous = this.latest.get(feed.streamIndexId);
        if (previous && previous.sourceTsMs >= latest.sourceTsMs) return;
        if (
          connectionSignal.aborted
          || this.connectionGeneration !== connectionGeneration
          || this.socket !== ws
          || ws.readyState !== WebSocket.OPEN
        ) return;
        this.latest.set(feed.streamIndexId, {
          indexId: feed.streamIndexId,
          price: latest.price,
          sourceTsMs: latest.sourceTsMs,
          receivedAtMs: nowMs,
          websocketSequence: 0,
          sourceSequence: `${feed.streamIndexId}:${latest.sourceTsMs}:${latest.price}`,
          average60s: null,
          provenance: "event_live_data",
        });
      },
    ));
  }

  private restart(ws: WebSocket, reason: string): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.connectionGeneration += 1;
    this.warmupAbort?.abort();
    this.warmupAbort = null;
    this.connectedAt = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.connectTimer = this.pingTimer = null;
    this.latest.clear();
    try { ws.terminate(); } catch {}
    this.fail(reason);
    this.scheduleReconnect();
  }

  private onClose(ws: WebSocket, reason: string): void {
    if (this.socket !== ws) return;
    this.restart(ws, reason);
  }

  private fail(reason: string): void {
    this.lastFailureReason = reason;
    logger.warn({ reason }, "[kalshi-cfbenchmarks-value] stream unavailable; crypto guards fail closed");
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer || !hasKalshiCredentials()) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt++, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractSettlementIndex(rulesPrimary: string): string | null {
  const match = /CF Benchmarks' ([A-Z0-9]+) before/.exec(rulesPrimary);
  return match?.[1] ?? null;
}

export const kalshiCfBenchmarksValueService = new KalshiCfBenchmarksValueService();

export function getKalshiCfBenchmarksValueEvidence(
  product: string,
  maxAgeMs = DEFAULT_FRESHNESS_MS,
): KalshiCfBenchmarksTickerEvidence {
  return kalshiCfBenchmarksValueService.getFreshEvidence(product, Date.now(), maxAgeMs);
}