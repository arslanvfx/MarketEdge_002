import { Router } from "express";
import { randomUUID } from "crypto";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { savedCombosTable, comboLegsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { fetchMarkets, fetchMarketsForLegs, fetchAllMarkets, listCategories } from "../lib/markets";
import { optimizeCombos, detectPortfolioOverlap, autoGenerateCombos, RiskLevel } from "../lib/optimizer";
import { analyzeMarkets, type MarketAnalysis } from "../lib/ai-analysis";
import { isAiGloballyEnabled } from "../lib/crypto";

const router = Router();

function requireAuth(req: any, res: any, next: any) {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId || auth?.userId;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.userId = userId;
  next();
}

// POST /combos/smart-picks — no auth required
router.post("/combos/smart-picks", async (req, res) => {
  try {
    const {
      riskLevel = "balanced",
      stakeAmount = 10,
      count = 4,
      platform = "both",
      category = "all",
      legCount = "auto",
      horizon = "any",
      optimizeFor = "edge",
      minPayoutMultiplier,
    } = req.body ?? {};

    const validRisk = ["conservative", "balanced", "aggressive"];
    if (!validRisk.includes(riskLevel)) {
      return res.status(400).json({ error: "Invalid riskLevel" });
    }
    const validPlatform = ["kalshi", "polymarket", "both"];
    if (!validPlatform.includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }
    const validLegCount = ["auto", "1", "2", "3", "4", "5", 1, 2, 3, 4, 5];
    if (!validLegCount.includes(legCount)) {
      return res.status(400).json({ error: "Invalid legCount" });
    }
    const validOptimizeFor = ["edge", "returns"];
    if (!validOptimizeFor.includes(optimizeFor)) {
      return res.status(400).json({ error: "Invalid optimizeFor" });
    }
    const minMult =
      minPayoutMultiplier != null
        ? Number(minPayoutMultiplier)
        : undefined;
    if (minMult !== undefined && (Number.isNaN(minMult) || minMult < 1)) {
      return res.status(400).json({ error: "Invalid minPayoutMultiplier: must be a number ≥ 1" });
    }
    const HORIZON_DAYS: Record<string, number> = {
      week: 7,
      month: 31,
      quarter: 92,
      year: 366,
    };
    if (
      horizon !== "any" &&
      !(typeof horizon === "string" && Object.hasOwn(HORIZON_DAYS, horizon))
    ) {
      return res.status(400).json({ error: "Invalid horizon" });
    }
    // Latest acceptable resolution time (null = no limit).
    const horizonCutoff =
      horizon !== "any"
        ? Date.now() + HORIZON_DAYS[horizon] * 24 * 60 * 60 * 1000
        : null;
    // legCount now means MAX legs (1/2/3/4) or "5+" minimum, or "auto".
    const legs: "auto" | 1 | 2 | 3 | 4 | 5 =
      legCount === "auto" ? "auto" : (Number(legCount) as 1 | 2 | 3 | 4 | 5);
    // Sports meta-category: "sports" matches all sport subcategories so the user
    // can say "show me any sport" without having to pick Soccer vs Basketball etc.
    const SPORTS_CATEGORIES = new Set([
      "soccer", "basketball", "baseball", "football", "hockey",
      "tennis", "golf", "mma", "boxing", "cricket", "rugby",
    ]);
    const categoryFilter =
      typeof category === "string" && category && category !== "all"
        ? category.toLowerCase()
        : null;
    const isSportsFilter = categoryFilter === "sports";
    const stake = Math.max(1, Math.min(100, Number(stakeAmount) || 10));
    const n = Math.max(1, Math.min(4, Number(count) || 4));

    // Fetch the FULL live market pool — bypasses the 100-item user-facing cap
    const markets = await fetchAllMarkets();

    // Pre-filter to liquid, genuinely-priced candidates before the AI pass.
    // Caps the number of markets Claude analyzes (cost/latency) while keeping
    // the markets most likely to contain real value.

    // Novelty / meme market blocklist — strip these before they reach the AI.
    // "Before GTA VI / Half-Life 3 / [game release]" markets are real Polymarket
    // markets with genuine volume but an open-ended resolution window (tied to a
    // perpetually-delayed release). They produce nonsensical Smart Picks and
    // confuse the probability model. Block by title pattern.
    const NOVELTY_PATTERNS = [
      /before\s+gta\s+vi?\b/i,
      /before\s+half[\s-]?life\s+3\b/i,
      /before\s+(the\s+)?(next\s+)?(grand\s+theft|gta)\b/i,
      /before\s+[a-z0-9 ]+\s+(album|ep|mixtape)\b/i, // "before [artist] album"
      /\bjesus\s+christ\s+return\b/i,
      /\baliens?\s+(land|invade|contact)\b/i,
    ];
    const isNovelty = (title: string) =>
      NOVELTY_PATTERNS.some((re) => re.test(title));

    const liquid = markets.filter((m) => {
      if (!(m.yesOdds > 0.02 && m.yesOdds < 0.98)) return false;
      if (!((m.volume ?? 0) > 0)) return false;
      if (isNovelty(m.title)) return false;
      if (categoryFilter !== null) {
        const mCat = (m.category ?? "Other").toLowerCase();
        if (isSportsFilter ? !SPORTS_CATEGORIES.has(mCat) : mCat !== categoryFilter)
          return false;
      }
      // Resolution-horizon filter: only markets that settle within the chosen
      // window. Markets with no known close time are excluded once a horizon is
      // set — EXCEPT Kalshi game-prop markets (corners, totals, BTTS, spreads…).
      // Those carry a gameKey (tied to a specific match) but Kalshi often omits
      // closeTime in the API even for same-day games. They will clearly resolve
      // when the match ends, which is at most a day or two away, so we allow
      // them through for any horizon rather than silently dropping them.
      if (horizonCutoff !== null) {
        if (!m.closeTime) {
          // Allow Kalshi game-specific props through even without a close time.
          if (!(m.platform === "kalshi" && m.gameKey)) return false;
        } else {
          const t = Date.parse(m.closeTime);
          if (Number.isNaN(t) || t > horizonCutoff) return false;
        }
      }
      return true;
    });

    // Build a category-BALANCED candidate pool per platform. Sorting purely by
    // volume lets a few bulk series (dozens of CPI thresholds, Bitcoin price
    // levels, championship outrights) fill the entire pool with mutually-
    // correlated legs that can never form a diverse parlay — while starving the
    // independent match markets (individual games) that actually combo well. We
    // instead take the highest-volume markets ROUND-ROBIN across categories so
    // every category gets fair representation in the pool the AI analyses.
    const pickBalanced = (plat: "kalshi" | "polymarket", limit: number) => {
      const byCat = new Map<string, typeof liquid>();
      for (const m of liquid.filter((x) => x.platform === plat)) {
        const c = m.category ?? "Other";
        const arr = byCat.get(c) ?? [];
        arr.push(m);
        byCat.set(c, arr);
      }
      for (const arr of byCat.values())
        arr.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
      const cats = [...byCat.values()];
      const out: typeof liquid = [];
      for (let i = 0; out.length < limit; i++) {
        let added = false;
        for (const arr of cats) {
          if (arr[i]) {
            out.push(arr[i]);
            added = true;
            if (out.length >= limit) break;
          }
        }
        if (!added) break; // every category exhausted
      }
      return out;
    };

    const POOL_CAP = 48;
    let candidates: typeof liquid;
    if (platform === "kalshi") {
      candidates = pickBalanced("kalshi", POOL_CAP);
    } else if (platform === "polymarket") {
      candidates = pickBalanced("polymarket", POOL_CAP);
    } else {
      candidates = [...pickBalanced("kalshi", 24), ...pickBalanced("polymarket", 24)];
      // If one platform is thin, backfill from the other (by volume) so we still
      // analyze a full pool instead of returning fewer combos than possible.
      if (candidates.length < POOL_CAP) {
        const have = new Set(candidates.map((m) => `${m.platform}:${m.id}`));
        const backfill = liquid
          .filter((m) => !have.has(`${m.platform}:${m.id}`))
          .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
          .slice(0, POOL_CAP - candidates.length);
        candidates = [...candidates, ...backfill];
      }
    }

    // Same-game expansion (Kalshi only). The balanced pool above picks markets by
    // volume, which favours headline winner markets and starves the lower-volume
    // PROP markets (totals, spreads, corners, BTTS, player props) that share a
    // game. Without those props in the pool, the optimizer can't build Kalshi's
    // native same-game combos. So for every Kalshi game already chosen, pull in
    // its sibling prop markets (same gameKey, any prop type) from the full liquid
    // set, highest-volume first, up to an expanded cap that keeps AI cost bounded.
    if (platform !== "polymarket") {
      const EXPANDED_CAP = 90;
      const have = new Set(candidates.map((m) => `${m.platform}:${m.id}`));
      const gameKeys = new Set(
        candidates
          .filter((m) => m.platform === "kalshi" && m.gameKey)
          .map((m) => m.gameKey),
      );
      if (gameKeys.size > 0) {
        const siblings = liquid
          .filter(
            (m) =>
              m.platform === "kalshi" &&
              m.gameKey != null &&
              gameKeys.has(m.gameKey) &&
              !have.has(`${m.platform}:${m.id}`),
          )
          .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
          .slice(0, Math.max(0, EXPANDED_CAP - candidates.length));
        candidates = [...candidates, ...siblings];
      }
    }

    // AI market analysis temporarily disabled for Smart Picks / Markets page.
    // autoGenerateCombos falls back to raw market odds when analyses is empty.
    const analyses: Map<string, MarketAnalysis> = new Map();

    const combos = autoGenerateCombos({
      markets: candidates,
      analyses,
      riskLevel: riskLevel as RiskLevel,
      stakeAmount: stake,
      count: n,
      legCount: legs,
      optimizeFor: optimizeFor as "edge" | "returns",
      minPayoutMultiplier: minMult,
    });

    return res.json({ combos, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[smart-picks]", err);
    return res.status(500).json({ error: "Generation failed" });
  }
});

// GET /combos/categories — categories present in the live pool (for the filter)
router.get("/combos/categories", async (_req, res) => {
  try {
    const categories = await listCategories();
    return res.json({ categories });
  } catch (err) {
    console.error("[categories]", err);
    return res.status(500).json({ error: "Failed to load categories" });
  }
});

// POST /combos/optimize — no auth required
router.post("/combos/optimize", async (req, res) => {
  try {
    const { legs, maxComboSize = 4, topN = 10 } = req.body;

    if (!Array.isArray(legs) || legs.length < 2) {
      return res.status(400).json({ error: "At least 2 legs required" });
    }

    // Fetch live market data for the selected legs
    const platformGroups = new Map<string, string[]>();
    for (const leg of legs) {
      const list = platformGroups.get(leg.platform) ?? [];
      list.push(leg.marketId);
      platformGroups.set(leg.platform, list);
    }

    // Fetch markets needed for the selected legs (by platform, unbounded)
    const { markets: allMarkets } = await fetchMarketsForLegs(legs);

    const combos = optimizeCombos({
      selectedLegs: legs,
      markets: allMarkets,
      maxComboSize: Math.min(maxComboSize, 5),
      topN: Math.min(topN, 50),
    });

    return res.json({ combos });
  } catch (err) {
    return res.status(500).json({ error: "Optimization failed" });
  }
});

// GET /combos — authenticated
router.get("/combos", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;

    const savedCombos = await db
      .select()
      .from(savedCombosTable)
      .where(eq(savedCombosTable.userId, userId))
      .orderBy(savedCombosTable.createdAt);

    const comboIds = savedCombos.map((c) => c.id);
    const allLegs = comboIds.length
      ? await db
          .select()
          .from(comboLegsTable)
          .where(inArray(comboLegsTable.comboId, comboIds))
          .orderBy(comboLegsTable.sortOrder)
      : [];

    // Group legs by combo
    const legsByCombo = new Map<string, typeof allLegs>();
    for (const leg of allLegs) {
      const existing = legsByCombo.get(leg.comboId) ?? [];
      existing.push(leg);
      legsByCombo.set(leg.comboId, existing);
    }

    // Detect portfolio overlaps
    const comboLegGroups = savedCombos.map((c) =>
      (legsByCombo.get(c.id) ?? []).map((l) => ({
        marketId: l.marketId,
        platform: l.platform,
        marketTitle: l.marketTitle,
        position: l.position,
      })),
    );
    const portfolioOverlapWarnings = detectPortfolioOverlap(
      comboLegGroups.map((legs) => ({ legs })),
    );

    // Build overlap set for per-combo flag
    const overlapKeys = new Set(
      portfolioOverlapWarnings.map(
        (w) => `${w.platform}:${w.marketId}:${w.position}`,
      ),
    );

    const combos = savedCombos.map((combo) => {
      const legs = (legsByCombo.get(combo.id) ?? []).map((l) => ({
        id: l.id,
        marketId: l.marketId,
        platform: l.platform,
        marketTitle: l.marketTitle,
        position: l.position,
        oddsAtSave: Number(l.oddsAtSave),
        impliedProbAtSave: Number(l.impliedProbAtSave),
      }));
      const hasOverlap = legs.some((l) =>
        overlapKeys.has(`${l.platform}:${l.marketId}:${l.position}`),
      );
      return {
        id: combo.id,
        name: combo.name,
        note: combo.note,
        createdAt: combo.createdAt.toISOString(),
        legs,
        jointProbabilityAtSave: Number(combo.jointProbabilityAtSave),
        payoutMultiplierAtSave: Number(combo.payoutMultiplierAtSave),
        portfolioOverlapWarning: hasOverlap,
      };
    });

    return res.json({ combos, portfolioOverlapWarnings });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch combos" });
  }
});

// POST /combos — authenticated
router.post("/combos", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const { name, note, legs } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!Array.isArray(legs) || legs.length < 2) {
      return res.status(400).json({ error: "At least 2 legs required" });
    }

    const jointProbability = legs.reduce(
      (acc: number, l: any) => acc * Number(l.impliedProbAtSave),
      1,
    );
    const payoutMultiplier = jointProbability > 0 ? 1 / jointProbability : 0;

    const comboId = randomUUID();
    await db.insert(savedCombosTable).values({
      id: comboId,
      userId,
      name: name.trim(),
      note: note ?? null,
      jointProbabilityAtSave: String(jointProbability),
      payoutMultiplierAtSave: String(payoutMultiplier),
    });

    const legRows = legs.map((l: any, i: number) => ({
      id: randomUUID(),
      comboId,
      platform: l.platform,
      marketId: l.marketId,
      marketTitle: l.marketTitle,
      position: l.position,
      oddsAtSave: String(l.oddsAtSave),
      impliedProbAtSave: String(l.impliedProbAtSave),
      sortOrder: i,
    }));
    await db.insert(comboLegsTable).values(legRows);

    // Fetch back and return
    const [saved] = await db
      .select()
      .from(savedCombosTable)
      .where(eq(savedCombosTable.id, comboId));

    const savedLegs = await db
      .select()
      .from(comboLegsTable)
      .where(eq(comboLegsTable.comboId, comboId))
      .orderBy(comboLegsTable.sortOrder);

    return res.status(201).json({
      id: saved.id,
      name: saved.name,
      note: saved.note,
      createdAt: saved.createdAt.toISOString(),
      legs: savedLegs.map((l) => ({
        id: l.id,
        marketId: l.marketId,
        platform: l.platform,
        marketTitle: l.marketTitle,
        position: l.position,
        oddsAtSave: Number(l.oddsAtSave),
        impliedProbAtSave: Number(l.impliedProbAtSave),
      })),
      jointProbabilityAtSave: Number(saved.jointProbabilityAtSave),
      payoutMultiplierAtSave: Number(saved.payoutMultiplierAtSave),
      portfolioOverlapWarning: false,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save combo" });
  }
});

