import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ContrarianExposureRegistry,
  ContrarianMonitorAttemptScheduler,
  DEFAULT_CONTRARIAN_CONFIG,
  buildContrarianGuardOutcomeHypothesis,
  buildContrarianGuardOutcomeStudyPayload,
  computeContrarianFillSpend,
  computeContrarianPnl,
  evaluateContrarianGuardEligibility,
  isPinnedContrarianIdentityCurrent,
  parseContrarianConfigPatch,
  planContrarianOrder,
  replayContrarianGuardOutcomeRows,
  validateContrarianConfig,
} from "./kalshi-scalper-contrarian.ts";
import type { FreefallPreSubmitDecision } from "./kalshi-scalper-policy.ts";

const RUN_CONTRARIAN_DB_TESTS =
  Boolean(process.env["DATABASE_URL"])
  && process.env["CONTRARIAN_DB_TEST"] === "1";

function decision(overrides: Record<string, unknown> = {}): FreefallPreSubmitDecision {
  return {
    allowed: false,
    reason: "freefall_consecutive_falling",
    sampleCoverageMs: 4_000,
    guardResult: {
      evaluable: true, blocked: true, reason: "freefall_consecutive_falling",
      directionalBlocked: true, wrongTargetSide: false, rapidMoveBlocked: false,
      targetPrice: 100, latestPrice: 101, projectedPrice: 99,
      adverseMovePct: 1, endpointAdverseMovePct: 1, reversalAdverseMovePct: 0,
      samplesUsed: 5, requiredSamples: 5, consecutiveWrongWayMoves: 4,
      consecutiveWrongWaySeconds: 4, requiredConsecutiveMoves: 4,
      observedSpanMs: 4_000, directionalMovePct: -1,
      favorableTrendConfirmed: false, favorableTrendBlocked: true,
      favorableTrendReason: "adverse", coordinatedDirectionClearanceApplied: false,
      coordinatedDirectionClearanceSafe: null, coordinatedDirectionClearanceReason: null,
      adversePacePctPerSecond: 0.25, projectedAdverseMovePct: 0.5,
      projectedDistancePct: -1, secondsRemaining: 2,
      targetSideWindowConfirmed: true, targetSideViolationPrice: null,
      targetSideViolationAt: null, rapidMovePct: 0, evaluatedSamples: [],
      wrongWayResetCount: 0, lastWrongWayResetAt: null,
      ...overrides,
    },
  };
}

