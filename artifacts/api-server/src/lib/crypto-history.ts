// ---------------------------------------------------------------------------
// crypto-history.ts — in-memory prediction history + DB persistence
// ---------------------------------------------------------------------------

import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, predictionRecordsTable } from "@workspace/db";
import { logger } from "./logger";

export interface PredictionRecord {
  id: string;
  symbol: string;
  snappedAt: string;
  targetTime: string;
  targetLabel: string;
  priceAtSnapshot: number;
  predictedPrice: number;
  predictedDirection: "up" | "down" | "flat";
  confidence: number;
  kalshiTarget: number | null;
  actualPrice: number | null;
  errorPct: number | null;
  correct: boolean | null;
  evaluatedAt: string | null;
  status: "pending" | "evaluated";
  source: "stat" | "claude" | "ensemble" | "ml";
  abstained: boolean | null;
  rawConfidence: number | null;
  archivedAt: string | null;
  liveDirectionAbove: boolean | null;
  efficiencyRatio?: number;
}

export function recordId(symbol: string, targetTime: string, source: PredictionRecord["source"]): string {
  return `${symbol}-${targetTime}-${source}`;
}

export const QUARTER_MS = 15 * 60 * 1000;
// Up to 3 records per window (stat + claude + ensemble), keep ~30 windows × 3.
export const MAX_HISTORY = 90;

// How many days of prediction records to retain in the DB.
export const RETENTION_DAYS = 60;

// These coins ALWAYS run Claude in the background tracker.
export const TRAINING_COINS = new Set(["BTC", "ETH", "XRP", "HYPE", "BNB", "SOL", "DOGE", "LINK"]);

// Fallback accuracy threshold used when no Kalshi target is available.
export const ACCURACY_THRESHOLD_PCT = 1.0;

// symbol → records
export const historyStore = new Map<string, PredictionRecord[]>();

// Prevents concurrent ticks from double-snapping the same window.
export const snapInFlight = new Set<string>(); // `${sym}:${targetISO}` or `${sym}:${targetISO}:mid`

// Tracks mid-window re-snap firings (once per window per symbol, never cleared).
export const midSnapFired = new Set<string>();

export function getPredictionHistory(symbol: string): PredictionRecord[] {
  return historyStore.get(symbol.toUpperCase()) ?? [];
}

export function getPredictionHeadlines(
  symbol: string,
): (PredictionRecord & { predictionIndex: number })[] {
  const recs = historyStore.get(symbol.toUpperCase()) ?? [];
  // Exclude soft-cleared records from the display feed.
  return recs
    .filter((r) => r.archivedAt == null)
    .map((r, i) => ({ ...r, predictionIndex: i }));
}

// Soft clear — archives records older than 48 h (matching the original global behaviour).
// When symbol is omitted the operation applies to all coins.
export async function clearPredictionHistoryOld(symbol?: string): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const now = new Date().toISOString();

  if (symbol) {
    const sym = symbol.toUpperCase();
    await db
      .update(predictionRecordsTable)
      .set({ archivedAt: now })
      .where(
        and(
          eq(predictionRecordsTable.symbol, sym),
          lt(predictionRecordsTable.snappedAt, cutoff),
        ),
      );
    for (const r of historyStore.get(sym) ?? []) {
      if (r.snappedAt < cutoffIso && r.archivedAt == null) r.archivedAt = now;
    }
  } else {
    await db
      .update(predictionRecordsTable)
      .set({ archivedAt: now })
      .where(lt(predictionRecordsTable.snappedAt, cutoff));
    for (const [, store] of historyStore) {
      for (const r of store) {
        if (r.snappedAt < cutoffIso && r.archivedAt == null) r.archivedAt = now;
      }
    }
  }
}

