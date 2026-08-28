import { Router, type NextFunction, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import {
  changeDashboard2ExecutionOwner,
  isDashboard2ExecutionOwner,
  readDashboard2ExecutionOwner,
} from "../lib/dashboard2-ownership.ts";
import { getDashboard2RuntimeStatus } from "../lib/dashboard2-runtime.ts";
import { decideDashboard2OperatorAuthz } from "../lib/dashboard2-authz.ts";
import {
  auditDashboard2V2,
  dashboard2V2Analytics,
  dashboard2V2Audit,
  dashboard2V2DailyPerformance,
  dashboard2V2History,
  dashboard2V2Positions,
  dashboard2V2WhatIf,
  isDashboard2Mode,
  patchDashboard2V2Config,
  readDashboard2V2Config,
  readDashboard2V2SelectedMode,
  selectDashboard2V2Mode,
  dashboard2V2LiveReadiness,
  pauseDashboard2V2,
  startDashboard2V2Live,
} from "../lib/dashboard2-v2.ts";

const router = Router();
const modeFrom = (value: unknown) => isDashboard2Mode(value) ? value : null;

function requireDashboard2Auth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized — must be signed in" });
    return;
  }
  next();
}

export function requireDashboard2Operator(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const configuredUserIds = [
    process.env["BOT_ADMIN_CLERK_USER_ID"],
    process.env["DASHBOARD2_OPERATOR_CLERK_USER_IDS"],
  ].filter(Boolean).join(",");
  const decision = decideDashboard2OperatorAuthz({
    userId: auth?.userId,
    sessionClaims: auth?.sessionClaims,
    configuredUserIds,
  });
  if (decision === "unauthenticated") {
    res.status(401).json({ error: "Unauthorized — must be signed in" });
    return;
  }
  if (decision === "forbidden") {
    res.status(403).json({ error: "Forbidden — Dashboard 2.0 operator access is required" });
    return;
  }
  next();
}

router.get("/v2/dashboard2/status", requireDashboard2Auth, async (req, res) => {
  try {
    const ownership = await readDashboard2ExecutionOwner();
    res.set("Cache-Control", "no-store");
    const status = await getDashboard2RuntimeStatus(ownership.owner, ownership.updatedAt);
    res.json(status);
  } catch (error) {
    req.log.error({ err: error }, "[dashboard2] failed to read status");
    res.status(503).json({ error: "Dashboard 2.0 status unavailable; control plane failed closed" });
  }
});

