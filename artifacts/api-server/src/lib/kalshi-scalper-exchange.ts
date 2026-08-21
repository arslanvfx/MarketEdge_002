// ---------------------------------------------------------------------------
// kalshi-scalper-exchange.ts — SCALPER-OWNED exchange boundary.
//
// This is a deliberately isolated, minimal duplicate of the Kalshi Trade API v2
// RSA-PSS signing + POST /portfolio/events/orders submission path. It exists so
// the scalper NEVER imports or calls the protected regular-bot placeOrder()
// (which coerces a malformed fill_count to zero). The regular bot's trader stays
// read-only from the scalper's perspective.
//
// This module ONLY submits (write). Balance/settlement READS are still sourced
// from the protected kalshi-trader.ts by the service. Nothing here is imported
// by any regular-bot file.
//
// Auth (identical protocol to the regular client, intentionally re-derived):
//   KALSHI-ACCESS-KEY        — the API key ID
//   KALSHI-ACCESS-TIMESTAMP  — current ms timestamp string
//   KALSHI-ACCESS-SIGNATURE  — base64(RSA-PSS-SHA256(timestamp + METHOD + path))
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { logger } from "./logger.ts";
import { parseScalpOrderResponse, type ParsedScalpFill } from "./kalshi-scalper-policy.ts";

const KALSHI_TRADE_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const ORDERS_PATH = "/portfolio/events/orders";

function getKeyId(): string | null {
  return process.env["KALSHI_API_KEY_ID"] ?? null;
}

function getPrivateKey(): string | null {
  const raw = process.env["KALSHI_PRIVATE_KEY"] ?? null;
  if (!raw) return null;

  // If the key already has a PEM header, normalise newlines and return as-is.
  if (raw.includes("-----BEGIN")) {
    return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  }

  // Raw base64 without PEM headers → reconstruct a PKCS#1 RSA PEM.
  const b64 = raw.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return [
    "-----BEGIN RSA PRIVATE KEY-----",
    ...lines,
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
}

/**
 * Build the signed headers for a request. THROWS if auth material is absent —
 * the scalper must never submit unsigned (fail closed).
 */
function makeSignedHeaders(method: string, path: string): Record<string, string> {
  const keyId = getKeyId();
  const privateKeyPem = getPrivateKey();
  if (!keyId || !privateKeyPem) {
    throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  }

  const timestampMs = Date.now().toString();
  // Signature message: timestamp + METHOD + /trade-api/v2 + path (no query).
  const pathWithoutQuery = path.split("?")[0];
  const message = timestampMs + method.toUpperCase() + "/trade-api/v2" + pathWithoutQuery;

  const sign = crypto.createSign("SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
    "base64",
  );

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

export interface ScalpSubmitParams {
  ticker: string;
  side: "yes" | "no";
  // Exact YES-side limit price as a fraction (0.01–0.99). Provided by the caller
  // (the service already computed and clamped it). Sent at cent resolution.
  limitPrice: number;
  // Integer contract count (> 0).
  count: number;
  timeoutMs?: number;
}

/**
 * Submit a scalper entry order via a scalper-dedicated signed POST to
 * /portfolio/events/orders, then STRICTLY parse the raw response.
 *
 * Order semantics (fixed for the scalper entry path):
 *   - action is always BUY
 *   - side "yes"  → book "bid"   (acquire YES exposure)
 *     side "no"   → book "ask"   (acquire NO exposure)
 *   - price is the exact YES-side limitPrice at cent resolution
 *   - count is the integer contract count
 *   - time_in_force = "immediate_or_cancel"
 *   - self_trade_prevention_type = "taker_at_cross"
 *
 * THROWS on: auth absence, timeout/abort, transport failure, non-2xx status, or
 * invalid JSON. The service's catch treats any thrown submit as UNKNOWN.
 *
 * On HTTP success returns a strictly-parsed discriminated result — never a
 * zero-coerced fill. A malformed body resolves to outcome "unknown".
 */
export async function placeScalpOrderStrict(
  params: ScalpSubmitParams,
): Promise<ParsedScalpFill> {
  // Fail closed on missing auth BEFORE any network work.
  if (!getKeyId() || !getPrivateKey()) {
    throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  }

  const { ticker, side, limitPrice, count } = params;

  // Validate the request locally — the strict parser also enforces this, but a
  // bad count must never leave this module as a real submission.
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) {
    throw new Error(`invalid scalp order count: ${String(count)}`);
  }
  if (!Number.isFinite(limitPrice)) {
    throw new Error(`invalid scalp order limitPrice: ${String(limitPrice)}`);
  }

  // side "yes" → bid (YES exposure); "no" → ask (NO exposure).
  const bookSide = side === "yes" ? "bid" : "ask";

  // Cent-resolution YES-side price string, clamped to Kalshi's 0.01–0.99 range.
  const clamped = Math.min(0.99, Math.max(0.01, limitPrice));
  const price = clamped.toFixed(2);

  const clientOrderId = crypto.randomUUID();
  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    ticker,
    side: bookSide, // "bid" | "ask"
    action: "buy",
    count: String(count), // FixedPointCount string
    price, // YES-side FixedPointDollars string (cent resolution)
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  const timeoutMs = params.timeoutMs ?? 10_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${KALSHI_TRADE_BASE}${ORDERS_PATH}`, {
      method: "POST",
      headers: makeSignedHeaders("POST", ORDERS_PATH),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Transport failure or timeout/abort — indeterminate; the service treats a
    // thrown submit as UNKNOWN (never a zero fill).
    clearTimeout(timer);
    throw new Error(`scalp submit transport error: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi POST ${ORDERS_PATH} → ${res.status}: ${text}`);
  }

  // Invalid JSON on a 2xx is indeterminate → THROW (caught as unknown).
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`scalp submit invalid JSON response: ${String(err)}`);
  }

  // HTTP succeeded → STRICTLY parse. Never coerce a malformed fill to zero.
  const parsed = parseScalpOrderResponse(raw, count);
  if (parsed.outcome === "unknown") {
    logger.error(
      { ticker, side, count, reason: parsed.reason },
      "[kalshi-scalper] strict submit parse → UNKNOWN (retaining exposure, fail-closed)",
    );
  }
  return parsed;
}
