// ---------------------------------------------------------------------------
// kalshi-scalper.ts — Express routes for the isolated Kalshi scalper.
//
// GET  /api/crypto/scalper/config      — {config}
// GET  /api/crypto/scalper/status      — status with ?mode=paper|live
// GET  /api/crypto/scalper/history     — {orders, total} with ?mode=&symbol=&limit=
// GET  /api/crypto/scalper/performance — one ScalpPerformance for ?mode=paper|live
// POST /api/crypto/scalper/admin/claim — first authenticated account claims admin
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
  type ScalpAdminState,
  type ScalpAuthzDecision,
} from "../lib/kalshi-scalper-authz.ts";
import {
  claimInitialScalpAdmin,
  getScalpAdminState,
} from "../lib/kalshi-scalper-admin-store.ts";
import {
  getScalpConfig,
  applyScalpConfigUpdate,
  resetCircuitBreaker,
  getScalpStatus,
  getScalpHistory,
  getScalpPerformance,
  UnresolvedAttemptsError,
} from "../lib/kalshi-scalper-service.ts";
import type { ScalpMode } from "../lib/kalshi-scalper-types.ts";

const router = Router();

// ── Mutation auth guard (STRICT, fail-closed) ────────────────────────────────
// Uses the pure decideScalpMutationAuthz helper so authorization is unit-tested
// and cannot silently fail open. Writes are denied unless the signed-in Clerk
// user holds the persisted Scalper admin role.

async function resolveScalpAuthz(req: Request): Promise<{
  userId: string | null;
  state: ScalpAdminState;
  decision: ScalpAuthzDecision;
}> {
  const auth = getAuth(req);
  const userId = auth?.userId?.trim() || null;
  const state = userId
    ? await getScalpAdminState(userId)
    : { hasAdmin: false, isAdmin: false };
  return {
    userId,
    state,
    decision: decideScalpMutationAuthz(userId, state),
  };
}

async function requireScalpAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { decision } = await resolveScalpAuthz(req);
    if (!decision.allowed) {
      res.status(decision.status).json({ error: decision.error });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ error }, "Unable to verify Scalper administrator role");
    res.status(503).json({
      error: "Scalper controls are unavailable because administrator access could not be verified",
    });
  }
}

function parseMode(v: unknown): ScalpMode | undefined {
  return v === "paper" || v === "live" ? v : undefined;
}

// ── GET /api/crypto/scalper/capability ───────────────────────────────────────
// Safe read-only projection of mutation access. Never returns either user id.

router.get("/crypto/scalper/capability", async (req, res): Promise<void> => {
  try {
    const { userId, state } = await resolveScalpAuthz(req);
    res.json(getScalpMutationCapability(userId, state));
  } catch (error) {
    req.log.error({ error }, "Unable to read Scalper administrator capability");
    res.status(503).json({
      error: "Unable to verify Scalper administrator access",
    });
  }
});

// ── POST /api/crypto/scalper/admin/claim ─────────────────────────────────────
// The first authenticated account can claim the initial admin role exactly once.
// The unique bootstrap index is the concurrency lock; this route never trusts a
// user id from the request body.

router.post("/crypto/scalper/admin/claim", async (req, res): Promise<void> => {
  const userId = getAuth(req)?.userId?.trim();
  if (!userId) {
    const capability = getScalpMutationCapability(null, {
      hasAdmin: false,
      isAdmin: false,
    });
    res.status(401).json({ ok: false, error: capability.message });
    return;
  }

  try {
    const claim = await claimInitialScalpAdmin(userId);
    const capability = getScalpMutationCapability(userId, claim.state);
    if (claim.status === "unavailable") {
      res.status(409).json({
        ok: false,
        error: "The initial Scalper administrator has already been claimed",
        capability,
      });
      return;
    }
    res.json({
      ok: true,
      claimed: claim.status === "claimed",
      capability,
    });
  } catch (error) {
    req.log.error({ error }, "Unable to claim initial Scalper administrator");
    res.status(503).json({
      ok: false,
      error: "Unable to claim Scalper administrator access",
    });
  }
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

export default router;
