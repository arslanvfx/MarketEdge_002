// ---------------------------------------------------------------------------
// kalshi-scalper.ts — Express routes for the isolated Kalshi scalper.
//
// GET  /api/crypto/scalper/config      — {config}
// GET  /api/crypto/scalper/status      — status with ?mode=paper|live
// GET  /api/crypto/scalper/history     — {orders, total} with ?mode=&symbol=&limit=
// GET  /api/crypto/scalper/performance — one ScalpPerformance for ?mode=paper|live
// GET  /api/crypto/scalper/funnel      — rolling per-window execution funnel
// GET  /api/crypto/scalper/shadow-study — earlier-entry counterfactual report
// POST /api/crypto/scalper/config      — top-level partial ScalpConfig → {ok,config}
// POST /api/crypto/scalper/reset-circuit-breaker → {ok,config}
// ---------------------------------------------------------------------------

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getAuth } from "@clerk/express";
import { parseScalpConfigPatch } from "../lib/kalshi-scalper-policy.ts";
import {
  decideScalpMutationAuthz,
  getScalpMutationCapability,
} from "../lib/kalshi-scalper-authz.ts";
import {
  getScalpConfig,
  applyScalpConfigUpdate,
  resetCircuitBreaker,
  getScalpStatus,
  getScalpHistory,
  getScalpPerformance,
  getScalpWindowFunnel,
  getScalpShadowStudy,
  resetScalpPerformance,
  reconcileUnresolvedScalpOrder,
  ScalpReconciliationError,
  UnresolvedAttemptsError,
} from "../lib/kalshi-scalper-service.ts";
import type { ScalpMode } from "../lib/kalshi-scalper-types.ts";

const router = Router();

// ── Mutation auth guard (STRICT, fail-closed) ────────────────────────────────
// Matches the rest of the bot: a valid signed-in Clerk session is sufficient.
// The pure helper still fails closed when Clerk provides no user identity.

function requireScalpAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const decision = decideScalpMutationAuthz(getAuth(req)?.userId);
  if (!decision.allowed) {
    res.status(decision.status).json({ error: decision.error });
    return;
  }
  next();
}

function parseMode(v: unknown): ScalpMode | undefined {
  return v === "paper" || v === "live" ? v : undefined;
}

// ── GET /api/crypto/scalper/capability ───────────────────────────────────────
// Safe read-only projection of mutation access. Never returns either user id.

router.get("/crypto/scalper/capability", (req, res): void => {
  res.json(getScalpMutationCapability(getAuth(req)?.userId));
});

// ── GET /api/crypto/scalper/config ───────────────────────────────────────────

router.get("/crypto/scalper/config", async (_req, res): Promise<void> => {
  try {
    const config = getScalpConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scalper config" });
  }
});

// ── GET /api/crypto/scalper/status ───────────────────────────────────────────

router.get("/crypto/scalper/status", async (req, res): Promise<void> => {
  try {
    const mode = parseMode(req.query["mode"]);
    const status = await getScalpStatus(mode);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scalper status" });
  }
});

// ── GET /api/crypto/scalper/history ──────────────────────────────────────────

