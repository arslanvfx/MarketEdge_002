/**
 * Bot Entry Timing Analytics
 *
 * Captures the bot's composite model direction (stat+Claude+ML via ML Gate) at
 * each minute (0–14) within every 15-min window, then tags it with the final
 * resolved outcome so we can build per-minute accuracy vs return-ratio curves.
 *
 * Write path: bot tick loop → writeBotEntryTimingSnapshot() (once per coin per minute)
 * Resolution: evalClosedBets → tagBotEntryTimingOutcomes()
 * Recovery:   recoverBotEntryTimingSnapshots() (startup + periodic)
 * Query:      getBotEntryTimingAnalysis()
 */

import { db, botEntryTimingSnapshotsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotEntryTimingWriteParams {
  id: string;
  coin: string;
  windowKey: string;
  minuteMark: number;
  mode: string;
  statAbove: boolean | null;
  claudeAbove: boolean | null;
  mlAbove: boolean | null;
  compositeDirection: boolean | null;
  compositeConfidence: number | null;
  yesPrice: number | null;
}

export interface BotEntryTimingRow {
  coin: string | null;
  minuteMark: number;
  label: string;
  sampleCount: number;
  accuracy: number | null;
  avgYesPrice: number | null;
  avgTheoreticalReturn: number | null;
  pctAbove1_5x: number | null;
  ev: number | null;
}

// ---------------------------------------------------------------------------
// Write (called from bot tick, once per minute per coin)
// ---------------------------------------------------------------------------

export async function writeBotEntryTimingSnapshot(p: BotEntryTimingWriteParams): Promise<void> {
  await db
    .insert(botEntryTimingSnapshotsTable)
    .values({
      id: p.id,
      coin: p.coin,
      windowKey: p.windowKey,
      minuteMark: p.minuteMark,
      mode: p.mode,
      statAbove: p.statAbove ?? null,
      claudeAbove: p.claudeAbove ?? null,
      mlAbove: p.mlAbove ?? null,
      compositeDirection: p.compositeDirection ?? null,
      compositeConfidence: p.compositeConfidence ?? null,
      yesPrice: p.yesPrice ?? null,
      finalResult: null,
      compositeCorrect: null,
      evaluatedAt: null,
    })
    .onConflictDoNothing()
    .execute();
}

// ---------------------------------------------------------------------------
// Resolution (called from evalClosedBets after outcome is known)
// ---------------------------------------------------------------------------

export async function tagBotEntryTimingOutcomes(
  coin: string,
  windowKey: string,
  finalAbove: boolean,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE bot_entry_timing_snapshots
      SET  final_result      = ${finalAbove},
           composite_correct = (composite_direction = ${finalAbove}),
           evaluated_at      = NOW()
      WHERE coin       = ${coin}
        AND window_key = ${windowKey}
        AND final_result IS NULL
    `);
  } catch (err) {
    logger.warn({ err, coin, windowKey }, "[bot-entry-timing] tagBotEntryTimingOutcomes failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Recovery (runs at startup to back-fill any gaps from prediction_records)
// ---------------------------------------------------------------------------

export async function recoverBotEntryTimingSnapshots(): Promise<void> {
  try {
    const pending = await db.execute(sql`
      SELECT DISTINCT coin, window_key
      FROM   bot_entry_timing_snapshots
      WHERE  final_result IS NULL
        AND  window_key < TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')
    `);

    if (pending.rows.length === 0) return;

    let recovered = 0;

    for (const row of pending.rows as Array<Record<string, unknown>>) {
      const coin      = String(row.coin);
      const windowKey = String(row.window_key);

      // window_key is "YYYY-MM-DDTHH:mm" — the 15-min window close is +15min
      const windowClose = new Date(new Date(windowKey).getTime() + 15 * 60_000).toISOString();

      const priceRes = await db.execute(sql`
        SELECT actual_price
        FROM   prediction_records
        WHERE  symbol      = ${coin}
          AND  target_time = ${windowClose}::timestamptz
          AND  actual_price IS NOT NULL
        LIMIT 1
      `);

      if (priceRes.rows.length === 0) continue;

      const strikeRes = await db.execute(sql`
        SELECT kalshi_target
        FROM   prediction_records
        WHERE  symbol      = ${coin}
          AND  target_time = ${windowClose}::timestamptz
          AND  kalshi_target IS NOT NULL
        LIMIT 1
      `);

      if (strikeRes.rows.length === 0) continue;

      const actualPrice  = Number((priceRes.rows[0]  as Record<string, unknown>).actual_price);
      const kalshiTarget = Number((strikeRes.rows[0] as Record<string, unknown>).kalshi_target);
      if (!actualPrice || !kalshiTarget) continue;

      const finalAbove = actualPrice > kalshiTarget;

      await db.execute(sql`
        UPDATE bot_entry_timing_snapshots
        SET  final_result      = ${finalAbove},
             composite_correct = (composite_direction = ${finalAbove}),
             evaluated_at      = NOW()
        WHERE coin       = ${coin}
          AND window_key = ${windowKey}
          AND final_result IS NULL
      `);

      recovered++;
    }

    if (recovered > 0) {
      logger.info(
        { recovered },
        "[bot-entry-timing] back-filled %d unevaluated window(s) from prediction_records",
        recovered,
      );
    }
  } catch (err) {
    logger.warn({ err }, "[bot-entry-timing] recoverBotEntryTimingSnapshots failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Analytics query
// ---------------------------------------------------------------------------

export async function getBotEntryTimingAnalysis(
  coin?: string | null,
  days?: number | null,
  mode?: string | null,
): Promise<BotEntryTimingRow[]> {

  const coinFilter  = coin  ? sql`AND coin = ${coin}`  : sql``;
  const modeFilter  = mode  ? sql`AND mode = ${mode}`  : sql``;
  const daysFilter  = days != null
    ? sql`AND evaluated_at >= NOW() - (${days} || ' days')::interval`
    : sql``;

  const coinSelect = coin
    ? sql`${coin}::text AS coin`
    : sql`NULL::text AS coin`;

  const rows = await db.execute(sql`
    SELECT
      ${coinSelect},
      minute_mark,
      COUNT(*) FILTER (WHERE composite_direction IS NOT NULL)::int AS sample_count,
      COUNT(*) FILTER (WHERE composite_correct = true)::int        AS correct_count,
      AVG(yes_price)                                               AS avg_yes_price,
      AVG(
        CASE
          WHEN composite_direction = true  AND yes_price > 0.01 AND yes_price < 0.99
            THEN (1.0 - yes_price) / yes_price
          WHEN composite_direction = false AND yes_price > 0.01 AND yes_price < 0.99
            THEN yes_price / (1.0 - yes_price)
          ELSE NULL
        END
      ) AS avg_theoretical_return,
      COUNT(*) FILTER (WHERE
        (composite_direction = true  AND yes_price > 0.01 AND yes_price < 0.99 AND (1.0 - yes_price) / yes_price >= 1.5)
        OR (composite_direction = false AND yes_price > 0.01 AND yes_price < 0.99 AND yes_price / (1.0 - yes_price) >= 1.5)
      )::float
      / NULLIF(
          COUNT(*) FILTER (WHERE composite_direction IS NOT NULL AND yes_price IS NOT NULL AND yes_price > 0.01 AND yes_price < 0.99),
          0
        ) AS pct_above_1_5x
    FROM bot_entry_timing_snapshots
    WHERE final_result IS NOT NULL
      AND composite_direction IS NOT NULL
      ${coinFilter}
      ${modeFilter}
      ${daysFilter}
    GROUP BY minute_mark
    ORDER BY minute_mark
  `);

  return (rows.rows as Array<Record<string, unknown>>).map((row) => {
    const minuteMark   = Number(row.minute_mark);
    const sampleCount  = Number(row.sample_count);
    const correctCount = Number(row.correct_count);
    const accuracy     = sampleCount > 0 ? correctCount / sampleCount : null;
    const avgYesPrice  = row.avg_yes_price   != null ? Number(row.avg_yes_price)           : null;
    const avgRet       = row.avg_theoretical_return != null ? Number(row.avg_theoretical_return) : null;
    const pct15x       = row.pct_above_1_5x  != null ? Number(row.pct_above_1_5x)          : null;

    const ev = accuracy != null && avgYesPrice != null && avgYesPrice > 0
      ? accuracy * (1 / avgYesPrice) - (1 - accuracy)
      : null;

    return {
      coin:                 row.coin != null ? String(row.coin) : null,
      minuteMark,
      label:                `min ${minuteMark}`,
      sampleCount,
      accuracy,
      avgYesPrice,
      avgTheoreticalReturn: avgRet,
      pctAbove1_5x:         pct15x,
      ev,
    };
  });
}
