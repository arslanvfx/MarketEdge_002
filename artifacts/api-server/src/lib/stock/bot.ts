// Stock trading bot engine. Runs on a market-hours-gated cycle, independent of
// the crypto/Kalshi bot. Responsibilities:
//   - manage open positions with per-horizon exit rules (day EOD close, swing
//     target/stop, long-term research re-rating + trailing stop, ML outcome)
//   - respect risk limits (daily loss, per-mode & total position caps, PDT,
//     earnings blackout)
//   - open new positions autonomously from Claude research reports (multi-
//     horizon) combined with live technical signals, timed via Level 1 quotes
//   - keep a rolling decision log (last 50 ENTER/EXIT/SKIP decisions with
//     reasoning) surfaced on the bot status endpoint
//
// The DB (stock_bot_bets) is the source of truth for positions so the bot is
// fully restart-safe. Nothing here imports from crypto.ts / kalshi-bot.ts.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import {
  alpacaConfigured,
  getClock,
  getAccount,
  getLatestPrice,
  getLevel1Quote,
  getOrderBook,
  placeOrder,
  getOrder,
  cancelOrder,
  closePosition,
} from "./alpaca";
import { getConfig, saveConfig } from "./config";
import { selectEntryMode, heldKey, computeRiskControls, computeExitLevels } from "./bot-entry-core";
import { confirmOrderFill, planProvisionalReconciliation } from "./order-confirm";
import { getCandles } from "./data";
import { buildSignals } from "./ai";
import { buildFeatures, recordOutcome } from "./ml";
import { getScoredNews } from "./news";
import { getEarnings } from "./earnings";
import { getScannerResults, getSectorMomentum } from "./scanner";
import { getCachedResearch, getTodayReports, researchPositionExit } from "./research";
import { lookupUniverse } from "./universe";
import { watchlistTickers } from "./watchlist";
import { getMacroTrend } from "./macro-filter";
import { consumeNewsAlert, registerPositionTicker, unregisterPositionTicker } from "./news-monitor";
import { isAiFeatureEnabled } from "../ai-spend";
import { stockAiPermitted } from "./ai-policy";
import type { Candle, TradingMode, StockBotConfig, ResearchReport, ScannerRow } from "./types";
import { DAY_EOD_BUFFER_MS, evaluateExitReason } from "./bot-manage-core";

let running = false;
let lastCycleAt = 0;
let lastCycleSummary = "";

// ── Per-horizon exit rules (Task spec) ──────────────────────────────────────
const LONG_ENTRY_MIN_CONF = 75;           // research confidence gate for long entries

// ── Level 1 entry-timing gate ───────────────────────────────────────────────
const MAX_ENTRY_SPREAD_PCT = 0.3;
const MIN_ENTRY_IMBALANCE = 1.2;

/** Is the unified AI layer active? Config toggle AND spend-guard must agree. */
function aiActive(cfg: StockBotConfig): boolean {
  return stockAiPermitted(cfg.aiEnabled, isAiFeatureEnabled("stock_research"));
}

// ── Rolling decision log (last 50 in-memory, persisted to stock_bot_decisions)
export interface BotDecision {
  ts: number;
  ticker: string;
  action: "ENTER" | "EXIT" | "SKIP";
  horizon: TradingMode | null;
  confidence: number | null;
  reason: string;
  /** Claude research summary — populated for ENTER decisions in current session. */
  claudeReasoning?: string | null;
}

const DECISION_LOG_MAX = 50;
const DECISION_RETENTION_DAYS = 7;
const DECISION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // prune at most every 6h

const decisionLog: BotDecision[] = [];
let lastDecisionCleanupAt = 0;

function recordDecision(d: Omit<BotDecision, "ts">): void {
  const decision: BotDecision = { ts: Date.now(), ...d };
  decisionLog.unshift(decision);
  if (decisionLog.length > DECISION_LOG_MAX) decisionLog.length = DECISION_LOG_MAX;

  // Persist asynchronously so a slow/unavailable DB never blocks the bot cycle.
  // For ENTER decisions, we embed claudeReasoning into the reason field using a
  // delimiter so it survives restarts without a schema change.
  const persistedReason = decision.claudeReasoning
    ? `${decision.reason}|||${decision.claudeReasoning}`
    : decision.reason;
  db.execute(sql`
    INSERT INTO stock_bot_decisions (ticker, action, horizon, confidence, reason, ts)
    VALUES (${decision.ticker}, ${decision.action}, ${decision.horizon},
            ${decision.confidence}, ${persistedReason}, to_timestamp(${decision.ts / 1000}))
  `).catch((err) => logger.warn({ err }, "[stock-bot] decision persist failed"));

  // Opportunistic retention cleanup, throttled so it doesn't run every insert.
  const now = Date.now();
  if (now - lastDecisionCleanupAt >= DECISION_CLEANUP_INTERVAL_MS) {
    lastDecisionCleanupAt = now;
    cleanupOldDecisions();
  }
}

function cleanupOldDecisions(): void {
  db.execute(sql`
    DELETE FROM stock_bot_decisions
    WHERE ts < NOW() - make_interval(days => ${DECISION_RETENTION_DAYS})
  `).catch((err) => logger.warn({ err }, "[stock-bot] decision cleanup failed"));
}

/** Hydrate the in-memory decision feed from the DB after a restart. */
export async function initDecisionLogFromDB(): Promise<void> {
  const res = (await db.execute(sql`
    SELECT ticker, action, horizon, confidence, reason, ts
    FROM stock_bot_decisions
    WHERE ts >= NOW() - make_interval(days => ${DECISION_RETENTION_DAYS})
    ORDER BY ts DESC
    LIMIT ${DECISION_LOG_MAX}
  `)) as unknown as { rows: any[] };
  const rows = res.rows ?? [];
  decisionLog.length = 0;
  for (const r of rows) {
    const rawReason = String(r.reason ?? "");
    const delimIdx = rawReason.indexOf("|||");
    const reason = delimIdx >= 0 ? rawReason.slice(0, delimIdx) : rawReason;
    const claudeReasoning = delimIdx >= 0 ? rawReason.slice(delimIdx + 3) : undefined;
    decisionLog.push({
      ts: new Date(r.ts).getTime(),
      ticker: String(r.ticker),
      action: r.action as BotDecision["action"],
      horizon: (r.horizon ?? null) as TradingMode | null,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      reason,
      claudeReasoning,
    });
  }
  lastDecisionCleanupAt = Date.now();
  cleanupOldDecisions();
  logger.info({ count: decisionLog.length }, "[stock-bot] decision log hydrated from DB");
}

