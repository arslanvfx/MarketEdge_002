import { Router } from "express";
import { fetchCryptoPredictions, fetchCryptoPrices, fetchAIPredictions } from "../lib/crypto";

const router = Router();

// Full analysis: candles, indicators, and quarter-hour predictions for all coins.
router.get("/crypto/predictions", async (_req, res) => {
  try {
    const result = await fetchCryptoPredictions();
    if (result.coins.length === 0) {
      res.status(502).json({ error: "Upstream price data unavailable" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch crypto predictions" });
  }
});

// Lightweight current prices for fast real-time polling.
router.get("/crypto/prices", async (_req, res) => {
  try {
    const result = await fetchCryptoPrices();
    if (result.prices.length === 0) {
      res.status(502).json({ error: "Upstream price data unavailable" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch crypto prices" });
  }
});

// On-demand AI-enhanced price predictions for a single coin (user-triggered).
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

export default router;