describe("contrarian spike experiment pure boundary", () => {
  it("defaults off, paper, and tiny independent limits", () => {
    assert.deepEqual(DEFAULT_CONTRARIAN_CONFIG, {
      enabled: false, mode: "paper", budgetDollars: 0.25, dailyCapDollars: 1,
      openCapDollars: 0.5, perWindowCapDollars: 0.25,
      maxDirectContractCost: 0.03, circuitBreakerEnabled: true,
      circuitBreaker: false, circuitBreakerReason: null,
      strictEligibility: {
        finalWindowSeconds: 120, minDirectAsk: 0.01, maxDirectAsk: 0.03,
        minRepeatedAdverseMoves: 4, requireTargetCrossingOrReachableProjection: true,
      },
    });
  });

  it("allows only a directional final block with a projected/current crossing", () => {
    const result = evaluateContrarianGuardEligibility(decision(), "yes");
    assert.equal(result.eligible, true);
    if (result.eligible) assert.equal(result.oppositeSide, "no");
    assert.equal(evaluateContrarianGuardEligibility(decision({ projectedPrice: 100.01 }), "yes").eligible, false);
    assert.equal(evaluateContrarianGuardEligibility(decision({ directionalBlocked: false, rapidMoveBlocked: true }), "yes").eligible, false);
    assert.equal(evaluateContrarianGuardEligibility({ ...decision(), allowed: true }, "yes").eligible, false);
  });

  it("rejects strict-window, weak, stale, generic, and unreachable evidence", () => {
    assert.equal(evaluateContrarianGuardEligibility(decision({ secondsRemaining: 121 }), "yes").reason, "outside_strict_final_window");
    assert.equal(evaluateContrarianGuardEligibility(decision({ consecutiveWrongWayMoves: 3 }), "yes").reason, "insufficient_repeated_adverse_movement");
    assert.equal(evaluateContrarianGuardEligibility(decision({ evaluable: false }), "yes").reason, "guard_unevaluable_or_stale");
    assert.equal(evaluateContrarianGuardEligibility(decision({ reason: "rapid_move", directionalBlocked: false, rapidMoveBlocked: true }), "yes").reason, "generic_or_wrong_direction_guard_block");
    assert.equal(evaluateContrarianGuardEligibility(decision({ projectedPrice: 99, adversePacePctPerSecond: null }), "yes").reason, "target_not_crossed_or_credibly_projected");
  });

  it("only plans authenticated opposite asks in the strict 1–3¢ band", () => {
    assert.equal(planContrarianOrder({
      budgetDollars: 0.25, maxDirectContractCost: 0.03, minDirectContractCost: 0.01,
      directAsk: 0.04, oppositeSide: "no",
    }).ok, false);
    assert.equal(planContrarianOrder({
      budgetDollars: 0.25, maxDirectContractCost: 0.03, minDirectContractCost: 0.01,
      directAsk: 0.005, oppositeSide: "no",
    }).ok, false);
  });

  it("fails closed when a forced or final cached target no longer matches the pinned identity", () => {
    const pinned = {
      pinnedTicker: "KXBTC", pinnedCloseTime: "2026-01-01T00:00:00.000Z",
      pinnedTargetPrice: 100,
    };
    assert.equal(isPinnedContrarianIdentityCurrent({
      ...pinned, ticker: "KXBTC", closeTime: pinned.pinnedCloseTime, targetPrice: 100,
    }), true);
    assert.equal(isPinnedContrarianIdentityCurrent({
      ...pinned, ticker: "KXBTC", closeTime: pinned.pinnedCloseTime, targetPrice: 100.01,
    }), false);
    assert.equal(isPinnedContrarianIdentityCurrent({
      ...pinned, ticker: "KXBTC-OTHER", closeTime: pinned.pinnedCloseTime, targetPrice: 100,
    }), false);
  });

  it("bounds independent monitor attempts per mode, market, window, and side", () => {
    const scheduler = new ContrarianMonitorAttemptScheduler(3_000);
    assert.equal(scheduler.allow("paper", "btc", "w1", "yes", 1_000), true);
    assert.equal(scheduler.allow("paper", "btc", "w1", "yes", 1_250), false);
    assert.equal(scheduler.allow("paper", "btc", "w1", "no", 1_250), true);
    assert.equal(scheduler.allow("paper", "btc", "w1", "yes", 4_000), true);
    scheduler.clearExceptWindow("w2");
    assert.equal(scheduler.allow("paper", "btc", "w1", "yes", 4_100), true);
  });

  it("permits only the exact existing coordinated projected-crossing reason", () => {
    const coordinated = decision({
      directionalBlocked: false,
      favorableTrendBlocked: true,
      reason: "coordinated_direction_clearance_projected_too_close_yes",
      coordinatedDirectionClearanceReason: "coordinated_direction_clearance_projected_too_close_yes",
      projectedPrice: 99,
    });
    assert.equal(evaluateContrarianGuardEligibility(coordinated, "yes").eligible, true);
    assert.equal(evaluateContrarianGuardEligibility(decision({
      directionalBlocked: false, favorableTrendBlocked: true,
      favorableTrendReason: "favorable_trend_not_confirmed",
      projectedPrice: 99,
    }), "yes").eligible, false);
  });

  it("strictly parses config and never permits breaker latch patching", () => {
    assert.equal(parseContrarianConfigPatch({ enabled: true, mode: "live" }).ok, true);
    assert.equal(parseContrarianConfigPatch({ budgetDollars: "0.25" }).ok, false);
    assert.equal(parseContrarianConfigPatch({ circuitBreaker: false }).ok, false);
    assert.equal(parseContrarianConfigPatch({ circuitBreakerEnabled: false }).ok, false);
    assert.equal(parseContrarianConfigPatch({ maxDirectContractCost: 1 }).ok, false);
  });

  it("keeps the experiment breaker mandatory and enforces related cap ordering", () => {
    assert.ok(validateContrarianConfig({
      ...DEFAULT_CONTRARIAN_CONFIG,
      circuitBreakerEnabled: false,
    }).includes("the experiment circuit breaker must remain enabled"));
    assert.ok(validateContrarianConfig({
      ...DEFAULT_CONTRARIAN_CONFIG,
      budgetDollars: 0.5,
      perWindowCapDollars: 0.25,
    }).includes("budgetDollars cannot exceed perWindowCapDollars"));
  });

  it("sizes from the worst-case IOC limit instead of the cheaper observed ask", () => {
    const plan = planContrarianOrder({
      budgetDollars: 0.25,
      maxDirectContractCost: 0.05,
      directAsk: 0.02,
      oppositeSide: "no",
    });
    assert.deepEqual(plan, {
      ok: true,
      contractCount: 5,
      yesLimitPrice: 0.95,
      maxExposure: 0.25,
      hypotheticalAvgYesPrice: 0.98,
    });
    assert.equal(planContrarianOrder({
      budgetDollars: 0.04,
      maxDirectContractCost: 0.05,
      directAsk: 0.02,
      oppositeSide: "yes",
    }).ok, false);
  });

  it("derives confirmed fill spend from side-aware YES-price economics", () => {
    assert.equal(computeContrarianFillSpend("yes", 10, 0.04), 0.4);
    assert.ok(Math.abs((computeContrarianFillSpend("no", 10, 0.96) ?? 0) - 0.4) < 1e-9);
    assert.equal(computeContrarianFillSpend("no", 0, 0.96), null);
    assert.equal(computeContrarianFillSpend("yes", 1, 1), null);
  });

  it("settles YES and NO fills with direct contract economics", () => {
    assert.equal(computeContrarianPnl({
      side: "yes", count: 5, avgYesPrice: 0.04, result: "yes",
    }), 4.8);
    assert.ok(Math.abs(computeContrarianPnl({
      side: "no", count: 5, avgYesPrice: 0.96, result: "no",
    }) - 4.8) < 1e-9);
    assert.ok(Math.abs(computeContrarianPnl({
      side: "no", count: 5, avgYesPrice: 0.96, result: "yes",
    }) + 0.2) < 1e-9);
  });

  it("prices guard outcome hypotheses only from a valid recorded opposite ask", () => {
    assert.deepEqual(buildContrarianGuardOutcomeHypothesis({
      oppositeSide: "no",
      yesAsk: 0.97,
      noAsk: 0.04,
      budgetDollars: 2,
    }), {
      yesAsk: 0.97,
      noAsk: 0.04,
      oppositeAsk: 0.04,
      quoteSupported: true,
      hypotheticalContracts: 50,
      hypotheticalBudget: 2,
      hypotheticalAvgYesPrice: 0.96,
    });
    assert.deepEqual(buildContrarianGuardOutcomeHypothesis({
      oppositeSide: "no",
      yesAsk: 0.97,
      noAsk: null,
      budgetDollars: 2,
    }), {
      yesAsk: 0.97,
      noAsk: null,
      oppositeAsk: null,
      quoteSupported: false,
      hypotheticalContracts: 0,
      hypotheticalBudget: 0,
      hypotheticalAvgYesPrice: null,
    });
  });

  it("builds a JSON-safe prospective outbox payload from the strict guard allowlist", () => {
    const payload = buildContrarianGuardOutcomeStudyPayload({
      sourceMode: "live",
      symbol: "btc",
      windowKey: "2026-08-24T08:00",
      ticker: "KXBTC15M-26AUG240415-15",
      closeTime: "2026-08-24T08:15:00.000Z",
      protectedSide: "yes",
      decision: decision(),
      yesAsk: 0.97,
      noAsk: 0.04,
      budgetDollars: 2,
      observedAtMs: Date.parse("2026-08-24T08:14:58.000Z"),
      evidence: { phase: "initial_final_guard" },
    });
    assert.ok(payload);
    assert.deepEqual({
      version: payload.version,
      mode: payload.mode,
      symbol: payload.symbol,
      oppositeSide: payload.oppositeSide,
      quoteSupported: payload.quoteSupported,
      hypotheticalContracts: payload.hypotheticalContracts,
      observedAt: payload.observedAt,
      phase: payload.evidence.phase,
    }, {
      version: 1,
      mode: "live",
      symbol: "BTC",
      oppositeSide: "no",
      quoteSupported: true,
      hypotheticalContracts: 50,
      observedAt: "2026-08-24T08:14:58.000Z",
      phase: "initial_final_guard",
    });
    assert.equal(
      buildContrarianGuardOutcomeStudyPayload({
        sourceMode: "live",
        symbol: "BTC",
        windowKey: "w",
        ticker: "t",
        closeTime: "2026-08-24T08:15:00.000Z",
        protectedSide: "yes",
        decision: decision({ projectedPrice: 100.01 }),
        yesAsk: 0.97,
        noAsk: 0.04,
        budgetDollars: 2,
      }),
      null,
    );
  });

  it("replays a durable outbox row after transient failure and treats a race as deduplicated", async () => {
    const payload = buildContrarianGuardOutcomeStudyPayload({
      sourceMode: "paper",
      symbol: "ETH",
      windowKey: "2026-08-24T08:00",
      ticker: "KXETH15M-26AUG240415-15",
      closeTime: "2026-08-24T08:15:00.000Z",
      protectedSide: "yes",
      decision: decision(),
      yesAsk: 0.97,
      noAsk: 0.04,
      budgetDollars: 2,
      observedAtMs: Date.parse("2026-08-24T08:14:58.000Z"),
    });
    assert.ok(payload);
    const getPending = async () => [{
      mode: payload.mode,
      symbol: payload.symbol,
      windowKey: payload.windowKey,
      payload,
    }];
    const rows = await getPending();
    const failed = await replayContrarianGuardOutcomeRows(
      rows,
      async () => {
        throw new Error("temporary database outage");
      },
    );
    assert.deepEqual(failed, {
      attempted: 1,
      inserted: 0,
      deduplicated: 0,
      failed: 1,
    });
    const recovered = await replayContrarianGuardOutcomeRows(
      rows,
      async () => true,
    );
    assert.deepEqual(recovered, {
      attempted: 1,
      inserted: 1,
      deduplicated: 0,
      failed: 0,
    });
    const raced = await replayContrarianGuardOutcomeRows(
      rows,
      async () => false,
    );
    assert.deepEqual(raced, {
      attempted: 1,
      inserted: 0,
      deduplicated: 1,
      failed: 0,
    });
  });

  it("keeps paper and live exposure blocking isolated", () => {
    const registry = new ContrarianExposureRegistry();
    registry.replace([{ mode: "live", symbol: "btc", windowKey: "w", status: "unknown" }]);
    assert.equal(registry.has("live", "BTC", "w"), true);
    assert.equal(registry.has("paper", "BTC", "w"), false);
    registry.remove("live", "BTC", "w");
    assert.equal(registry.has("live", "BTC", "w"), false);
  });
});