// Accuracy-only clear — archives ALL prediction records so accuracy stats restart
// from zero; ML snapshots and model weights are left untouched.
// When symbol is omitted the operation applies to all coins.
export async function clearAccuracyLogsOnly(symbol?: string): Promise<void> {
  const now = new Date().toISOString();

  if (symbol) {
    const sym = symbol.toUpperCase();
    await db
      .update(predictionRecordsTable)
      .set({ archivedAt: now })
      .where(eq(predictionRecordsTable.symbol, sym));
    for (const r of historyStore.get(sym) ?? []) r.archivedAt = now;
  } else {
    await db
      .update(predictionRecordsTable)
      .set({ archivedAt: now });
    for (const [, store] of historyStore) {
      for (const r of store) r.archivedAt = now;
    }
  }
}

// Full reset — archives all prediction records and clears the in-memory store.
// When symbol is omitted the operation applies to all coins.
export async function clearPredictionHistory(symbol?: string): Promise<void> {
  const now = new Date().toISOString();

  if (symbol) {
    const sym = symbol.toUpperCase();
    await db
      .update(predictionRecordsTable)
      .set({ archivedAt: now })
      .where(eq(predictionRecordsTable.symbol, sym));
    historyStore.set(sym, []);
  } else {
    await db
      .update(predictionRecordsTable)
      .set({ archivedAt: now });
    historyStore.clear();
  }
}

export function rowToRecord(row: Record<string, unknown>): PredictionRecord {
  return {
    id:                   String(row.id ?? ""),
    symbol:               String(row.symbol ?? ""),
    snappedAt:            String(row.snapped_at ?? row.snappedAt ?? ""),
    targetTime:           String(row.target_time ?? row.targetTime ?? ""),
    targetLabel:          String(row.target_label ?? row.targetLabel ?? ""),
    priceAtSnapshot:      Number(row.price_at_snapshot ?? row.priceAtSnapshot ?? 0),
    predictedPrice:       Number(row.predicted_price ?? row.predictedPrice ?? 0),
    predictedDirection:   (row.predicted_direction ?? row.predictedDirection ?? "flat") as PredictionRecord["predictedDirection"],
    confidence:           Number(row.confidence ?? 0),
    kalshiTarget:         row.kalshi_target != null ? Number(row.kalshi_target) : (row.kalshiTarget != null ? Number(row.kalshiTarget) : null),
    actualPrice:          row.actual_price != null ? Number(row.actual_price) : (row.actualPrice != null ? Number(row.actualPrice) : null),
    errorPct:             row.error_pct != null ? Number(row.error_pct) : (row.errorPct != null ? Number(row.errorPct) : null),
    correct:              row.correct != null ? Boolean(row.correct) : null,
    evaluatedAt:          row.evaluated_at != null ? String(row.evaluated_at) : (row.evaluatedAt != null ? String(row.evaluatedAt) : null),
    status:               (row.status ?? "pending") as PredictionRecord["status"],
    source:               (row.source ?? "stat") as PredictionRecord["source"],
    abstained:            row.abstained != null ? Boolean(row.abstained) : null,
    efficiencyRatio:      row.efficiency_ratio != null ? Number(row.efficiency_ratio) : (row.efficiencyRatio != null ? Number(row.efficiencyRatio) : null),
    rawConfidence:        row.raw_confidence != null ? Number(row.raw_confidence) : (row.rawConfidence != null ? Number(row.rawConfidence) : null),
    archivedAt:           row.archived_at != null ? String(row.archived_at) : (row.archivedAt != null ? String(row.archivedAt) : null),
    liveDirectionAbove:   row.live_direction_above != null ? Boolean(row.live_direction_above) : (row.liveDirectionAbove != null ? Boolean(row.liveDirectionAbove) : null),
  };
}

