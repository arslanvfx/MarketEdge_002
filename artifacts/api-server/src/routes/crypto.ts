import { Router } from "express";
import {
  fetchCryptoPredictions,
  fetchCryptoPrices,
  fetchAIPredictions,
  getPredictionHistory,
  clearPredictionHistory,
  ACCURACY_THRESHOLD_PCT,
  fetchKalshiBtcCall,
  fetchKalshiTarget,
  KALSHI_SERIES,
  getKalshiWindowContext,
} from "../lib/crypto";

const router = Router();

router.get("/crypto/predictions", async (_req, res) => {
  try {
    const result = await fetchCryptoPredictions();
    if (result.coins.length === 0) {
      res.status(502).json({ error: "Upstream price data unavailable" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to fetch crypto predictions" });
  }
});

router.get("/crypto/prices", async (_req, res) => {
  try {
    const result = await fetchCryptoPrices();
    if (result.prices.length === 0) {
      res.status(502).json({ error: "Upstream price data unavailable" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to fetch crypto prices" });
  }
});

router.get("/crypto/ai-predict", async (req, res) => {
  const symbol =
    typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  try {
    const result = await fetchAIPredictions(symbol);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `AI prediction failed: ${msg}` });
  }
});

router.get("/crypto/prediction-history", (req, res) => {
  const symbol =
    typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  res.json({
    symbol,
    history: getPredictionHistory(symbol),
    accuracyThresholdPct: ACCURACY_THRESHOLD_PCT,
  });
});

router.delete("/crypto/prediction-history", async (_req, res) => {
  await clearPredictionHistory();
  res.json({ ok: true });
});

// ── Kalshi 15-min target (generic: BTC, ETH, XRP) ───────────────────────────
// Fetches the currently-active KX{SYMBOL}15M market and extracts the strike
// price set at window open. Per-symbol cache (15s TTL).

interface KalshiTargetPayload {
  available: boolean;
  targetPrice: number | null;
  ticker?: string;
  eventTicker?: string;
  closeTime?: string;
  openTime?: string;
  isLive?: boolean;
  yesBid?: number;
  yesAsk?: number;
  url?: string;
  minutesElapsed?: number;
  windowOpenPrice?: number | null;
}

// Kalshi market URL slugs for each supported symbol.
const KALSHI_URL_SLUGS: Record<string, { path: string; label: string }> = {
  BTC: { path: "kxbtc15m", label: "bitcoin-price-up-down" },
  ETH: { path: "kxeth15m", label: "ethereum-price-up-down" },
  XRP: { path: "kxxrp15m", label: "xrp-price-up-down" },
};

const kalshiRouteCache = new Map<string, { data: KalshiTargetPayload; fetchedAt: number }>();
const KALSHI_TARGET_TTL = 15_000; // 15s — catches new 15-min windows quickly

async function fetchKalshiTargetRoute(symbol: string): Promise<KalshiTargetPayload> {
  const series = KALSHI_SERIES[symbol];
  if (!series) return { available: false, targetPrice: null };

  const cached = kalshiRouteCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < KALSHI_TARGET_TTL) return cached.data;

  const resp = await fetch(
    `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=5`,
    { headers: { accept: "application/json" } },
  );
  if (!resp.ok) return { available: false, targetPrice: null };

  const body = (await resp.json()) as { markets?: Record<string, unknown>[] };
  let found: Record<string, unknown> | null = null;
  let targetPrice: number | null = null;
  for (const m of body.markets ?? []) {
    const strike = m.floor_strike as number | undefined;
    if (typeof strike === "number" && strike > 0) { found = m; targetPrice = strike; break; }
  }
  if (!found) {
    const data: KalshiTargetPayload = { available: false, targetPrice: null };
    kalshiRouteCache.set(symbol, { data, fetchedAt: Date.now() });
    return data;
  }

  const slugs = KALSHI_URL_SLUGS[symbol] ?? { path: series.toLowerCase(), label: "price-up-down" };
  const openTimeStr = found.open_time as string | undefined;
  let minutesElapsed: number | undefined;
  if (openTimeStr) {
    const openMs = new Date(openTimeStr).getTime();
    if (!isNaN(openMs)) {
      minutesElapsed = Math.max(0, Math.round((Date.now() - openMs) / 60_000));
    }
  }
  const winCtx = getKalshiWindowContext(symbol);
  const data: KalshiTargetPayload = {
    available: true,
    targetPrice,
    ticker: found.ticker as string,
    eventTicker: found.event_ticker as string,
    closeTime: found.close_time as string,
    openTime: openTimeStr,
    isLive: true,
    yesBid: parseFloat(found.yes_bid_dollars as string) || 0,
    yesAsk: parseFloat(found.yes_ask_dollars as string) || 0,
    url: `https://kalshi.com/markets/${slugs.path}/${slugs.label}/${found.event_ticker as string}`,
    minutesElapsed,
    windowOpenPrice: winCtx?.priceAtOpen,
  };
  kalshiRouteCache.set(symbol, { data, fetchedAt: Date.now() });
  return data;
}

// Generic endpoint: /crypto/kalshi-target?symbol=BTC|ETH|XRP
router.get("/crypto/kalshi-target", async (req, res) => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
  if (!symbol || !KALSHI_SERIES[symbol]) {
    res.status(400).json({ available: false, error: "symbol must be BTC, ETH, or XRP" });
    return;
  }
  try {
    res.json(await fetchKalshiTargetRoute(symbol));
  } catch {
    res.status(500).json({ available: false, targetPrice: null });
  }
});

// Legacy BTC-only endpoint kept for backward compatibility.
router.get("/crypto/kalshi-btc-target", async (_req, res) => {
  try {
    res.json(await fetchKalshiTargetRoute("BTC"));
  } catch {
    res.status(500).json({ available: false });
  }
});

// Dedicated Claude call for the current Kalshi BTC window
router.get("/crypto/kalshi-btc-call", async (req, res) => {
  const eventTicker = String(req.query.eventTicker ?? "");
  const rawTarget = parseFloat(String(req.query.target ?? ""));

  if (!eventTicker || isNaN(rawTarget)) {
    res.status(400).json({ error: "eventTicker and target query params required" });
    return;
  }

  try {
    const result = await fetchKalshiBtcCall(rawTarget, eventTicker);
    if (!result) {
      res.status(503).json({ error: "Claude call failed" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
