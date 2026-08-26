import { getAuth } from "@clerk/express";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getSmartExitMutationCapability } from "../lib/kalshi-smart-exit-authz.ts";
import {
  applySmartExitParameterVersion,
  calibrateSmartExitFromDurableHistory,
  emergencyDisableSmartExit,
  getSmartExitHistory,
  getSmartExitLifecycleLedger,
  getSmartExitReplayReports,
  getSmartExitStatus,
  updateSmartExitConfig,
} from "../lib/kalshi-smart-exit-service.ts";
import type { SmartExitOwnerKind } from "../lib/kalshi-smart-exit-types.ts";

const router = Router();

function requireSmartExitOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const capability = getSmartExitMutationCapability(getAuth(req)?.userId);
  if (!capability.canManage) {
    res.status(capability.reason === "forbidden" ? 403 : 401).json({ error: capability.message });
    return;
  }
  next();
}

function evaluationForApi<T extends Awaited<ReturnType<typeof getSmartExitHistory>>[number]>(
  evaluation: T,
  maxEvidenceAgeSeconds: number,
) {
  const maxAgeMs = maxEvidenceAgeSeconds * 1_000;
  const current = evaluation as T & {
    currentDataStatus?: "fresh" | "degraded";
    liveComponentHealth?: T["componentHealth"];
  };
  return {
    ...evaluation,
    confidence: evaluation.modelWinProbability,
    microstructureAvailable: evaluation.source !== "unsupported"
      && evaluation.spotReceiptAgeMs != null
      && evaluation.spotReceiptAgeMs >= 0
      && evaluation.spotReceiptAgeMs <= maxAgeMs,
    currentDataStatus: current.currentDataStatus
      ?? (evaluation.recommendation === "unavailable" ? "degraded" : "fresh"),
    liveComponentHealth: current.liveComponentHealth ?? evaluation.componentHealth,
    version: evaluation.parameterVersion,
  };
}

router.get("/crypto/smart-exit/capability", (req, res): void => {
  res.json(getSmartExitMutationCapability(getAuth(req)?.userId));
});

router.get("/crypto/smart-exit/status", (_req, res): void => {
  const status = getSmartExitStatus();
  res.json({
    ...status,
    evaluations: status.evaluations.map((evaluation) =>
      evaluationForApi(evaluation, status.config.maxEvidenceAgeSeconds)),
  });
});

router.get("/crypto/smart-exit/history", async (req, res): Promise<void> => {
  try {
    const limit = Number(req.query.limit);
    const evaluations = await getSmartExitHistory(Number.isFinite(limit) ? limit : 50);
    const maxAge = getSmartExitStatus().config.maxEvidenceAgeSeconds;
    res.json({ evaluations: evaluations.map((evaluation) => evaluationForApi(evaluation, maxAge)) });
  } catch (error) {
    req.log.error({ error }, "Failed to fetch Smart Exit history");
    res.status(500).json({ error: "Failed to fetch Smart Exit history" });
  }
});

router.get("/crypto/smart-exit/lifecycle", async (req, res): Promise<void> => {
  try {
    const limit = Number(req.query.limit);
    res.json(await getSmartExitLifecycleLedger(Number.isFinite(limit) ? limit : 100));
  } catch (error) {
    req.log.error({ error }, "Failed to fetch Smart Exit lifecycle ledger");
    res.status(500).json({ error: "Failed to fetch Smart Exit lifecycle ledger" });
  }
});

router.get("/crypto/smart-exit/replay", async (req, res): Promise<void> => {
  try {
    res.json({ reports: await getSmartExitReplayReports() });
  } catch (error) {
    req.log.error({ error }, "Failed to fetch Smart Exit replay reports");
    res.status(500).json({ error: "Failed to fetch Smart Exit replay reports" });
  }
});

router.post(
  "/crypto/smart-exit/replay/calibrate",
  requireSmartExitOperator,
  async (req, res): Promise<void> => {
    const owner = req.body?.owner as SmartExitOwnerKind | undefined;
    const symbol = typeof req.body?.symbol === "string"
      ? req.body.symbol.trim().toUpperCase()
      : undefined;
    if (owner !== undefined && owner !== "regular" && owner !== "scalper") {
      res.status(400).json({ ok: false, error: "owner must be regular or scalper" });
      return;
    }
    const rawLimit = req.body?.limitPositions;
    const requestedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (requestedLimit !== undefined && !Number.isFinite(requestedLimit)) {
      res.status(400).json({ ok: false, error: "limitPositions must be a finite number" });
      return;
    }
    const limitPositions = requestedLimit === undefined
      ? undefined
      : Math.min(50, Math.max(1, Math.floor(requestedLimit)));
    try {
      const reports = await calibrateSmartExitFromDurableHistory({
        owner,
        symbol: symbol || undefined,
        limitPositions,
      });
      res.json({ ok: true, applied: false, reports });
    } catch (error) {
      req.log.error({ error }, "Failed to calibrate Smart Exit replay");
      res.status(500).json({ ok: false, error: "Failed to calibrate Smart Exit replay" });
    }
  },
);

router.post(
  "/crypto/smart-exit/config",
  requireSmartExitOperator,
  async (req, res): Promise<void> => {
    try {
      const config = await updateSmartExitConfig(
        req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {},
      );
      res.json({ ok: true, config });
    } catch (error) {
      res.status(400).json({ ok: false, error: String((error as Error)?.message ?? error) });
    }
  },
);

router.post(
  "/crypto/smart-exit/emergency-disable",
  requireSmartExitOperator,
  async (_req, res): Promise<void> => {
    res.json({ ok: true, config: await emergencyDisableSmartExit() });
  },
);

router.post(
  "/crypto/smart-exit/apply-parameters",
  requireSmartExitOperator,
  async (req, res): Promise<void> => {
    const owner = req.body?.owner as SmartExitOwnerKind | undefined;
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim().toUpperCase() : "";
    const version = typeof req.body?.version === "string" ? req.body.version.trim() : "";
    if ((owner !== "regular" && owner !== "scalper") || !symbol || !version) {
      res.status(400).json({ ok: false, error: "owner, symbol, and version are required" });
      return;
    }
    try {
      const config = await applySmartExitParameterVersion({ owner, symbol, version });
      res.json({ ok: true, config });
    } catch (error) {
      res.status(409).json({ ok: false, error: String((error as Error)?.message ?? error) });
    }
  },
);

export default router;