import { Router } from "express";
import {
  fetchCryptoPredictions,
  fetchCryptoPrices,
  fetchAIPredictions,
  getPredictionHistory,
  ACCURACY_THRESHOLD_PCT,
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

// ── Kalshi BTC 15-min target ────────────────────────────────────────────────
// Fetches the currently-active KXBTC15M market and extracts the target (strike)
// price that Kalshi set at window open. Cached for 90 s — the window only
// changes every 15 min so there's no reason to hammer the Kalshi API.
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
}
let kalshiTargetCache: { data: KalshiTargetPayload; fetchedAt: number } | null = null;
const KALSHI_TARGET_TTL = 90_000;

router.get("/crypto/kalshi-btc-target", async (_req, res) => {
  try {
    if (kalshiTargetCache && Date.now() - kalshiTargetCache.fetchedAt < KALSHI_TARGET_TTL) {
      res.json(kalshiTargetCache.data);
      return;
    }

    // Fetch the currently-active KXBTC15M market (if one exists).
    // Kalshi only runs these ~7 PM–5:45 AM ET, so between sessions the card
    // simply disappears — there's nothing actionable to show without a target.
    const resp = await fetch(
      "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=active&limit=10",
      { headers: { accept: "application/json" } },
    );
    if (!resp.ok) {
      res.json({ available: false });
      return;
    }

    const body = (await resp.json()) as { markets?: Record<string, unknown>[] };

    // Find the first active market that already has a real target price set.
    const extractPrice = (sub: string): number | null => {
      const m = sub.match(/\$([\d,]+\.?\d*)/);
      return m ? parseFloat(m[1].replace(/,/g, "")) : null;
    };

    let found: Record<string, unknown> | null = null;
    let targetPrice: number | null = null;
    for (const m of body.markets ?? []) {
      const yst = (m.yes_sub_title as string | undefined) ?? "";
      const p = extractPrice(yst);
      if (p) { found = m; targetPrice = p; break; }
    }

    if (!found) {
      // Active window exists but target not set yet, or no active window.
      res.json({ available: false });
      return;
    }

    const data: KalshiTargetPayload = {
      available: true,
      targetPrice,
      ticker: found.ticker as string,
      eventTicker: found.event_ticker as string,
      closeTime: found.close_time as string,
      openTime: found.open_time as string,
      isLive: true,
      yesBid: parseFloat(found.yes_bid_dollars as string) || 0,
      yesAsk: parseFloat(found.yes_ask_dollars as string) || 0,
      url: `https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/${found.event_ticker as string}`,
    };

    kalshiTargetCache = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch {
    res.status(500).json({ available: false });
  }
});

export default router;