// GET /combos/:comboId — authenticated
router.get("/combos/:comboId", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const { comboId } = req.params;

    const [combo] = await db
      .select()
      .from(savedCombosTable)
      .where(and(eq(savedCombosTable.id, comboId), eq(savedCombosTable.userId, userId)));

    if (!combo) return res.status(404).json({ error: "Combo not found" });

    const legs = await db
      .select()
      .from(comboLegsTable)
      .where(eq(comboLegsTable.comboId, comboId))
      .orderBy(comboLegsTable.sortOrder);

    // Get all user combos for portfolio overlap detection
    const allCombos = await db
      .select()
      .from(savedCombosTable)
      .where(eq(savedCombosTable.userId, userId));

    const allLegsPromises = allCombos.map((c) =>
      db
        .select()
        .from(comboLegsTable)
        .where(eq(comboLegsTable.comboId, c.id)),
    );
    const allLegsArrays = await Promise.all(allLegsPromises);

    const overlapWarnings = detectPortfolioOverlap(
      allLegsArrays.map((arr) => ({
        legs: arr.map((l) => ({
          marketId: l.marketId,
          platform: l.platform,
          marketTitle: l.marketTitle,
          position: l.position,
        })),
      })),
    );

    const overlapKeys = new Set(
      overlapWarnings.map((w) => `${w.platform}:${w.marketId}:${w.position}`),
    );

    const hasOverlap = legs.some((l) =>
      overlapKeys.has(`${l.platform}:${l.marketId}:${l.position}`),
    );

    return res.json({
      id: combo.id,
      name: combo.name,
      note: combo.note,
      createdAt: combo.createdAt.toISOString(),
      legs: legs.map((l) => ({
        id: l.id,
        marketId: l.marketId,
        platform: l.platform,
        marketTitle: l.marketTitle,
        position: l.position,
        oddsAtSave: Number(l.oddsAtSave),
        impliedProbAtSave: Number(l.impliedProbAtSave),
      })),
      jointProbabilityAtSave: Number(combo.jointProbabilityAtSave),
      payoutMultiplierAtSave: Number(combo.payoutMultiplierAtSave),
      portfolioOverlapWarning: hasOverlap,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch combo" });
  }
});

// DELETE /combos/:comboId — authenticated
router.delete("/combos/:comboId", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const { comboId } = req.params;

    const [combo] = await db
      .select()
      .from(savedCombosTable)
      .where(and(eq(savedCombosTable.id, comboId), eq(savedCombosTable.userId, userId)));

    if (!combo) return res.status(404).json({ error: "Combo not found" });

    await db
      .delete(savedCombosTable)
      .where(and(eq(savedCombosTable.id, comboId), eq(savedCombosTable.userId, userId)));

    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete combo" });
  }
});

export default router;