router.get("/crypto/scalper/history", async (req, res): Promise<void> => {
  try {
    const mode = parseMode(req.query["mode"]);
    const symbolParam = req.query["symbol"];
    const symbol = typeof symbolParam === "string" ? symbolParam.toUpperCase() : undefined;
    const limitParam = req.query["limit"];
    const limit = typeof limitParam === "string"
      ? Math.min(500, Math.max(1, parseInt(limitParam, 10) || 100))
      : 100;

    const result = await getScalpHistory({ mode, symbol, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scalper history" });
  }
});

// ── GET /api/crypto/scalper/performance ──────────────────────────────────────
// Returns ONE performance object for the requested mode (default: current config mode).

router.get("/crypto/scalper/performance", async (req, res): Promise<void> => {
  try {
    const config = getScalpConfig();
    const mode = parseMode(req.query["mode"]) ?? config.mode;
    const performance = await getScalpPerformance(mode);
    res.json(performance);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scalper performance" });
  }
});

// ── GET /api/crypto/scalper/funnel ───────────────────────────────────────────
// Reporting-only. The 2–3 fill target is deliberately not an execution input.
router.get("/crypto/scalper/funnel", async (req, res): Promise<void> => {
  try {
    const config = getScalpConfig();
    const mode = parseMode(req.query["mode"]) ?? config.mode;
    const windowsParam = typeof req.query["windows"] === "string"
      ? Number.parseInt(req.query["windows"], 10)
      : 12;
    const funnel = await getScalpWindowFunnel(
      mode,
      Number.isFinite(windowsParam) ? windowsParam : 12,
    );
    res.json(funnel);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scalper funnel" });
  }
});

// ── GET /api/crypto/scalper/shadow-study ─────────────────────────────────────
// Reporting-only. Shadow candidates are cached-quote counterfactuals and never
// feed reservations, caps, execution, reconciliation, or real performance.
router.get("/crypto/scalper/shadow-study", async (req, res): Promise<void> => {
  try {
    const config = getScalpConfig();
    const mode = parseMode(req.query["mode"]) ?? config.mode;
    const limitParam = typeof req.query["limit"] === "string"
      ? Number.parseInt(req.query["limit"], 10)
      : 144;
    const study = await getScalpShadowStudy(
      mode,
      Number.isFinite(limitParam) ? limitParam : 144,
    );
    res.json(study);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Scalper shadow study" });
  }
});

// ── POST /api/crypto/scalper/reset-performance (signed-in operator) ──────────
// Reporting-only: advances one mode's entry-time baseline without mutating the
// order ledger, active positions, configuration, or safety state.

router.post("/crypto/scalper/reset-performance", requireScalpAdmin, async (req, res): Promise<void> => {
  const mode = parseMode(req.body?.mode);
  if (!mode) {
    res.status(400).json({ ok: false, error: "mode must be paper or live" });
    return;
  }
  try {
    const performance = await resetScalpPerformance(mode);
    req.log.info(
      { mode, trackingSince: performance.trackingSince },
      "Reset Scalper performance reporting window",
    );
    res.json({ ok: true, performance });
  } catch (err) {
    req.log.error({ err, mode }, "Failed to reset Scalper performance reporting window");
    res.status(500).json({ ok: false, error: "Failed to reset Scalper performance" });
  }
});

// ── POST /api/crypto/scalper/config (admin) ───────────────────────────────────
// Accepts a top-level partial ScalpConfig (NOT {config: ...}).
// Returns {ok: true, config}.

router.post("/crypto/scalper/config", requireScalpAdmin, async (req, res): Promise<void> => {
  try {
    // STRICT typed parse + normalization. Rejects (never coerces) unknown/
    // internal fields, wrong types, numeric strings, NaN/Infinity, bad ranges,
    // malformed overrides. Internal circuitBreaker fields are not accepted here.
    const parsed = parseScalpConfigPatch(req.body);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: "Invalid config", errors: parsed.errors });
      return;
    }

    // Pass ONLY the parsed, normalized value to the service — never raw req.body.
    const updated = await applyScalpConfigUpdate(parsed.value);
    res.json({ ok: true, config: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── POST /api/crypto/scalper/reset-circuit-breaker (admin) ───────────────────
// Returns {ok: true, config}.

router.post("/crypto/scalper/reset-circuit-breaker", requireScalpAdmin, async (_req, res): Promise<void> => {
  try {
    const config = await resetCircuitBreaker();
    res.json({ ok: true, config });
  } catch (err) {
    // Refuse (409 Conflict) when unresolved live attempts require manual
    // reconciliation. No blind resolve endpoint is provided by design.
    if (err instanceof UnresolvedAttemptsError) {
      res.status(409).json({
        ok: false,
        error: err.message,
        unresolvedCount: err.unresolvedCount,
        unresolved: err.details,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ── POST /api/crypto/scalper/reconcile-order (admin) ─────────────────────────
// Exchange-backed only: ambiguous evidence returns 409 and leaves all state held.

router.post("/crypto/scalper/reconcile-order", requireScalpAdmin, async (req, res): Promise<void> => {
  const orderRecordId = typeof req.body?.orderRecordId === "string"
    ? req.body.orderRecordId.trim()
    : "";
  if (!orderRecordId || orderRecordId.length > 100) {
    res.status(400).json({ ok: false, error: "A valid unresolved order record is required." });
    return;
  }
  try {
    const result = await reconcileUnresolvedScalpOrder(orderRecordId);
    res.json(result);
  } catch (err) {
    if (err instanceof ScalpReconciliationError) {
      res.status(409).json({
        ok: false,
        error: err.message,
        reason: err.reason,
        evidence: err.evidence,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes("not found") ? 404 : 500).json({ ok: false, error: msg });
  }
});

export default router;