router.patch("/v2/dashboard2/execution-owner", requireDashboard2Operator, async (req, res) => {
  const owner = req.body?.executionOwner;
  if (!isDashboard2ExecutionOwner(owner)) {
    res.status(400).json({ error: "executionOwner must be current_bot, dashboard2_bot, or paused" });
    return;
  }
  if (owner === "dashboard2_bot") {
    const readiness = await dashboard2V2LiveReadiness();
    if (!readiness.activationReady) {
      res.status(409).json({ error: "dashboard2_bot cannot be selected until live activation is ready", readiness });
      return;
    }
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

router.get("/v2/dashboard2/mode", requireDashboard2Auth, async (_req, res) => {
  try { res.json(await readDashboard2V2SelectedMode()); } catch { res.status(503).json({ error: "Mode control unavailable" }); }
});
router.patch("/v2/dashboard2/mode", requireDashboard2Operator, async (req, res) => {
  const mode = modeFrom(req.body?.selectedMode);
  if (!mode) return void res.status(400).json({ error: "selectedMode must be paper or live" });
  try { res.json(await selectDashboard2V2Mode(mode, getAuth(req).userId!)); } catch (error) {
    if ((error as { code?: string }).code === "MODE_ACTIVE") return void res.status(409).json({ error: (error as Error).message });
    res.status(503).json({ error: "Mode control unavailable" });
  }
});
router.get("/v2/dashboard2/activation-readiness", requireDashboard2Auth, async (_req, res) => {
  res.set("Cache-Control", "no-store").json(await dashboard2V2LiveReadiness());
});

router.get("/v2/dashboard2/config/:mode", requireDashboard2Auth, async (req, res) => {
  const mode = modeFrom(req.params.mode);
  if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try { res.set("Cache-Control", "no-store").json(await readDashboard2V2Config(mode)); }
  catch (error) { req.log.error({ err: error }, "[dashboard2] config read failed"); res.status(503).json({ error: "Dashboard 2.0 config unavailable" }); }
});
router.patch("/v2/dashboard2/config/:mode", requireDashboard2Operator, async (req, res) => {
  const mode = modeFrom(req.params.mode);
  if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try { res.json(await patchDashboard2V2Config(mode, req.body, getAuth(req).userId!)); }
  catch (error) {
    if (["VALIDATION", "ACTIVATION_PATH"].includes((error as { code?: string }).code ?? "")) return void res.status(400).json({ error: (error as Error).message });
    req.log.error({ err: error }, "[dashboard2] config patch failed"); res.status(503).json({ error: "Dashboard 2.0 config unavailable" });
  }
});
router.post("/v2/dashboard2/:mode/start", requireDashboard2Operator, async (req, res) => {
  const mode = modeFrom(req.params.mode);
  if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try {
    const value = mode === "live"
      ? await startDashboard2V2Live(getAuth(req).userId!)
      : await patchDashboard2V2Config(mode, { enabled: true }, getAuth(req).userId!);
    await auditDashboard2V2(getAuth(req).userId!, `${mode}.start`, mode, {});
    res.json(value);
  } catch (error) { req.log.error({ err: error }, "[dashboard2] start failed"); res.status(503).json({ error: `Unable to start ${mode} mode` }); }
});
router.post("/v2/dashboard2/:mode/pause", requireDashboard2Operator, async (req, res) => {
  const mode = modeFrom(req.params.mode);
  if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try {
    const value = await pauseDashboard2V2(mode, getAuth(req).userId!);
    res.json(value);
  } catch (error) { req.log.error({ err: error }, "[dashboard2] pause failed"); res.status(503).json({ error: "Unable to pause mode" }); }
});
router.get("/v2/dashboard2/history/:mode", requireDashboard2Auth, async (req, res) => {
  const mode = modeFrom(req.params.mode); if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try { res.json(await dashboard2V2History(mode, Number(req.query.limit) || 100)); } catch { res.status(503).json({ error: "History unavailable" }); }
});
router.get("/v2/dashboard2/positions/:mode", requireDashboard2Auth, async (req, res) => {
  const mode = modeFrom(req.params.mode); if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try { res.json(await dashboard2V2Positions(mode)); } catch { res.status(503).json({ error: "Positions unavailable" }); }
});
router.get("/v2/dashboard2/analytics/:mode", requireDashboard2Auth, async (req, res) => {
  const mode = modeFrom(req.params.mode); if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try { res.json(await dashboard2V2Analytics(mode)); } catch { res.status(503).json({ error: "Analytics unavailable" }); }
});
router.get("/v2/dashboard2/performance/daily/:mode", requireDashboard2Auth, async (req, res) => {
  const mode = modeFrom(req.params.mode);
  if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  try {
    res.set("Cache-Control", "no-store").json(await dashboard2V2DailyPerformance(mode));
  } catch (error) {
    req.log.error({ err: error }, "[dashboard2] daily performance read failed");
    res.status(503).json({ error: "Dashboard 2.0 performance unavailable" });
  }
});
router.get("/v2/dashboard2/performance/what-if/:mode", requireDashboard2Auth, async (req, res) => {
  const mode = modeFrom(req.params.mode);
  const rawStake = req.query.stake;
  const stake = typeof rawStake === "string" && rawStake.trim() !== "" ? Number(rawStake) : NaN;
  if (!mode) return void res.status(400).json({ error: "mode must be paper or live" });
  if (!Number.isFinite(stake) || stake < 0.01 || stake > 10_000) {
    return void res.status(400).json({ error: "stake must be a finite number from 0.01 to 10000" });
  }
  try {
    res.set("Cache-Control", "no-store").json(await dashboard2V2WhatIf(mode, stake));
  } catch (error) {
    req.log.error({ err: error }, "[dashboard2] what-if performance read failed");
    res.status(503).json({ error: "Dashboard 2.0 performance unavailable" });
  }
});
router.get("/v2/dashboard2/audit", requireDashboard2Auth, async (req, res) => {
  try { res.json(await dashboard2V2Audit(Number(req.query.limit) || 100)); } catch { res.status(503).json({ error: "Audit unavailable" }); }
});

export default router;