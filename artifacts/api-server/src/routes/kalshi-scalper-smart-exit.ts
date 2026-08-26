import { getAuth } from "@clerk/express";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getScalpMutationCapability } from "../lib/kalshi-scalper-authz.ts";
import {
  emergencyDisableScalperSmartExit, getScalperSmartExitStatus,
  getScalperSmartExitLifecycle, getScalperSmartExitReplay, updateScalperSmartExitConfig,
} from "../lib/kalshi-scalper-smart-exit-service.ts";

const router = Router();
function requireOperator(req: Request, res: Response, next: NextFunction): void {
  const capability = getScalpMutationCapability(getAuth(req)?.userId);
  if (!capability.canManage) { res.status(401).json({ error: capability.message }); return; }
  next();
}

router.get("/crypto/scalper/smart-exit/capability", (req, res) =>
  res.json(getScalpMutationCapability(getAuth(req)?.userId)));
router.get("/crypto/scalper/smart-exit/config", (_req, res) =>
  res.json({ config: getScalperSmartExitStatus().config }));
router.get("/crypto/scalper/smart-exit/status", (_req, res) =>
  res.json(getScalperSmartExitStatus()));
router.get("/crypto/scalper/smart-exit/lifecycle", async (req, res) =>
  res.json(await getScalperSmartExitLifecycle(Math.min(500, Math.max(1, Number(req.query.limit) || 100)))));
router.get("/crypto/scalper/smart-exit/replay", async (_req, res) =>
  res.json(await getScalperSmartExitReplay()));
router.post("/crypto/scalper/smart-exit/config", requireOperator, async (req, res) => {
  try { res.json({ ok: true, config: await updateScalperSmartExitConfig(req.body ?? {}) }); }
  catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
router.post("/crypto/scalper/smart-exit/emergency-disable", requireOperator, async (_req, res) =>
  res.json({ ok: true, config: await emergencyDisableScalperSmartExit() }));
export default router;