export async function initHistoryFromDB(): Promise<void> {
  try {
    const symbols = ["BTC", "ETH", "XRP", "HYPE", "BNB", "SOL", "DOGE", "LINK"];
    const rows = await db
      .select()
      .from(predictionRecordsTable)
      .where(inArray(predictionRecordsTable.symbol, symbols))
      .orderBy(desc(predictionRecordsTable.snappedAt))
      .limit(MAX_HISTORY * symbols.length);
    for (const row of rows) {
      const rec = rowToRecord(row as Record<string, unknown>);
      const existing = historyStore.get(rec.symbol) ?? [];
      existing.push(rec);
      historyStore.set(rec.symbol, existing);
    }
    for (const [sym, recs] of historyStore) {
      recs.sort((a, b) => a.snappedAt.localeCompare(b.snappedAt));
      historyStore.set(sym, recs.slice(-MAX_HISTORY));
    }
    logger.info("[history] loaded %d records from DB", rows.length);
  } catch (err) {
    logger.warn({ err }, "[history] initHistoryFromDB failed (non-fatal)");
  }
}

export async function pruneOldPredictionRecords(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await db
      .delete(predictionRecordsTable)
      .where(lt(predictionRecordsTable.snappedAt, cutoff));
    const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (deleted > 0) {
      logger.info("[history] pruned %d records older than %d days", deleted, RETENTION_DAYS);
    }
  } catch (err) {
    logger.warn({ err }, "[history] pruneOldPredictionRecords failed (non-fatal)");
  }
}

export async function dbInsertRecord(rec: PredictionRecord): Promise<void> {
  try {
    await db
      .insert(predictionRecordsTable)
      .values({
        id:                  rec.id,
        symbol:              rec.symbol,
        snappedAt:           new Date(rec.snappedAt),
        targetTime:          new Date(rec.targetTime),
        targetLabel:         rec.targetLabel,
        priceAtSnapshot:     String(rec.priceAtSnapshot),
        predictedPrice:      String(rec.predictedPrice),
        predictedDirection:  rec.predictedDirection,
        confidence:          rec.confidence,
        kalshiTarget:        rec.kalshiTarget != null ? String(rec.kalshiTarget) : null,
        actualPrice:         null,
        errorPct:            null,
        correct:             null,
        evaluatedAt:         null,
        status:              "pending",
        source:              rec.source,
        abstained:           rec.abstained ?? null,
        efficiencyRatio:     rec.efficiencyRatio != null ? String(rec.efficiencyRatio) : null,
        rawConfidence:       rec.rawConfidence ?? null,
        archivedAt:          null,
        liveDirectionAbove:  null,
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.warn({ err, id: rec.id }, "[history] dbInsertRecord failed (non-fatal)");
  }
}

export async function dbUpdateRecord(rec: PredictionRecord): Promise<void> {
  try {
    await db
      .update(predictionRecordsTable)
      .set({
        actualPrice:  rec.actualPrice != null ? String(rec.actualPrice) : null,
        errorPct:     rec.errorPct != null ? String(rec.errorPct) : null,
        correct:      rec.correct ?? null,
        evaluatedAt:  rec.evaluatedAt ? new Date(rec.evaluatedAt) : null,
        status:       rec.status,
      })
      .where(eq(predictionRecordsTable.id, rec.id));
  } catch (err) {
    logger.warn({ err, id: rec.id }, "[history] dbUpdateRecord failed (non-fatal)");
  }
}

export async function dbUpdateLiveDirection(symbol: string, targetTime: string, aboveKalshi: boolean): Promise<void> {
  try {
    await db
      .update(predictionRecordsTable)
      .set({ liveDirectionAbove: aboveKalshi })
      .where(
        and(
          eq(predictionRecordsTable.symbol, symbol.toUpperCase()),
          eq(predictionRecordsTable.targetTime, new Date(targetTime)),
          inArray(predictionRecordsTable.source, ["claude", "ensemble"]),
        ),
      );
    // Also update in-memory records.
    const recs = historyStore.get(symbol.toUpperCase()) ?? [];
    for (const r of recs) {
      if (
        r.targetTime === targetTime &&
        (r.source === "claude" || r.source === "ensemble")
      ) {
        r.liveDirectionAbove = aboveKalshi;
      }
    }
  } catch (err) {
    logger.warn({ err }, "[history] dbUpdateLiveDirection failed (non-fatal)");
  }
}

// Re-export for analytics module (needs to query predictionRecordsTable directly).
export { gt, desc, inArray, predictionRecordsTable, db };
