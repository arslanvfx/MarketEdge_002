// ---------------------------------------------------------------------------
// kalshi-scalper.ts — Express routes for the isolated Kalshi scalper.
//
// GET  /api/crypto/scalper/config      — {config}
// GET  /api/crypto/scalper/status      — status with ?mode=paper|live
// GET  /api/crypto/scalper/history     — {orders, total} with ?mode=&symbol=&limit=
// GET  /api/crypto/scalper/performance — one ScalpPerformance for ?mode=paper|live
// POST /api/crypto/scalper/config      — top-level partial ScalpConfig → {ok,config}
// POST /api/crypto/scalper/reset-circuit-breaker → {ok,config}
// ---------------------------------------------------------------------------

import { Router } from "express";
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
  UnresolvedAttemptsError,
} from "../lib/kalshi-scalper-service.ts";
import type { ScalpMode } from "../lib/kalshi-scalper-types.ts";

const router = Router();

// ── Mutation auth guard (STRICT, fail-closed) ────────────────────────────────
// Uses the pure decideScalpMutationAuthz helper so authorization is unit-tested
// and cannot silently fail open. Writes are DENIED until BOT_ADMIN_CLERK_USER_ID
// is configured and exactly matches the signed-in Clerk user.

function requireScalpAdmin(req: any, res: any, next: any): void {
  const auth = getAuth(req);
  const decision = decideScalpMutationAuthz(
    auth?.userId,
    process.env["BOT_ADMIN_CLERK_USER_ID"],
  );
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
  const auth = getAuth(req);
  res.json(getScalpMutationCapability(
    auth?.userId,
    process.env["BOT_ADMIN_CLERK_USER_ID"],
  ));
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
