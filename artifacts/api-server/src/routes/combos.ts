import { Router } from "express";
import { randomUUID } from "crypto";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { savedCombosTable, comboLegsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { fetchMarkets } from "../lib/markets";
import { optimizeCombos, detectPortfolioOverlap } from "../lib/optimizer";

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

    // Fetch all markets to resolve odds
    const { markets: allMarkets } = await fetchMarkets({
      platform: "all",
      limit: 200,
      offset: 0,
    });

    const combos = optimizeCombos({
      selectedLegs: legs,
      markets: allMarkets,
      maxComboSize: Math.min(maxComboSize, 5),
      topN: Math.min(topN, 50),
    });

    res.json({ combos });
  } catch (err) {
    res.status(500).json({ error: "Optimization failed" });
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

    res.json({ combos, portfolioOverlapWarnings });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch combos" });
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

    res.status(201).json({
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
    res.status(500).json({ error: "Failed to save combo" });
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

    res.json({
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
    res.status(500).json({ error: "Failed to fetch combo" });
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

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete combo" });
  }
});

export default router;
