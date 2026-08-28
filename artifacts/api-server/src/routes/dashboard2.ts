import { Router, type NextFunction, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import {
  changeDashboard2ExecutionOwner,
  isDashboard2ExecutionOwner,
  readDashboard2ExecutionOwner,
} from "../lib/dashboard2-ownership.ts";
import { getDashboard2RuntimeStatus } from "../lib/dashboard2-runtime.ts";

const router = Router();

function requireDashboard2Auth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized — must be signed in" });
    return;
  }
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  if (adminId && auth.userId !== adminId) {
    res.status(403).json({ error: "Forbidden — not authorized to control Dashboard 2.0" });
    return;
  }
  next();
}

router.get("/v2/dashboard2/status", requireDashboard2Auth, async (req, res) => {
  try {
    const ownership = await readDashboard2ExecutionOwner();
    res.set("Cache-Control", "no-store");
    const status = getDashboard2RuntimeStatus(ownership.owner, ownership.updatedAt);
    res.json(status);
  } catch (error) {
    req.log.error({ err: error }, "[dashboard2] failed to read status");
    res.status(503).json({ error: "Dashboard 2.0 status unavailable; control plane failed closed" });
  }
});

router.patch("/v2/dashboard2/execution-owner", requireDashboard2Auth, async (req, res) => {
  const owner = req.body?.executionOwner;
  if (!isDashboard2ExecutionOwner(owner)) {
    res.status(400).json({ error: "executionOwner must be current_bot, dashboard2_bot, or paused" });
    return;
  }
  if (owner === "dashboard2_bot") {
    res.status(409).json({ error: "dashboard2_bot cannot be selected while Dashboard 2.0 is observation-only" });
    return;
  }
  const actorId = getAuth(req).userId!;
  try {
    const result = await changeDashboard2ExecutionOwner(owner, actorId);
    res.json({ executionOwner: result.owner, observationOnly: true, updatedAt: result.updatedAt });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "UNRESOLVED_LIVE_INTENTS") {
      res.status(409).json({ error: error.message });
      return;
    }
    req.log.error({ err: error, requestedOwner: owner }, "[dashboard2] ownership switch failed closed");
    res.status(503).json({ error: "Execution ownership unchanged; control plane failed closed" });
  }
});

export default router;