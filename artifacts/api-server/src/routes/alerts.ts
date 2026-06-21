import { Router } from "express";
import { randomUUID } from "crypto";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { priceAlertsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { fetchMarketsForLegs } from "../lib/markets";

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

async function checkAndUpdateAlerts(userId: string) {
  const pendingAlerts = await db
    .select()
    .from(priceAlertsTable)
    .where(and(eq(priceAlertsTable.userId, userId), eq(priceAlertsTable.isTriggered, false)));

  if (!pendingAlerts.length) return;

  const legs = pendingAlerts.map((a) => ({
    marketId: a.marketId,
    platform: a.platform,
    position: "yes" as const,
  }));

  let marketMap: Map<string, number> = new Map();
  try {
    const { markets } = await fetchMarketsForLegs(legs);
    for (const m of markets) {
      marketMap.set(`${m.platform}:${m.id}`, m.yesOdds);
    }
  } catch {
    return;
  }

  const now = new Date();
  for (const alert of pendingAlerts) {
    const currentOdds = marketMap.get(`${alert.platform}:${alert.marketId}`);
    if (currentOdds === undefined) continue;

    const threshold = Number(alert.threshold);
    const triggered =
      alert.condition === "above" ? currentOdds >= threshold : currentOdds <= threshold;

    if (triggered) {
      await db
        .update(priceAlertsTable)
        .set({ isTriggered: true, triggeredAt: now })
        .where(eq(priceAlertsTable.id, alert.id));
    }
  }
}

// GET /alerts — authenticated; also checks current odds against thresholds
router.get("/alerts", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;

    await checkAndUpdateAlerts(userId);

    const alerts = await db
      .select()
      .from(priceAlertsTable)
      .where(eq(priceAlertsTable.userId, userId))
      .orderBy(priceAlertsTable.createdAt);

    return res.json({
      alerts: alerts.map((a) => ({
        id: a.id,
        platform: a.platform,
        marketId: a.marketId,
        marketTitle: a.marketTitle,
        condition: a.condition,
        threshold: Number(a.threshold),
        isTriggered: a.isTriggered,
        triggeredAt: a.triggeredAt ? a.triggeredAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

// POST /alerts — authenticated
router.post("/alerts", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const { platform, marketId, marketTitle, condition, threshold } = req.body;

    if (!platform || !["kalshi", "polymarket"].includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }
    if (!marketId || typeof marketId !== "string") {
      return res.status(400).json({ error: "marketId is required" });
    }
    if (!marketTitle || typeof marketTitle !== "string") {
      return res.status(400).json({ error: "marketTitle is required" });
    }
    if (!condition || !["above", "below"].includes(condition)) {
      return res.status(400).json({ error: "condition must be 'above' or 'below'" });
    }
    const thresh = Number(threshold);
    if (isNaN(thresh) || thresh < 0 || thresh > 1) {
      return res.status(400).json({ error: "threshold must be a number between 0 and 1" });
    }

    const id = randomUUID();
    await db.insert(priceAlertsTable).values({
      id,
      userId,
      platform,
      marketId,
      marketTitle,
      condition,
      threshold: String(thresh),
    });

    const [created] = await db
      .select()
      .from(priceAlertsTable)
      .where(eq(priceAlertsTable.id, id));

    return res.status(201).json({
      id: created.id,
      platform: created.platform,
      marketId: created.marketId,
      marketTitle: created.marketTitle,
      condition: created.condition,
      threshold: Number(created.threshold),
      isTriggered: created.isTriggered,
      triggeredAt: created.triggeredAt ? created.triggeredAt.toISOString() : null,
      createdAt: created.createdAt.toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create alert" });
  }
});

// DELETE /alerts/:alertId — authenticated
router.delete("/alerts/:alertId", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const { alertId } = req.params;

    const [alert] = await db
      .select()
      .from(priceAlertsTable)
      .where(and(eq(priceAlertsTable.id, alertId), eq(priceAlertsTable.userId, userId)));

    if (!alert) return res.status(404).json({ error: "Alert not found" });

    await db
      .delete(priceAlertsTable)
      .where(and(eq(priceAlertsTable.id, alertId), eq(priceAlertsTable.userId, userId)));

    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete alert" });
  }
});

export default router;
