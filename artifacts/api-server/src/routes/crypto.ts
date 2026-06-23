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

export default router;
