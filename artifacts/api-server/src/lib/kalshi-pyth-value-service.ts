import WebSocket from "ws";

import { hasKalshiCredentials, makeKalshiSignedHeaders } from "./kalshi-auth.ts";
import { PYTH_COMMODITY_FEEDS } from "./market-defs.ts";
import {
  parseKalshiPythValueFrame,
  type KalshiPythValueEvidence,
} from "./kalshi-pyth-value-core.ts";
import { logger } from "./logger.ts";

const WS_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const WS_SIGNING_PATH = "/trade-api/ws/v2";
const CONNECT_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const DEFAULT_FRESHNESS_MS = 5_000;

const UNDERLYINGS = Object.values(PYTH_COMMODITY_FEEDS)
  .map((feed) => feed.symbol);
const PRODUCT_TO_UNDERLYING = new Map(
  Object.values(PYTH_COMMODITY_FEEDS)
    .map((feed) => [feed.product, feed.symbol]),
);

export interface KalshiPythTickerEvidence {
  price: number;
  publishedAtMs: number;
  sourceSequence: string;
}

export class KalshiPythValueService {
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
  private readonly latest = new Map<string, KalshiPythValueEvidence>();

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!hasKalshiCredentials()) {
      this.lastFailureReason = "Kalshi credentials unavailable for pyth_value feed";
      logger.warn("[kalshi-pyth-value] credentials unavailable; commodity evidence remains fail-closed");
      return;
    }
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.terminate();
    this.latest.clear();
  }

  getFreshEvidence(
    product: string,
    nowMs = Date.now(),
    maxAgeMs = DEFAULT_FRESHNESS_MS,
  ): KalshiPythTickerEvidence {
    this.start();
    const underlying = PRODUCT_TO_UNDERLYING.get(product);
    if (!underlying) throw new Error(`Kalshi Pyth product is not configured: ${product}`);
    const evidence = this.latest.get(underlying);
    if (!evidence) {
      throw new Error(
        this.lastFailureReason
          ? `Kalshi Pyth evidence unavailable for ${underlying}: ${this.lastFailureReason}`
          : `Kalshi Pyth evidence unavailable for ${underlying}: awaiting first publication`,
      );
    }
    const sourceAgeMs = nowMs - evidence.sourceTsMs;
    if (sourceAgeMs < -5_000 || sourceAgeMs > maxAgeMs) {
      throw new Error(
        `Kalshi Pyth evidence stale for ${underlying} (${Math.round(sourceAgeMs / 1_000)}s old)`,
      );
    }
    return {
      price: evidence.price,
      publishedAtMs: evidence.sourceTsMs,
      sourceSequence: evidence.sourceSequence,
    };
  }

  getStatus(nowMs = Date.now()) {
    return {
      ownership: "application" as const,
      connected: this.socket?.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      reconnectAttempt: this.reconnectAttempt,
      lastFailureReason: this.lastFailureReason,
      underlyings: Object.fromEntries(UNDERLYINGS.map((underlying) => {
        const evidence = this.latest.get(underlying);
        return [underlying, evidence
          ? {
              price: evidence.price,
              sourceTsMs: evidence.sourceTsMs,
              sourceAgeMs: Math.max(0, nowMs - evidence.sourceTsMs),
              sourceSequence: evidence.sourceSequence,
            }
          : null];
      })),
    };
  }

  private connect(): void {
    if (!this.started || this.socket || !hasKalshiCredentials()) return;
    let headers: Record<string, string>;
    try {
      headers = makeKalshiSignedHeaders("GET", WS_SIGNING_PATH, false);
    } catch (err) {
      this.fail(`websocket signing failed: ${errorMessage(err)}`);
      this.scheduleReconnect();
      return;
    }
    try {
      const ws = new WebSocket(WS_URL, { headers });
      this.socket = ws;
      this.connectTimer = setTimeout(() => {
        if (this.socket === ws && ws.readyState !== WebSocket.OPEN) {
          this.restart(ws, "connection timeout");
        }
      }, CONNECT_TIMEOUT_MS);
      ws.on("open", () => {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.reconnectAttempt = 0;
        this.connectedAt = Date.now();
        this.lastFailureReason = null;
        this.alive = true;
        ws.send(JSON.stringify({
          id: this.nextId++,
          cmd: "subscribe",
          params: {
            channels: ["pyth_value"],
            underlying_tickers: UNDERLYINGS,
          },
        }));
        this.pingTimer = setInterval(() => {
          if (!this.alive) {
            this.restart(ws, "pong timeout");
            return;
          }
          this.alive = false;
          ws.ping();
        }, PING_INTERVAL_MS);
        logger.info(
          { underlyings: UNDERLYINGS },
          "[kalshi-pyth-value] authenticated commodity stream connected",
        );
      });
      ws.on("pong", () => { this.alive = true; });
      ws.on("message", (data) => this.onMessage(data));
      ws.on("error", (err) => this.restart(ws, `socket error: ${errorMessage(err)}`));
      ws.on("close", (code, reason) =>
        this.onClose(ws, `closed ${code}: ${reason.toString()}`));
    } catch (err) {
      this.socket = null;
      this.fail(`websocket creation failed: ${errorMessage(err)}`);
      this.scheduleReconnect();
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    try {
      const raw = JSON.parse(data.toString()) as unknown;
      const event = raw as { type?: unknown; msg?: { msg?: unknown; code?: unknown } };
      if (event.type === "error") {
        const reason =
          `subscription error ${String(event.msg?.code ?? "")}: ${String(event.msg?.msg ?? "unknown")}`;
        logger.warn({ event }, "[kalshi-pyth-value] subscription rejected");
        // An open socket whose subscription was rejected cannot recover by
        // itself. Invalidate any retained evidence and establish a fresh
        // authenticated subscription through the bounded reconnect path.
        if (this.socket) this.restart(this.socket, reason);
        else this.lastFailureReason = reason;
        return;
      }
      const evidence = parseKalshiPythValueFrame(raw, Date.now());
      if (!evidence) return;
      if (!UNDERLYINGS.includes(evidence.underlyingTicker)) return;
      const previous = this.latest.get(evidence.underlyingTicker);
      if (previous && evidence.sourceTsMs < previous.sourceTsMs) return;
      this.latest.set(evidence.underlyingTicker, evidence);
      this.lastFailureReason = null;
    } catch (err) {
      // A malformed publication means the frame's ticker identity cannot be
      // trusted. Clear all retained commodity evidence so no recent cached
      // value remains usable during a protocol/schema integrity failure.
      this.latest.clear();
      this.lastFailureReason = `malformed pyth_value frame: ${errorMessage(err)}`;
      logger.warn({ err }, "[kalshi-pyth-value] invalid frame ignored");
    }
  }

  private restart(ws: WebSocket, reason: string): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.connectedAt = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    this.latest.clear();
    try {
      ws.terminate();
    } catch {
      // Socket teardown is best-effort; evidence was already invalidated.
    }
    this.fail(reason);
    this.scheduleReconnect();
  }

  private onClose(ws: WebSocket, reason: string): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.connectedAt = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    this.latest.clear();
    this.fail(reason);
    this.scheduleReconnect();
  }

  private fail(reason: string): void {
    this.lastFailureReason = reason;
    logger.warn({ reason }, "[kalshi-pyth-value] stream unavailable; commodity guards fail closed");
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

export const kalshiPythValueService = new KalshiPythValueService();

export function getKalshiPythValueEvidence(
  product: string,
  maxAgeMs = DEFAULT_FRESHNESS_MS,
): KalshiPythTickerEvidence {
  return kalshiPythValueService.getFreshEvidence(product, Date.now(), maxAgeMs);
}