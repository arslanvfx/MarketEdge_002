import { Router } from "express";
import { fetchMarkets, fetchMarketById } from "../lib/markets";

const router = Router();

router.get("/markets", async (req, res) => {
  try {
    const q = req.query.q as string | undefined;
    const platform = req.query.platform as "kalshi" | "polymarket" | "all" | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const offset = req.query.offset ? Number(req.query.offset) : 0;

    const result = await fetchMarkets({ q, platform, limit, offset });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch markets" });
  }
});

router.get("/markets/:platform/:marketId", async (req, res) => {
  try {
    const { platform, marketId } = req.params;
    if (platform !== "kalshi" && platform !== "polymarket") {
      return res.status(400).json({ error: "Invalid platform" });
    }
    const market = await fetchMarketById(platform, marketId);
    if (!market) return res.status(404).json({ error: "Market not found" });
    res.json(market);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch market" });
  }
});

export default router;