export function getDecisionLog(): BotDecision[] {
  return [...decisionLog];
}

interface OpenBetRow {
  id: string;
  ticker: string;
  sector: string | null;
  tradingMode: TradingMode;
  /** "long" = long position (buy to open); "short" = short position (sell to open). */
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  stopLoss: number | null;
  targetPrice: number | null;
  peakPrice: number | null;
  notional: number;
  confidence: number;
  signals: any;
  alpacaOrderId: string | null;
  createdAt: Date;
}


async function openBets(mode: "paper" | "live"): Promise<OpenBetRow[]> {
  const res = (await db.execute(sql`
    SELECT id, ticker, sector, trading_mode, side, qty, entry_price, stop_loss, target_price,
           peak_price, notional, confidence, signals, alpaca_order_id, created_at
    FROM stock_bot_bets
    WHERE action IN ('buy', 'short_sell') AND exited_at IS NULL AND mode = ${mode}
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    sector: r.sector,
    tradingMode: r.trading_mode as TradingMode,
    side: (r.side === "short" ? "short" : "long") as "long" | "short",
    qty: Number(r.qty) || 0,
    entryPrice: Number(r.entry_price) || 0,
    stopLoss: r.stop_loss != null ? Number(r.stop_loss) : null,
    targetPrice: r.target_price != null ? Number(r.target_price) : null,
    peakPrice: r.peak_price != null ? Number(r.peak_price) : null,
    notional: Number(r.notional) || 0,
    confidence: Number(r.confidence) || 0,
    signals: r.signals ?? {},
    alpacaOrderId: r.alpaca_order_id ?? null,
    createdAt: new Date(r.created_at),
  }));
}

async function todayRealizedPnl(mode: "paper" | "live"): Promise<number> {
  const res = (await db.execute(sql`
    SELECT COALESCE(SUM(pnl), 0) AS pnl
    FROM stock_bot_bets
    WHERE mode = ${mode} AND exited_at IS NOT NULL
      AND exited_at >= date_trunc('day', NOW())
  `)) as unknown as { rows: any[] };
  return Number(res.rows?.[0]?.pnl) || 0;
}

async function exitPosition(
  bet: OpenBetRow,
  mode: "paper" | "live",
  exitPrice: number,
  reason: string,
): Promise<void> {
  // Defense in depth: a provisional row must never be marked flat — a broker
  // 404 proves nothing while its entry order state is unconfirmed (the order
  // could still fill later in the session). Reconciliation must run first.
  if (isProvisionalBet(bet)) {
    throw new Error(`refusing to exit provisional bet ${bet.id} (${bet.ticker}) — entry fill unconfirmed`);
  }
  // Broker close must succeed (or confirm already-flat via 404) before we mark
  // the DB row exited. If it fails we leave the row open so the next cycle
  // retries — the DB must never say flat while the broker still holds risk.
  try {
    // Belt-and-braces: cancel any still-working entry order first, so an
    // "already flat" broker response can never be followed by a late entry
    // fill that opens an untracked position. Terminal orders no-op (404/422).
    if (bet.alpacaOrderId) await cancelOrder(mode, bet.alpacaOrderId).catch(() => {});
    await closePosition(mode, bet.ticker);
  } catch (err) {
    logger.warn(
      { err, ticker: bet.ticker },
      "[stock-bot] closePosition failed — keeping position open for retry",
    );
    throw err;
  }
  // Short P&L is inverted: profit when price drops below entry.
  const pnl = bet.side === "short"
    ? (bet.entryPrice - exitPrice) * bet.qty
    : (exitPrice - bet.entryPrice) * bet.qty;
  const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "push";
  unregisterPositionTicker(bet.ticker);
  await db.execute(sql`
    UPDATE stock_bot_bets SET
      exit_price = ${exitPrice},
      pnl = ${pnl},
      outcome = ${outcome},
      exit_reason = ${reason},
      exited_at = NOW(),
      evaluated_at = NOW()
    WHERE id = ${bet.id}
  `);
  // Feed the ML model: label = did price rise from entry?
  const features: number[] | undefined = bet.signals?.features;
  if (Array.isArray(features)) {
    const label = exitPrice >= bet.entryPrice ? 1 : 0;
    await recordOutcome(bet.ticker, bet.id, features, label);
  }
  recordDecision({
    ticker: bet.ticker,
    action: "EXIT",
    horizon: bet.tradingMode,
    confidence: bet.confidence,
    reason: `${reason} @ $${exitPrice.toFixed(2)} (P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`,
  });
  logger.info({ ticker: bet.ticker, pnl: pnl.toFixed(2), reason }, "[stock-bot] exited position");
}

/**
 * Manually close a single open position on demand (from the dashboard).
 *
 * Uses the same broker-confirm-then-record flow as the automatic exit so the
 * DB is never marked flat while the broker still holds risk. Reason is recorded
 * as "manual" so it is distinguishable from bot-driven exits in the history.
 */
export async function manualClosePosition(
  ticker: string,
): Promise<{ closed: boolean; ticker: string; qty: number; exitPrice: number; pnl: number }> {
  if (!alpacaConfigured()) throw new Error("Alpaca is not configured");
  const cfg = getConfig();
  const sym = ticker.trim().toUpperCase();
  const open = await openBets(cfg.mode);
  const bet = open.find((b) => b.ticker.toUpperCase() === sym);
  if (!bet) throw new Error(`No open ${cfg.mode} position for ${sym}`);

  // Best-effort live price for P&L; fall back to entry if the quote is missing
  // so the close still proceeds (the broker sells at market regardless).
  let price = await getLatestPrice(bet.ticker);
  if (price == null || price <= 0) price = bet.entryPrice;

  await exitPosition(bet, cfg.mode, price, "manual");
  const pnl = bet.side === "short"
    ? (bet.entryPrice - price) * bet.qty
    : (price - bet.entryPrice) * bet.qty;
  return { closed: true, ticker: bet.ticker, qty: bet.qty, exitPrice: price, pnl };
}

/**
 * Poll Alpaca news for all currently-open positions.
 * Called on a 5-min interval by the stock vertical — the results are consumed
 * per-tick inside managePositions via consumeNewsAlert().
 */
export async function runStockNewsCheck(): Promise<void> {
  const cfg = getConfig();
  const open = await openBets(cfg.mode);
  if (open.length === 0) return;
  const { checkNewsForPositions } = await import("./news-monitor");
  await checkNewsForPositions(open.map((b) => b.ticker));
}

/** True when the row was persisted without a confirmed broker fill. */
function isProvisionalBet(bet: OpenBetRow): boolean {
  return (bet.signals as any)?.entryContext?.provisionalFill === true;
}

/**
 * Reconcile a provisional row against broker truth.
 * Returns the (possibly rewritten) bet when management may proceed, `null`
 * when the entry never filled and the row was closed, or `"pending"` when the
 * order state is STILL unknown — the caller must skip all exit logic for this
 * bet this cycle (a broker 404 proves nothing while the entry order may still
 * be working and could fill later in the session).
 */
async function reconcileProvisionalBet(
  bet: OpenBetRow,
  mode: "paper" | "live",
): Promise<OpenBetRow | null | "pending"> {
  if (!bet.alpacaOrderId) return "pending"; // no order id — cannot ever confirm; never auto-flat
  const outcome = await confirmOrderFill({
    getStatus: () => getOrder(mode, bet.alpacaOrderId!),
    cancel: () => cancelOrder(mode, bet.alpacaOrderId!),
    pollAttempts: 1,
    pollDelayMs: 200,
  }).catch(() => ({ outcome: "unknown" as const }));
  const plan = planProvisionalReconciliation(outcome);
  if (plan.action === "keep_provisional") return "pending";
  if (plan.action === "close_never_filled") {
    await db.execute(sql`
      UPDATE stock_bot_bets SET
        exit_price = entry_price, pnl = 0, outcome = 'push',
        exit_reason = 'entry_never_filled', exited_at = NOW(), evaluated_at = NOW()
      WHERE id = ${bet.id}
    `);
    unregisterPositionTicker(bet.ticker);
    logger.info({ ticker: bet.ticker, betId: bet.id }, "[stock-bot] provisional entry never filled — row closed");
    return null;
  }
  // adopt_fill: rewrite the row from broker truth (handles late fills after
  // an outage, and partial fills) and clear the provisional flag.
  const ec = (bet.signals as any)?.entryContext ?? {};
  const stopPct = Number(ec.stopPct) || 0;
  const targetPct = Number(ec.targetPct) || 0;
  const { stopLoss, targetPrice } = stopPct > 0 && targetPct > 0
    ? computeExitLevels(plan.filledAvgPrice, stopPct, targetPct, bet.side)
    : { stopLoss: bet.stopLoss ?? 0, targetPrice: bet.targetPrice ?? 0 };
  await db.execute(sql`
    UPDATE stock_bot_bets SET
      qty = ${plan.filledQty},
      entry_price = ${plan.filledAvgPrice},
      peak_price = ${plan.filledAvgPrice},
      notional = ${plan.filledQty * plan.filledAvgPrice},
      stop_loss = ${stopLoss || null},
      target_price = ${targetPrice || null},
      signals = jsonb_set(signals, '{entryContext,provisionalFill}', 'false'::jsonb)
    WHERE id = ${bet.id}
  `);
  logger.info(
    { ticker: bet.ticker, betId: bet.id, qty: plan.filledQty, fill: plan.filledAvgPrice },
    "[stock-bot] provisional entry reconciled to confirmed fill",
  );
  return {
    ...bet,
    qty: plan.filledQty,
    entryPrice: plan.filledAvgPrice,
    peakPrice: plan.filledAvgPrice,
    notional: plan.filledQty * plan.filledAvgPrice,
    stopLoss: stopLoss || bet.stopLoss,
    targetPrice: targetPrice || bet.targetPrice,
    signals: { ...(bet.signals as any), entryContext: { ...ec, provisionalFill: false } },
  };
}

/** Persist the running peak price used by the long-horizon trailing stop. */
async function updatePeak(betId: string, peak: number): Promise<void> {
  await db.execute(sql`
    UPDATE stock_bot_bets SET peak_price = ${peak} WHERE id = ${betId}
  `).catch((err) => logger.warn({ err, betId }, "[stock-bot] peak update failed"));
}

async function managePositions(
  cfg: StockBotConfig,
  marketOpen: boolean,
  nextCloseMs: number | null,
): Promise<number> {
  let exits = 0;
  const open = await openBets(cfg.mode);
  const nearClose =
    marketOpen && nextCloseMs != null && nextCloseMs - Date.now() <= DAY_EOD_BUFFER_MS;

  for (let bet of open) {
    // Provisional rows (unconfirmed broker fill state) must be reconciled
    // against broker truth before ANY exit logic may run on them.
    if (isProvisionalBet(bet)) {
      const reconciled = await reconcileProvisionalBet(bet, cfg.mode);
      if (reconciled === "pending") continue; // still unknown — never exit/flat this cycle
      if (reconciled == null) continue;       // entry never filled — row closed
      bet = reconciled;
    }

    const price = await getLatestPrice(bet.ticker);
    if (price == null || price <= 0) continue;

    // Check for breaking news alert on this position
    const newsAlert = consumeNewsAlert(bet.ticker);

    // Research for exit gate: cached report OR a fresh Claude exit re-check
    // triggered by: (a) breaking news alert, or (b) swing/long held overnight.
    // With AI disabled the bot ignores research entirely — exits are purely
    // rule-based (ATR stops/targets/trailing/max-hold).
    let research = aiActive(cfg) && bet.tradingMode !== "day"
      ? getCachedResearch(bet.ticker) ?? null
      : null;

    if (marketOpen && aiActive(cfg) && bet.tradingMode !== "day" && (newsAlert || bet.tradingMode === "swing" || bet.tradingMode === "long")) {
      const daysHeld = Math.floor((Date.now() - bet.createdAt.getTime()) / 86_400_000);
      const gainPct = bet.entryPrice > 0
        ? (bet.side === "short"
            ? (bet.entryPrice - price) / bet.entryPrice
            : (price - bet.entryPrice) / bet.entryPrice) * 100
        : 0;
      const uni = lookupUniverse(bet.ticker);
      const exitCheck = await researchPositionExit(bet.ticker, {
        price,
        entryPrice: bet.entryPrice,
        gainPct,
        sector: bet.sector ?? uni?.sector ?? "Other",
        companyName: uni?.name ?? bet.ticker,
        tradingMode: bet.tradingMode,
        daysHeld,
        originalSummary: (bet.signals as any)?.research?.summary,
        newsAlert: newsAlert?.headline,
      }).catch(() => null);

      if (exitCheck?.shouldExit) {
        const exitReason = newsAlert
          ? `claude_exit_news (${newsAlert.headline.slice(0, 80)})`
          : `claude_exit_recheck (conf ${exitCheck.confidence})`;
        if (marketOpen) {
          try {
            await exitPosition(bet, cfg.mode, price, exitReason);
            exits++;
            continue;
          } catch (err) {
            logger.warn({ err, ticker: bet.ticker }, "[stock-bot] Claude-triggered exit failed; will retry");
          }
        }
        continue;
      }
      // Update the research confidence from Claude's re-check for the rule-based exit below
      if (exitCheck && research) {
        research = { ...research, confidence: exitCheck.confidence };
      }
    }

    const { reason, newPeak } = evaluateExitReason({
      bet,
      price,
      cfg,
      marketOpen,
      nearClose,
      nowMs: Date.now(),
      research,
    });

    if (newPeak != null) await updatePeak(bet.id, newPeak);

    if (reason) {
      // Exits require an open market (except forced EOD which we still attempt).
      if (!marketOpen && reason !== "eod_close") continue;
      try {
        await exitPosition(bet, cfg.mode, price, reason);
        exits++;
      } catch (err) {
        // Broker close failed — position stays open and is retried next cycle.
        logger.warn({ err, ticker: bet.ticker }, "[stock-bot] exit failed; will retry");
      }
    }
  }
  return exits;
}

// ── Entry candidates: research reports first, then scanner/watchlist ────────

interface EntryCandidate {
  ticker: string;
  /** Horizon dictated by research; null = flexible (watchlist/scanner). */
  horizon: TradingMode | null;
  report: ResearchReport | null;
  /** "long" (default) = buy to open; "short" = sell to open. */
  side?: "long" | "short";
}

async function entryCandidates(cfg: StockBotConfig, aiOn: boolean): Promise<{
  candidates: EntryCandidate[];
  scannerByTicker: Map<string, ScannerRow>;
}> {
  const [scanner, watch] = await Promise.all([getScannerResults(), watchlistTickers()]);
  const scannerByTicker = new Map(scanner.map((r) => [r.ticker, r]));

  const seen = new Set<string>();
  const candidates: EntryCandidate[] = [];

  // 1. Today's research reports, highest confidence first (AI mode only —
  //    with AI off the pipeline is scanner/watchlist-driven end to end).
  if (aiOn) {
    for (const rep of getTodayReports()) {
      if (seen.has(rep.ticker)) continue;
      seen.add(rep.ticker);
      candidates.push({ ticker: rep.ticker, horizon: rep.horizon, report: rep });
    }
  }

  // 2. Watchlist tickers (flexible horizon), always eligible.
  for (const t of watch) {
    if (seen.has(t)) continue;
    seen.add(t);
    candidates.push({ ticker: t, horizon: null, report: aiOn ? getCachedResearch(t) ?? null : null });
  }

  // 3. Top scanner rows (upward direction) as a fallback long pool.
  const ranked = scanner
    .filter((r) => r.direction === "up")
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  for (const r of ranked) {
    if (seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    candidates.push({ ticker: r.ticker, horizon: null, report: null, side: "long" });
  }

  // 4. Top downward-trending tickers as short candidates.
  //    AI on:  requires Claude stance "avoid" (confirmed bearish thesis).
  //    AI off: requires a strong bearish technical stack — down direction,
  //            volume-confirmed selling (surge ≥ 1.2× and negative volume
  //            bias) and RSI below 45. All fields must be present (fail-closed).
  const shortCandidates = scanner
    .filter((r) => r.direction === "down")
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  for (const r of shortCandidates) {
    const shortKey = `short:${r.ticker}`;
    if (seen.has(shortKey)) continue;
    if (aiOn) {
      const report = getCachedResearch(r.ticker) ?? null;
      // Only short when Claude explicitly says avoid (confirmed bearish thesis)
      if (!report || report.stance !== "avoid") continue;
      seen.add(shortKey);
      candidates.push({ ticker: r.ticker, horizon: "swing", report, side: "short" });
    } else {
      const d = (r.details ?? {}) as Record<string, any>;
      const rsi = typeof d.rsi === "number" ? d.rsi : null;
      const volumeSurge = typeof d.volumeSurge === "number" ? d.volumeSurge : null;
      const volumeBias = typeof d.volumeBias === "number" ? d.volumeBias : null;
      if (rsi == null || volumeSurge == null || volumeBias == null) continue; // fail-closed
      if (rsi >= 45 || volumeSurge < 1.2 || volumeBias >= -0.15) continue;
      seen.add(shortKey);
      candidates.push({ ticker: r.ticker, horizon: "swing", report: null, side: "short" });
    }
  }

  return { candidates, scannerByTicker };
}

/** Is it currently within the first hour of the regular session (ET)? */
function inFirstHourET(now = new Date()): boolean {
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(et.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(et.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 10 * 60 + 30;
}

/**
 * Horizon-specific entry criteria.
 * AI ON:  swing/long lean on Claude research confidence (additive layer).
 * AI OFF: swing/long substitute a complete data-backed technical stack —
 *         no gate ever silently depends on Claude. All gates fail closed
 *         when a required datum is missing.
 * Returns null when eligible, else the skip reason.
 */
function horizonGate(
  horizon: TradingMode,
  report: ResearchReport | null,
  row: ScannerRow | undefined,
  aiOn: boolean,
): string | null {
  const d = (row?.details ?? {}) as Record<string, any>;
  const rsi = typeof d.rsi === "number" ? d.rsi : null;
  const volumeSurge = typeof d.volumeSurge === "number" ? d.volumeSurge : null;
  const maAlignment = d.maAlignment === true;
  const macdHistogram = typeof d.macdHistogram === "number" ? d.macdHistogram : null;
  const efficiency = typeof d.efficiencyRatio === "number" ? d.efficiencyRatio : null;

  if (horizon === "day") {
    if (!inFirstHourET()) return "day entries only in first hour";
    if (rsi == null || rsi < 55 || rsi > 75) return `RSI ${rsi ?? "n/a"} outside 55-75 momentum band`;
    if (volumeSurge == null) return "volume surge unavailable";
    if (volumeSurge < 1.2) return `volume surge ${volumeSurge.toFixed(1)}× too weak`;
    return null;
  }
  if (horizon === "swing") {
    if (!maAlignment) return "MA alignment not bullish";
    if (aiOn) {
      if (!report) return "no research report";
      if (report.confidence < 60) return `research conf ${report.confidence} < 60`;
      return null;
    }
    // AI off: MACD momentum + volume confirmation replace research.
    if (macdHistogram == null) return "MACD unavailable (fail-closed)";
    if (macdHistogram <= 0) return `MACD histogram ${macdHistogram.toFixed(3)} not bullish`;
    if (volumeSurge == null) return "volume surge unavailable (fail-closed)";
    if (volumeSurge < 1.1) return `volume surge ${volumeSurge.toFixed(1)}× too weak for swing`;
    return null;
  }
  // long
  if (aiOn) {
    if (!report || report.confidence < LONG_ENTRY_MIN_CONF) {
      return `research conf ${report?.confidence ?? "none"} < ${LONG_ENTRY_MIN_CONF}`;
    }
    if (rsi != null && rsi >= 60) return `RSI ${rsi} overheated for accumulation`;
    return null;
  }
  // AI off: long accumulation needs trend structure + clean trend + not overheated.
  if (!maAlignment) return "MA alignment not bullish (fail-closed long gate)";
  if (efficiency == null) return "efficiency ratio unavailable (fail-closed)";
  if (efficiency < 0.25) return `efficiency ratio ${efficiency.toFixed(2)} too choppy for long`;
  if (rsi == null) return "RSI unavailable (fail-closed)";
  if (rsi >= 60) return `RSI ${rsi} overheated for accumulation`;
  return null;
}

async function tryEntries(cfg: StockBotConfig): Promise<number> {
  let entries = 0;
  const aiOn = aiActive(cfg);
  const account = await getAccount(cfg.mode);

  // PDT guard: if flagged and low equity, block new day trades.
  const pdtBlocked = account.patternDayTrader && account.equity < 25000;

  // ── Macro market filter ─────────────────────────────────────────────────
  // Block new LONG entries when SPY is in a confirmed intraday downtrend.
  // Short entries are unaffected (shorts profit in a down market).
  const macro = await getMacroTrend().catch(() => null);
  const macroBlocksLongs = macro?.trend === "bearish";
  if (macroBlocksLongs) {
    logger.info(
      { spy: macro?.spyPrice, changePct: macro?.spyChangePct, aboveVwap: macro?.aboveVwap },
      "[stock-bot] macro bearish — blocking new long entries this cycle",
    );
  }

  const open = await openBets(cfg.mode);
  // Held guard is per (ticker, horizon): the same ticker may hold concurrent
  // day/swing/long positions, but never two positions in the same horizon.
  const held = new Set(open.map((b) => heldKey(b.ticker, b.tradingMode)));
  const modeCounts: Record<TradingMode, number> = { day: 0, swing: 0, long: 0 };
  for (const b of open) modeCounts[b.tradingMode] = (modeCounts[b.tradingMode] ?? 0) + 1;
  const capFor = (m: TradingMode) =>
    m === "day" ? cfg.maxDayPositions : m === "swing" ? cfg.maxSwingPositions : cfg.maxLongPositions;

  if (open.length >= cfg.maxConcurrentPositions) return 0;

  // Track sector exposures added in this cycle so that intra-cycle multi-entry
  // concentration is accounted for (open was captured before the loop).
  const cycleSectorNotional = new Map<string, number>();
  let cycleTotalNotional = 0;

  const { candidates: allCandidates, scannerByTicker } = await entryCandidates(cfg, aiOn);

  // Sector focus filter: if sectorFocus is non-empty, only consider tickers in
  // those sectors. Watchlist tickers are always eligible regardless of sector.
  const watchSet = new Set(await watchlistTickers());
  const activeSectors = cfg.sectorFocus ?? [];
  const candidates =
    activeSectors.length === 0
      ? allCandidates
      : allCandidates.filter((c) => {
          if (watchSet.has(c.ticker)) return true; // watchlist bypass
          const sector =
            c.report?.sector ?? scannerByTicker.get(c.ticker)?.sector ?? lookupUniverse(c.ticker)?.sector ?? "";
          return activeSectors.includes(sector);
        });

  for (const cand of candidates) {
    if (open.length + entries >= cfg.maxConcurrentPositions) break;
    const ticker = cand.ticker;

    const candidateSide: "long" | "short" = cand.side ?? "long";

    // Macro filter: block new long entries when SPY trend is bearish.
    // Short entries are allowed — shorts benefit from a down market.
    if (candidateSide === "long" && macroBlocksLongs) {
      recordDecision({
        ticker, action: "SKIP", horizon: cand.horizon,
        confidence: cand.report?.confidence ?? null,
        reason: `macro bearish (SPY ${macro?.spyChangePct?.toFixed(2)}%) — long entries blocked`,
      });
      continue;
    }

    // Claude stance gate (AI mode only — with AI off, stance never gates):
    //   Long entries: never enter when Claude says "avoid".
    //   Short entries: only enter when Claude says "avoid" (confirmed bearish thesis).
    if (aiOn) {
      if (candidateSide === "long" && cand.report?.stance === "avoid") {
        recordDecision({
          ticker, action: "SKIP", horizon: cand.horizon,
          confidence: cand.report.confidence,
          reason: "Claude research stance: avoid (stay away/sell)",
        });
        continue;
      }
      if (candidateSide === "short" && (!cand.report || cand.report.stance !== "avoid")) {
        // Shorts require explicit Claude bearish confirmation
        recordDecision({
          ticker, action: "SKIP", horizon: cand.horizon,
          confidence: cand.report?.confidence ?? null,
          reason: "short candidate skipped — Claude stance not 'avoid'",
        });
        continue;
      }
    }

    // Resolve which horizon this entry would use. Research-driven candidates
    // use their recommended horizon; flexible candidates take the first active
    // mode with capacity (day → swing → long preference). A horizon already
    // held for this ticker is skipped, but other horizons remain eligible.
    const { mode, allHeld } = selectEntryMode({
      ticker,
      horizon: cand.horizon,
      held,
      modeCounts,
      caps: { day: cfg.maxDayPositions, swing: cfg.maxSwingPositions, long: cfg.maxLongPositions },
      activeModes: cfg.tradingModes,
      pdtBlocked,
    });
    if (!mode) {
      if (cand.report && !allHeld) {
        recordDecision({
          ticker, action: "SKIP", horizon: cand.horizon,
          confidence: cand.report.confidence,
          reason: cand.horizon ? `${cand.horizon} capacity full or mode inactive` : "no horizon capacity",
        });
      }
      continue;
    }

    const row = scannerByTicker.get(ticker);
    const gateFail = horizonGate(mode, cand.report, row, aiOn);
    if (gateFail) {
      recordDecision({
        ticker, action: "SKIP", horizon: mode,
        confidence: cand.report?.confidence ?? row?.confidence ?? null, reason: gateFail,
      });
      continue;
    }

    try {
      const candles: Candle[] = await getCandles(ticker, mode);
      if (candles.length < 25) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: null,
          reason: `insufficient candle history (${candles.length} < 25) — fail-closed`,
        });
        continue;
      }

      const uni = lookupUniverse(ticker);
      const sector = cand.report?.sector ?? row?.sector ?? uni?.sector ?? "Other";
      const news = await getScoredNews(ticker);
      const earnings = await getEarnings(ticker, cfg.earningsBlackoutHours);

      if (cfg.earningsBlackout && earnings?.soon) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode,
          confidence: cand.report?.confidence ?? null, reason: "earnings blackout",
        });
        continue;
      }

      // NOTE: useClaude is INTENTIONALLY hardwired false here — the bot's
      // per-tick signals are stat+ML only. All Claude usage in the bot flows
      // through the research layer, gated by the single aiActive(cfg)
      // predicate (config toggle AND spend guard). Do not flip this to true
      // without routing it through aiActive as well, or AI-off mode would
      // silently spend on Claude signal calls.
      const signals = await buildSignals(
        ticker,
        candles,
        news,
        earnings,
        getSectorMomentum(sector),
        { useClaude: false },
      );

      // Direction gate: longs require bullish technicals; shorts require bearish.
      const requiredDir = candidateSide === "short" ? "down" : "up";
      if (signals.combinedDirection !== requiredDir) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode,
          confidence: cand.report?.confidence ?? signals.combinedConfidence,
          reason: candidateSide === "short"
            ? "technical signals not bearish (short requires 'down')"
            : "technical signals not bullish",
        });
        continue;
      }

      // Research signal: ±5pp confidence based on today's Claude research
      // (additive AI layer — ignored entirely when AI is off).
      let effectiveConfidence = signals.combinedConfidence;
      const research = aiOn ? cand.report ?? getCachedResearch(ticker) : null;
      if (research) {
        if (research.confidence >= 70) {
          effectiveConfidence = Math.min(95, effectiveConfidence + 5);
        } else if (research.confidence <= 30) {
          effectiveConfidence = Math.max(50, effectiveConfidence - 5);
        }
      }

      if (effectiveConfidence < cfg.minConfidence) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode,
          confidence: effectiveConfidence,
          reason: `confidence ${effectiveConfidence} < min ${cfg.minConfidence}`,
        });
        continue;
      }

      const price = signals.price;
      if (price <= 0) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: "no valid live price — fail-closed",
        });
        continue;
      }

      // Minimum market cap filter.
      // The S&P 500 stocks in STOCK_UNIVERSE are all large-caps (>$15B market cap)
      // and always pass this filter. For user-added watchlist tickers, market cap
      // data is unavailable from Alpaca's standard API, so when the filter is
      // enabled we fail-closed — blocking unknown-cap tickers rather than letting
      // potential micro-caps through.
      if (cfg.minMarketCapBillion > 0) {
        const inUniverse = lookupUniverse(ticker) !== null;
        if (!inUniverse) {
          recordDecision({
            ticker, action: "SKIP", horizon: mode, confidence: null,
            reason: `market cap unverifiable for non-universe ticker (filter: >$${cfg.minMarketCapBillion}B)`,
          });
          continue;
        }
        // Universe stocks are S&P 500 large-caps (>$15B) and always satisfy any
        // supported threshold (1B / 5B / 10B). No additional check needed.
      }

      // Level 1 entry timing gate (fail-closed): tight spread + buy-side
      // dominant book are both required — missing quote data blocks entry.
      const quote = await getLevel1Quote(ticker);
      if (!quote || quote.spreadPct == null || quote.imbalance == null) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: "Level 1 quote unavailable — entry timing cannot be verified",
        });
        continue;
      }
      if (quote.spreadPct > MAX_ENTRY_SPREAD_PCT) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: `spread ${quote.spreadPct.toFixed(2)}% > ${MAX_ENTRY_SPREAD_PCT}%`,
        });
        continue;
      }
      if (quote.imbalance < MIN_ENTRY_IMBALANCE) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: `book imbalance ${quote.imbalance.toFixed(2)} < ${MIN_ENTRY_IMBALANCE} (sell-side dominant)`,
        });
        continue;
      }

      // Level 2 orderbook gate (soft — skip on bad depth, don't fail-close on missing data).
      // Longs: skip when sell-side depth dominates (depthImbalance < 0.8 means big ask wall).
      // Shorts: skip when buy-side depth dominates (depthImbalance > 1.2 means strong buyer support).
      const MIN_DEPTH_IMBALANCE_LONG = 0.8;
      const MAX_DEPTH_IMBALANCE_SHORT = 1.2;
      try {
        const ob = await getOrderBook(ticker);
        if (ob) {
          if (ob.depthImbalance != null && candidateSide === "long" && ob.depthImbalance < MIN_DEPTH_IMBALANCE_LONG) {
            recordDecision({
              ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
              reason: `L2 depth imbalance ${ob.depthImbalance.toFixed(2)} < ${MIN_DEPTH_IMBALANCE_LONG} (ask wall — bad long)`,
            });
            continue;
          }
          if (ob.depthImbalance != null && candidateSide === "short" && ob.depthImbalance > MAX_DEPTH_IMBALANCE_SHORT) {
            recordDecision({
              ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
              reason: `L2 depth imbalance ${ob.depthImbalance.toFixed(2)} > ${MAX_DEPTH_IMBALANCE_SHORT} (buyer support — bad short)`,
            });
            continue;
          }
        }
      } catch {
        // Orderbook unavailable — proceed without L2 gate (soft fail-open)
      }

      // Expected fill = the touch we intend to cross (ask for longs, bid for
      // shorts). Actual fill vs this expectation = slippage analytics.
      const expectedFillPrice = candidateSide === "short" ? (quote.bid ?? price) : (quote.ask ?? price);

      // Limit orders: for longs we bid 1 cent above ask (crosses the spread to
      // fill quickly while protecting against stale quotes); for shorts we
      // offer 1 cent below bid. This is the WORST executable entry price.
      const limitPrice = candidateSide === "short"
        ? parseFloat(((quote.bid ?? price) - 0.01).toFixed(2))
        : parseFloat(((quote.ask ?? price) + 0.01).toFixed(2));

      // ── Risk engine (pure, unit-tested in bot-entry-core) ─────────────
      // ATR-adaptive stops/targets scaled per horizon, plus confidence- and
      // risk-based sizing (stop-out loses at most riskPerTradePct of equity).
      // Sized from the WORST-CASE executable price (the submitted limit), so
      // the risk cap holds even if the order fills at the limit.
      const atr = signals.stat?.atrPct;
      const { stopPct, targetPct, useAtr, notional, qty } = computeRiskControls({
        mode, cfg,
        atrPct: typeof atr === "number" ? atr : null,
        effectiveConfidence,
        equity: account.equity,
        price: limitPrice,
        side: candidateSide,
      });
      if (qty < 1) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: `position size rounds to 0 shares (notional $${notional.toFixed(0)} @ $${limitPrice.toFixed(2)})`,
        });
        continue;
      }

      // Sector concentration cap.
      // We use the combined deployed capital (pre-existing open bets + entries
      // already made this cycle) as the effective portfolio basis. When that basis
      // is zero (empty portfolio, first entry of the cycle), we skip the check —
      // a single first position cannot be "over-concentrated" relative to an empty
      // book, and the cap is only meaningful once there is a portfolio to diversify.
      if (cfg.maxSectorPct > 0 && sector) {
        const proposedNotional = qty * price;
        const existingTotal = open.reduce((s, b) => s + b.notional, 0);
        const effectiveTotal = existingTotal + cycleTotalNotional;
        if (effectiveTotal > 0) {
          const existingSector = open.filter(b => b.sector === sector).reduce((s, b) => s + b.notional, 0);
          const cycleSector = cycleSectorNotional.get(sector) ?? 0;
          const projectedTotal = effectiveTotal + proposedNotional;
          const projectedSectorPct = ((existingSector + cycleSector + proposedNotional) / projectedTotal) * 100;
          if (projectedSectorPct > cfg.maxSectorPct) {
            recordDecision({
              ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
              reason: `sector ${sector} would reach ${projectedSectorPct.toFixed(0)}% > cap ${cfg.maxSectorPct}%`,
            });
            continue;
          }
        }
      }

      const features = buildFeatures(candles, news, earnings, getSectorMomentum(sector));

      // ── Place order and confirm the fill before persisting. ──────────
      // Durable reconciliation (see order-confirm.ts): every status/cancel
      // call is retried; if the broker's terminal state STILL cannot be
      // confirmed, we persist a PROVISIONAL tracked row at the limit price —
      // never abandon an order that may have filled. Day time-in-force keeps
      // any cancel race bounded to the session.
      let orderId: string | null = null;
      try {
        const order = await placeOrder(cfg.mode, {
          symbol: ticker,
          qty,
          side: candidateSide === "short" ? "sell" : "buy",
          type: "limit",
          limitPrice,
          timeInForce: "day",
        });
        orderId = order.id;
      } catch (err) {
        // Order never accepted — nothing to reconcile.
        logger.warn({ err, ticker }, "[stock-bot] order placement failed");
        continue;
      }

      let filledPrice: number;
      let filledQty: number;
      let provisionalFill = false;
      // Exception-safe: once the broker ACCEPTED the order, no failure may
      // abandon it untracked. Any unexpected error from confirmation is
      // treated as "unknown" → a provisional row is persisted and reconciled
      // by the management loop.
      const confirmation = await confirmOrderFill({
        getStatus: () => getOrder(cfg.mode, orderId!),
        cancel: () => cancelOrder(cfg.mode, orderId!),
      }).catch((err) => {
        logger.warn({ err, ticker, orderId }, "[stock-bot] fill confirmation threw — treating as unknown");
        return { outcome: "unknown" as const };
      });
      if (confirmation.outcome === "unfilled") {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: `limit order not filled at $${limitPrice.toFixed(2)} — cancelled`,
        });
        continue;
      } else if (confirmation.outcome === "unknown") {
        // Terminal state unconfirmed — assume worst case (fully filled at the
        // limit) and persist a tracked row so the management loop reconciles
        // it. Its exit path cancels the entry order before closing, and a
        // broker 404 (actually flat) closes the row safely.
        filledPrice = limitPrice;
        filledQty = qty;
        provisionalFill = true;
        logger.warn({ ticker, orderId }, "[stock-bot] fill state unconfirmed — persisting provisional position for reconciliation");
      } else {
        filledPrice = confirmation.filledAvgPrice;
        filledQty = confirmation.filledQty;
      }

      // Exit levels anchored to the CONFIRMED fill price.
      const { stopLoss, targetPrice } = computeExitLevels(filledPrice, stopPct, targetPct, candidateSide);

      const id = randomUUID();
      const dbAction = candidateSide === "short" ? "short_sell" : "buy";
      // ── Persistence is a CRITICAL path once the broker accepted the order.
      // Retry the insert; if it still fails, actively unwind the accepted
      // order (cancel + flatten any fill) rather than abandoning untracked
      // broker exposure. Errors here must never fall through to the generic
      // candidate handler.
      let persisted = false;
      for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
        try {
          await insertBetRow();
          persisted = true;
        } catch (err) {
          logger.warn({ err, ticker, attempt }, "[stock-bot] bet insert failed");
          if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (!persisted) {
        logger.error({ ticker, orderId }, "[stock-bot] CRITICAL: bet insert failed after retries — unwinding accepted order");
        await cancelOrder(cfg.mode, orderId).catch(() => {});
        if (!provisionalFill || filledQty > 0) {
          // Best-effort flatten of any real fill; 404 (never filled) is fine.
          await closePosition(cfg.mode, ticker).catch((err) =>
            logger.error({ err, ticker }, "[stock-bot] CRITICAL: unwind closePosition failed — manual reconciliation required"),
          );
        }
        continue;
      }

      async function insertBetRow(): Promise<void> {
        await db.execute(sql`
        INSERT INTO stock_bot_bets
          (id, ticker, sector, action, trading_mode, mode, side, qty, signals, confidence,
           entry_price, stop_loss, target_price, peak_price, notional, alpaca_order_id, created_at)
        VALUES
          (${id}, ${ticker}, ${sector}, ${dbAction}, ${mode}, ${cfg.mode}, ${candidateSide}, ${filledQty},
           ${JSON.stringify({
             features,
             combinedDirection: signals.combinedDirection,
             combinedConfidence: signals.combinedConfidence,
             effectiveConfidence,
             research: research
               ? { confidence: research.confidence, horizon: research.horizon, summary: research.summary }
               : null,
             quote: quote
               ? { bid: quote.bid, ask: quote.ask, spreadPct: quote.spreadPct, imbalance: quote.imbalance }
               : null,
             stat: signals.stat,
             claude: signals.claude,
             ml: signals.ml,
             // Trade-quality + context capture for later analysis
             entryContext: {
               atrPct: typeof atr === "number" ? atr : null,
               stopPct, targetPct, atrStopsUsed: useAtr,
               expectedFillPrice,
               slippagePct: expectedFillPrice > 0
                 ? Number((((filledPrice - expectedFillPrice) / expectedFillPrice) * 100 * (candidateSide === "short" ? -1 : 1)).toFixed(4))
                 : null,
               macroTrend: macro?.trend ?? null,
               spyChangePct: macro?.spyChangePct ?? null,
               efficiencyRatio: signals.stat?.efficiencyRatio ?? null,
               regime: (signals.stat?.efficiencyRatio ?? 0) >= 0.3 ? "trending" : "choppy",
               sectorMomentum: getSectorMomentum(sector),
               aiEnabled: aiOn,
               // True when the broker's terminal order state could not be
               // confirmed and this row was persisted at the limit price as a
               // worst-case assumption; slippage analytics must ignore it.
               provisionalFill,
             },
           })}::jsonb,
           ${effectiveConfidence}, ${filledPrice}, ${stopLoss}, ${targetPrice}, ${filledPrice},
           ${filledQty * filledPrice}, ${orderId}, NOW())
        `);
      }

      entries++;
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
      held.add(heldKey(ticker, mode));
      // Register for intraday news monitoring (swing/long positions)
      if (mode !== "day") registerPositionTicker(ticker);
      // Update cycle-level sector tracking so subsequent candidates in this
      // same cycle see an accurate concentration picture.
      const filledNotional = filledQty * filledPrice;
      cycleTotalNotional += filledNotional;
      if (sector) cycleSectorNotional.set(sector, (cycleSectorNotional.get(sector) ?? 0) + filledNotional);
      recordDecision({
        ticker, action: "ENTER", horizon: mode, confidence: effectiveConfidence,
        reason: candidateSide === "short"
          ? `SHORT ${research?.horizon ?? mode} conf ${research?.confidence ?? effectiveConfidence} @ $${filledPrice.toFixed(2)}`
          : research
            ? `research ${research.horizon} conf ${research.confidence} + technicals @ $${filledPrice.toFixed(2)}`
            : `technical signal @ $${filledPrice.toFixed(2)}`,
        claudeReasoning: research?.summary ?? null,
      });
      logger.info(
        {
          ticker,
          side: candidateSide,
          mode,
          qty,
          price: filledPrice.toFixed(2),
          limitPrice,
          conf: effectiveConfidence,
          baseConf: signals.combinedConfidence,
          research: research ? { confidence: research.confidence, horizon: research.horizon } : null,
        },
        "[stock-bot] opened position",
      );
    } catch (err) {
      logger.warn({ err, ticker }, "[stock-bot] entry evaluation failed");
    }
  }
  return entries;
}

/** One full bot cycle. Safe to call on an interval; self-guards re-entry. */
export async function runBotCycle(): Promise<{ ran: boolean; summary: string }> {
  if (running) return { ran: false, summary: "cycle already running" };
  if (!alpacaConfigured()) return { ran: false, summary: "alpaca not configured" };

  let cfg = getConfig();

  // Auto-start/stop: enable the bot when the market opens, disable when it closes.
  // This runs even when the bot is disabled, so it can auto-enable at open.
  if (cfg.autoStartStop) {
    try {
      const clock = await getClock(cfg.mode);
      if (clock.isOpen && !cfg.enabled) {
        cfg = await saveConfig({ enabled: true });
        logger.info("[stock-bot] auto-start: market opened");
      } else if (!clock.isOpen && cfg.enabled) {
        // Only auto-stop if we are genuinely post-market (market already closed
        // for the day). Do NOT stop during pre-market: if nextOpen is within
        // 2 hours we are just waiting for the open, so let the bot sit enabled.
        const msUntilOpen = clock.nextOpen
          ? new Date(clock.nextOpen).getTime() - Date.now()
          : Infinity;
        const PRE_MARKET_WINDOW_MS = 2 * 60 * 60_000; // 2 hours
        if (msUntilOpen > PRE_MARKET_WINDOW_MS) {
          cfg = await saveConfig({ enabled: false });
          logger.info("[stock-bot] auto-stop: market closed (post-market)");
        } else {
          logger.info({ msUntilOpen: Math.round(msUntilOpen / 60_000) + "min" },
            "[stock-bot] pre-market hold — market opens soon, staying enabled");
        }
      }
    } catch (err) {
      logger.warn({ err }, "[stock-bot] auto-start/stop clock check failed");
    }
  }

  if (!cfg.enabled) return { ran: false, summary: "bot disabled" };

  running = true;
  try {
    const clock = await getClock(cfg.mode);
    const marketOpen = clock.isOpen;
    const nextCloseMs = clock.nextClose ? new Date(clock.nextClose).getTime() : null;

    const exits = await managePositions(cfg, marketOpen, nextCloseMs);

    let entries = 0;
    let note = "";
    if (marketOpen) {
      const realized = await todayRealizedPnl(cfg.mode);
      if (realized <= -Math.abs(cfg.dailyLossLimit)) {
        note = `daily loss limit hit (${realized.toFixed(2)})`;
      } else {
        entries = await tryEntries(cfg);
      }
    } else {
      note = "market closed — managing positions only";
    }

    lastCycleAt = Date.now();
    lastCycleSummary = `exits=${exits} entries=${entries}${note ? ` (${note})` : ""}`;
    return { ran: true, summary: lastCycleSummary };
  } catch (err) {
    logger.error({ err }, "[stock-bot] cycle failed");
    return { ran: false, summary: "cycle error" };
  } finally {
    running = false;
  }
}

export function botStatus(): {
  lastCycleAt: number;
  lastCycleSummary: string;
  running: boolean;
  decisions: BotDecision[];
} {
  return { lastCycleAt, lastCycleSummary, running, decisions: getDecisionLog() };
}
