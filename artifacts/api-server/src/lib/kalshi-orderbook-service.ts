import WebSocket from "ws";
import { CRYPTO_COINS, getKalshiCachedData } from "./crypto.ts";
import { hasKalshiCredentials, makeKalshiSignedHeaders } from "./kalshi-auth.ts";
import { logger } from "./logger.ts";
import { KalshiOrderbookStore, type ExecutableBook, type ExecutableSellBook, type KalshiSide, type KalshiTopOfBook } from "./kalshi-orderbook-store.ts";

const WS_URL = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const WS_SIGNING_PATH = "/trade-api/ws/v2";

export class KalshiOrderbookService {
  private readonly store = new KalshiOrderbookStore();
  private socket: WebSocket | null = null;
  private tickers = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private cacheTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = false;
  private started = false;
  private nextId = 1;
  private connectedAt: number | null = null;
  private resnapshotPending = false;
  private readonly bookUpdateListeners = new Set<(ticker: string) => void>();

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshTickers();
    this.cacheTimer = setInterval(() => this.refreshTickers(), 2_000);
    if (!hasKalshiCredentials()) {
      logger.warn("[dashboard2-book] Kalshi credentials unavailable; authenticated book remains fail-closed");
      return;
    }
    this.connect();
  }

  getExecutable(ticker: string, side: KalshiSide, maxContracts: number, floor: number, ceiling: number): ExecutableBook | null {
    return this.store.getExecutable(ticker, side, maxContracts, floor, ceiling);
  }

  getTopOfBook(ticker: string): KalshiTopOfBook | null {
    return this.store.getTopOfBook(ticker);
  }

  onBookUpdate(listener: (ticker: string) => void): () => void {
    this.bookUpdateListeners.add(listener);
    return () => this.bookUpdateListeners.delete(listener);
  }

  getExecutableSell(ticker: string, side: KalshiSide, maxContracts: number): ExecutableSellBook | null {
    return this.store.getExecutableSell(ticker, side, maxContracts);
  }

  isFresh(ticker: string): boolean {
    return this.store.isFresh(ticker);
  }

  getStatus() {
    return Object.freeze({
      ready: this.socket?.readyState === WebSocket.OPEN,
      connected: this.socket?.readyState === WebSocket.OPEN,
      subscribedTickers: this.tickers.size,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      reconnectAttempt: this.reconnectAttempt,
    });
  }

  private refreshTickers(): void {
    const next = new Set(
      CRYPTO_COINS.map(({ symbol }) => getKalshiCachedData(symbol)?.ticker)
        .filter((ticker): ticker is string => Boolean(ticker)),
    );
    if ([...next].every(t => this.tickers.has(t)) && [...this.tickers].every(t => next.has(t))) return;
    this.tickers = next;
    // New stream state must be snapshotted. Reconnect is portable across API
    // versions and avoids relying on an unsubscribe command.
    if (this.socket) this.restartSocket(this.socket, "ticker_set_changed");
  }

  private connect(): void {
    if (!this.started || !hasKalshiCredentials() || this.socket) return;
    let headers: Record<string, string>;
    try {
      headers = makeKalshiSignedHeaders("GET", WS_SIGNING_PATH, false);
    } catch (err) {
      logger.warn({ err }, "[dashboard2-book] websocket signing failed");
      this.scheduleReconnect();
      return;
    }
    try {
      const ws = new WebSocket(WS_URL, { headers });
      this.socket = ws;
      this.connectTimer = setTimeout(() => {
        if (this.socket === ws && ws.readyState !== WebSocket.OPEN) {
          logger.warn("[dashboard2-book] websocket connection timed out; forcing reconnect");
          this.restartSocket(ws, "connection_timeout");
        }
      }, 10_000);
      ws.on("open", () => {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.reconnectAttempt = 0;
        this.connectedAt = Date.now();
        this.alive = true;
        this.resnapshotPending = false;
        this.subscribe();
        this.pingTimer = setInterval(() => {
          if (!this.alive) return ws.terminate();
          this.alive = false;
          ws.ping();
        }, 20_000);
        logger.info({ tickers: this.tickers.size }, "[dashboard2-book] authenticated websocket connected");
      });
      ws.on("pong", () => { this.alive = true; });
      ws.on("message", data => this.onMessage(data));
      ws.on("error", err => {
        logger.warn({ err }, "[dashboard2-book] websocket error; forcing reconnect");
        this.restartSocket(ws, "socket_error");
      });
      ws.on("close", (code, reason) => this.onClose(ws, code, reason.toString()));
    } catch (err) {
      logger.warn({ err }, "[dashboard2-book] websocket creation failed");
      this.socket = null;
      this.scheduleReconnect();
    }
  }

  private subscribe(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.tickers.size) return;
    this.socket.send(JSON.stringify({
      id: this.nextId++,
      cmd: "subscribe",
      params: { channels: ["orderbook_delta"], market_tickers: [...this.tickers] },
    }));
  }

  private onMessage(data: WebSocket.RawData): void {
    if (this.resnapshotPending) return;
    try {
      const raw = JSON.parse(data.toString()) as unknown;
      const event = raw as { type?: unknown; msg?: { market_ticker?: unknown } };
      if (event.type !== "orderbook_snapshot" && event.type !== "orderbook_delta") return;
      const ticker = typeof event.msg?.market_ticker === "string" ? event.msg.market_ticker : undefined;
      if (!this.store.apply(raw)) {
        this.requestResnapshot({ ticker, reason: "malformed_or_sequence_gapped" });
      } else if (ticker) {
        for (const listener of this.bookUpdateListeners) listener(ticker);
      }
    } catch {
      // A malformed frame has no reliable ticker identity; invalidate all
      // snapshots rather than letting a previously valid book remain tradable.
      this.store.clear();
      this.requestResnapshot({ reason: "malformed_json" });
    }
  }

  private requestResnapshot(context: Record<string, unknown>): void {
    if (this.resnapshotPending) return;
    this.resnapshotPending = true;
    logger.warn(context, "[dashboard2-book] resnapshot required; reconnecting fail-closed");
    if (this.socket) this.restartSocket(this.socket, "resnapshot_required");
  }

  private restartSocket(ws: WebSocket, reason: string): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.connectedAt = null;
    this.resnapshotPending = false;
    this.store.clear();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    try {
      ws.terminate();
    } catch (err) {
      logger.warn({ err, reason }, "[dashboard2-book] websocket termination failed");
    }
    logger.info({ reason }, "[dashboard2-book] reconnect scheduled");
    this.scheduleReconnect();
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.connectedAt = null;
    this.resnapshotPending = false;
    this.store.clear();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    logger.warn({ code, reason }, "[dashboard2-book] websocket closed; reconnect scheduled");
    this.scheduleReconnect();
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

export const dashboard2KalshiOrderbookService = new KalshiOrderbookService();