describe("contrarian spike durable ownership boundaries", () => {
  const normalDbSource = readFileSync(
    new URL("./kalshi-scalper-db.ts", import.meta.url),
    "utf8",
  );
  const contrarianDbSource = readFileSync(
    new URL("./kalshi-scalper-contrarian-db.ts", import.meta.url),
    "utf8",
  );
  const contrarianServiceSource = readFileSync(
    new URL("./kalshi-scalper-contrarian-service.ts", import.meta.url),
    "utf8",
  );
  const scalperServiceSource = readFileSync(
    new URL("./kalshi-scalper-service.ts", import.meta.url),
    "utf8",
  );

  it("serializes normal and experiment reservation ownership on the same advisory lock", () => {
    assert.match(
      normalDbSource,
      /kalshi-scalper-contrarian-cap:\$\{mode\}/,
    );
    assert.match(
      contrarianDbSource,
      /kalshi-scalper-contrarian-cap:\$\{input\.executionMode\}/,
    );
    assert.match(
      contrarianDbSource,
      /FROM kalshi_scalp_reservations r[\s\S]*r\.status = 'claimed'[\s\S]*r\.reserved_budget > 0/,
    );
    const normalConflictBlock = normalDbSource.slice(
      normalDbSource.indexOf("const contrarianConflict"),
      normalDbSource.indexOf("// Attempt to insert this reservation"),
    );
    const contrarianConflictBlock = contrarianDbSource.slice(
      contrarianDbSource.indexOf("const normalConflict"),
      contrarianDbSource.indexOf("if (normalConflict.rows[0])"),
    );
    assert.doesNotMatch(normalConflictBlock, /r\.ticker\s*=/);
    assert.doesNotMatch(contrarianConflictBlock, /r\.ticker\s*=/);
  });

  it("permits reconciliation to transition only unresolved order states", () => {
    assert.match(
      contrarianDbSource,
      /WHERE id=\$1\s+AND status IN \('submitting','unknown'\)\s+RETURNING \*/,
    );
  });

  it("preserves stale claims that still belong to an active attempt", () => {
    const reconciliation = contrarianDbSource.slice(
      contrarianDbSource.indexOf(
        "export async function reconcileStaleContrarianReservations",
      ),
      contrarianDbSource.indexOf("async function finalize"),
    );
    assert.match(
      reconciliation,
      /activeReservationIds\.has\(reservationId\)[\s\S]*outcome: "preserved_active"/,
    );
    assert.match(
      contrarianServiceSource,
      /activeReservationByAttempt\.set\(key, reservation\.id\)/,
    );
    assert.match(
      contrarianServiceSource,
      /activeReservationIds: \[\.\.\.activeReservationByAttempt\.values\(\)\]/,
    );
  });

  it("releases only confirmed paper orphans and writes durable audit evidence", () => {
    const reconciliation = contrarianDbSource.slice(
      contrarianDbSource.indexOf(
        "export async function reconcileStaleContrarianReservations",
      ),
      contrarianDbSource.indexOf("async function finalize"),
    );
    assert.match(
      reconciliation,
      /executionMode === "live"[\s\S]*"stale_paper_orphan_released"/,
    );
    assert.match(
      reconciliation,
      /AND NOT EXISTS \([\s\S]*FROM kalshi_scalp_contrarian_orders o[\s\S]*RETURNING \*/,
    );
    assert.match(
      reconciliation,
      /recordReservationReconciliationIncident\([\s\S]*reason,[\s\S]*evidence,[\s\S]*true/,
    );
    assert.match(
      reconciliation,
      /SET status='released',[\s\S]*reserved_budget=0/,
    );
  });

  it("uses a cross-worker ownership lease before reconciling a stale claim", () => {
    assert.match(
      contrarianDbSource,
      /pg_try_advisory_lock\(hashtextextended\(\$1,0\)\) AS acquired/,
    );
    assert.match(
      contrarianDbSource,
      /pg_try_advisory_xact_lock\(hashtextextended\(\$1,0\)\) AS acquired/,
    );
    assert.match(
      contrarianDbSource,
      /reservationOwnershipLockKey\(\{[\s\S]*executionMode,[\s\S]*symbol:/,
    );
    const claimToIntent = contrarianServiceSource.slice(
      contrarianServiceSource.indexOf(
        "reservationOwnership = await acquireContrarianReservationOwnership",
      ),
      contrarianServiceSource.indexOf("const postIntentReason"),
    );
    const acquire = claimToIntent.indexOf(
      "acquireContrarianReservationOwnership",
    );
    const claim = claimToIntent.indexOf("claimContrarianReservation");
    const intent = claimToIntent.indexOf("insertContrarianOrderIntent");
    const release = claimToIntent.indexOf("completedOwnership.release()");
    assert.ok(acquire >= 0 && acquire < claim);
    assert.ok(claim >= 0 && claim < intent);
    assert.ok(intent >= 0 && intent < release);
    assert.match(
      contrarianDbSource,
      /MAX_CONTRARIAN_RESERVATION_OWNERSHIP_LEASES = 2/,
    );
  });

  it("keeps live and ambiguous stale reservations fail-closed for review", () => {
    const reconciliation = contrarianDbSource.slice(
      contrarianDbSource.indexOf(
        "export async function reconcileStaleContrarianReservations",
      ),
      contrarianDbSource.indexOf("async function finalize"),
    );
    assert.match(
      reconciliation,
      /if \(hasOrderIntent \|\| executionMode === "live"\)[\s\S]*outcome: "review_required"/,
    );
    assert.match(
      reconciliation,
      /"stale_claim_has_order_intent_review_required"/,
    );
    assert.match(reconciliation, /"stale_live_claim_review_required"/);
    assert.match(
      reconciliation,
      /recordReservationReconciliationIncident\([\s\S]*false/,
    );
  });

  it("runs bounded stale-claim recovery at startup and during lifecycle ticks", () => {
    assert.match(
      contrarianDbSource,
      /CONTRARIAN_RESERVATION_STALE_TIMEOUT_MS = 2 \* 60_000/,
    );
    assert.match(
      contrarianDbSource,
      /CONTRARIAN_RESERVATION_RECONCILE_BATCH_SIZE = 100/,
    );
    const initialization = contrarianServiceSource.slice(
      contrarianServiceSource.indexOf(
        "export async function initContrarianExperiment",
      ),
      contrarianServiceSource.indexOf(
        "export function getContrarianConfig",
      ),
    );
    assert.match(initialization, /reconcileStaleContrarianReservations/);
    const lifecycle = contrarianServiceSource.slice(
      contrarianServiceSource.indexOf(
        "export async function evaluateContrarianLifecycle",
      ),
      contrarianServiceSource.indexOf(
        "export async function getContrarianReport",
      ),
    );
    assert.match(lifecycle, /reconcileStaleContrarianReservations/);
  });

  it("keeps the prospective guard study isolated and deduplicated", () => {
    assert.match(
      contrarianDbSource,
      /CREATE TABLE IF NOT EXISTS kalshi_scalp_guard_outcome_studies/,
    );
    assert.match(
      contrarianDbSource,
      /PRIMARY KEY\(mode,symbol,window_key\)/,
    );
    assert.match(
      contrarianDbSource,
      /ON CONFLICT\(mode,symbol,window_key\) DO NOTHING/,
    );
    assert.match(
      contrarianDbSource,
      /r\.attempted_at >= m\.tracking_started_at/,
    );
    assert.match(
      contrarianDbSource,
      /r\.skip_evidence->'guardOutcomeStudy'/,
    );
    assert.match(
      scalperServiceSource,
      /"initial_final_guard"/,
    );
    assert.match(
      scalperServiceSource,
      /"paper_final_guard"/,
    );
    assert.match(
      scalperServiceSource,
      /"live_final_guard"/,
    );
    assert.match(
      scalperServiceSource,
      /guardOutcomeStudy,/,
    );
    assert.doesNotMatch(
      scalperServiceSource,
      /scheduleGuardOutcomeStudy|recordContrarianGuardOutcomeStudy/,
    );
  });

  it("runs the independent strict monitor before normal disabled and breaker exits", () => {
    const scan = scalperServiceSource.slice(
      scalperServiceSource.indexOf("async function _doScanTick"),
      scalperServiceSource.indexOf("interface Candidate"),
    );
    const monitor = scan.indexOf("_monitorStrictContrarianMarkets(wk, Date.now())");
    assert.ok(monitor >= 0);
    assert.ok(monitor < scan.indexOf("if (!_config.enabled)"));
    assert.ok(monitor < scan.indexOf("if (_isCircuitBreakerBlocking())"));
    assert.match(scalperServiceSource, /new ContrarianMonitorAttemptScheduler/);
  });
});

describe(
  "contrarian stale reservation reconciliation (PostgreSQL)",
  {
    skip: !RUN_CONTRARIAN_DB_TESTS
      ? "set CONTRARIAN_DB_TEST=1 with a development DATABASE_URL"
      : false,
  },
  () => {
    let contrarianDb: typeof import("./kalshi-scalper-contrarian-db.ts");
    let pool: {
      connect: () => Promise<{
        query: (
          sql: string,
          params?: readonly unknown[],
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
        release: (error?: Error | boolean) => void;
      }>;
    };
    const prefix = "DBTEST-CONTRARIAN-";

    async function cleanup(): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query(
          `DELETE FROM kalshi_scalp_contrarian_incidents
            WHERE window_key LIKE $1`,
          [`${prefix}%`],
        );
        await c.query(
          `DELETE FROM kalshi_scalp_contrarian_orders
            WHERE window_key LIKE $1`,
          [`${prefix}%`],
        );
        await c.query(
          `DELETE FROM kalshi_scalp_contrarian_reservations
            WHERE window_key LIKE $1`,
          [`${prefix}%`],
        );
      } finally {
        c.release();
      }
    }

    async function claim(
      executionMode: "paper" | "live",
      suffix: string,
      symbol = "BTC",
    ) {
      const windowKey = `${prefix}${suffix}-${Date.now()}`;
      const result = await contrarianDb.claimContrarianReservation({
        executionMode,
        sourceMode: executionMode,
        symbol,
        windowKey,
        ticker: `KX${symbol}-${suffix}`,
        requestedBudget: 1,
        dailyCap: 100,
        openCap: 100,
        perWindowCap: 100,
      });
      assert.equal(result.claimed, true);
      if (!result.claimed) throw new Error("test claim failed");
      return result.reservation;
    }

    async function ageReservation(reservationId: string): Promise<void> {
      const c = await pool.connect();
      try {
        await c.query(
          `UPDATE kalshi_scalp_contrarian_reservations
              SET updated_at=NOW() - INTERVAL '3 minutes'
            WHERE id=$1`,
          [reservationId],
        );
      } finally {
        c.release();
      }
    }

    async function reservationStatus(
      reservationId: string,
    ): Promise<{ status: string; reservedBudget: number }> {
      const c = await pool.connect();
      try {
        const result = await c.query(
          `SELECT status,reserved_budget
             FROM kalshi_scalp_contrarian_reservations
            WHERE id=$1`,
          [reservationId],
        );
        assert.ok(result.rows[0]);
        return {
          status: String(result.rows[0]["status"]),
          reservedBudget: Number(result.rows[0]["reserved_budget"]),
        };
      } finally {
        c.release();
      }
    }

    before(async () => {
      contrarianDb = await import("./kalshi-scalper-contrarian-db.ts");
      const db = await import("@workspace/db");
      pool = db.pool as typeof pool;
      await contrarianDb.runContrarianMigrations();
    });
    beforeEach(cleanup);
    after(async () => {
      await cleanup();
      const db = await import("@workspace/db");
      await db.pool.end();
    });

    it("preserves an old paper claim listed as locally active", async () => {
      const reservation = await claim("paper", "active");
      await ageReservation(reservation.id);
      const result = await contrarianDb.reconcileStaleContrarianReservations({
        activeReservationIds: [reservation.id],
        reservationIds: [reservation.id],
        staleAfterMs: 1_000,
      });
      assert.equal(result.preservedActive, 1);
      assert.equal(result.results[0]?.reason, "active_contrarian_attempt");
      assert.deepEqual(await reservationStatus(reservation.id), {
        status: "claimed",
        reservedBudget: 1,
      });
    });

    it("releases an old paper orphan and persists resolved audit evidence", async () => {
      const reservation = await claim("paper", "orphan");
      await ageReservation(reservation.id);
      const result = await contrarianDb.reconcileStaleContrarianReservations({
        reservationIds: [reservation.id],
        staleAfterMs: 1_000,
      });
      assert.equal(result.released, 1);
      assert.deepEqual(await reservationStatus(reservation.id), {
        status: "released",
        reservedBudget: 0,
      });
      const c = await pool.connect();
      try {
        const incidents = await c.query(
          `SELECT reason,evidence,resolved_at
             FROM kalshi_scalp_contrarian_incidents
            WHERE reservation_id=$1`,
          [reservation.id],
        );
        assert.equal(incidents.rows[0]?.["reason"], "stale_paper_orphan_released");
        assert.equal(
          (incidents.rows[0]?.["evidence"] as Record<string, unknown>)?.["source"],
          "stale_reservation_reconciliation",
        );
        assert.ok(incidents.rows[0]?.["resolved_at"]);
      } finally {
        c.release();
      }
    });

    it("honors concurrent ownership without exhausting the shared pool", async () => {
      const windowKey = `${prefix}owned-${Date.now()}`;
      const owner = await contrarianDb.acquireContrarianReservationOwnership({
        executionMode: "paper",
        symbol: "ETH",
        windowKey,
      });
      assert.ok(owner);
      const reservation = await contrarianDb.claimContrarianReservation({
        executionMode: "paper",
        sourceMode: "paper",
        symbol: "ETH",
        windowKey,
        ticker: "KXETH-OWNED",
        requestedBudget: 1,
        dailyCap: 100,
        openCap: 100,
        perWindowCap: 100,
      });
      assert.equal(reservation.claimed, true);
      if (!reservation.claimed || !owner) throw new Error("ownership setup failed");
      await ageReservation(reservation.reservation.id);

      const second = await contrarianDb.acquireContrarianReservationOwnership({
        executionMode: "paper",
        symbol: "SOL",
        windowKey: `${prefix}second-${Date.now()}`,
      });
      assert.ok(second);
      const saturated = await contrarianDb.acquireContrarianReservationOwnership({
        executionMode: "paper",
        symbol: "XRP",
        windowKey: `${prefix}saturated-${Date.now()}`,
      });
      assert.equal(saturated, null);

      const preserved = await contrarianDb.reconcileStaleContrarianReservations({
        reservationIds: [reservation.reservation.id],
        staleAfterMs: 1_000,
      });
      assert.equal(preserved.preservedActive, 1);
      assert.equal(preserved.results[0]?.reason, "concurrent_contrarian_owner");
      await second?.release();
      await owner.release();

      const released = await contrarianDb.reconcileStaleContrarianReservations({
        reservationIds: [reservation.reservation.id],
        staleAfterMs: 1_000,
      });
      assert.equal(released.released, 1);
    });

    it("retains live and intent-bearing reservations for review", async () => {
      const live = await claim("live", "live", "SOL");
      const ambiguous = await claim("paper", "intent", "XRP");
      await contrarianDb.insertContrarianOrderIntent({
        reservationId: ambiguous.id,
        executionMode: "paper",
        sourceMode: "paper",
        symbol: ambiguous.symbol,
        windowKey: ambiguous.windowKey,
        ticker: ambiguous.ticker,
        protectedSide: "yes",
        oppositeSide: "no",
        contractCount: 1,
        yesLimitPrice: 0.98,
        directAsk: 0.02,
        yesAsk: 0.98,
        noAsk: 0.02,
        clientOrderId: `paper-${ambiguous.id}`,
        evidence: { source: "db_test" },
      });
      await ageReservation(live.id);
      await ageReservation(ambiguous.id);

      const result = await contrarianDb.reconcileStaleContrarianReservations({
        reservationIds: [live.id, ambiguous.id],
        staleAfterMs: 1_000,
      });
      assert.equal(result.released, 0);
      assert.equal(result.reviewRequired, 2);
      assert.deepEqual(await reservationStatus(live.id), {
        status: "claimed",
        reservedBudget: 1,
      });
      assert.deepEqual(await reservationStatus(ambiguous.id), {
        status: "claimed",
        reservedBudget: 1,
      });
      const reasons = result.results.map((row) => row.reason).sort();
      assert.deepEqual(reasons, [
        "stale_claim_has_order_intent_review_required",
        "stale_live_claim_review_required",
      ]);
      const c = await pool.connect();
      try {
        const incidents = await c.query(
          `SELECT reason,resolved_at
             FROM kalshi_scalp_contrarian_incidents
            WHERE reservation_id=ANY($1)
            ORDER BY reason`,
          [[live.id, ambiguous.id]],
        );
        assert.deepEqual(
          incidents.rows.map((row) => [row["reason"], row["resolved_at"]]),
          [
            ["stale_claim_has_order_intent_review_required", null],
            ["stale_live_claim_review_required", null],
          ],
        );
      } finally {
        c.release();
      }
    });
  },
);