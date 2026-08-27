/**
 * Daily realized P&L has deliberately narrow ownership:
 *   - regular bot settlements from kalshi_bot_bets with source='bot'
 *   - canonical High-Value Scalper settlements from kalshi_scalp_orders
 *
 * Manual orders, legacy mirrored Scalper rows, Contrarian experiments, and
 * observational/shadow studies are excluded. The database resolves New York
 * midnight so DST transitions use the correct UTC offset.
 */
// $1 = mode, $2 = pnlResetAt ISO string or null (visual cutoff; GREATEST with day_start_at)
export const DAILY_TRADING_PNL_SQL = `
  WITH bounds AS (
    SELECT
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')
        AT TIME ZONE 'America/New_York' AS day_start_at,
      (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York') + INTERVAL '1 day')
        AT TIME ZONE 'America/New_York' AS next_reset_at,
      GREATEST(
        date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')
          AT TIME ZONE 'America/New_York',
        COALESCE($2::timestamptz, '-infinity'::timestamptz)
      ) AS effective_start_at
  ),
  regular AS (
    SELECT COALESCE(SUM(b.pnl), 0) AS pnl
    FROM kalshi_bot_bets b
    CROSS JOIN bounds
    WHERE b.mode = $1
      AND b.source = 'bot'
      AND b.archived_at IS NULL
      AND b.action IN ('exit', 'late_recovery_exit', 'expired')
      AND b.exited_at >= bounds.effective_start_at
      AND b.exited_at < bounds.next_reset_at
  ),
  scalper AS (
    SELECT COALESCE(SUM(o.pnl), 0) AS pnl
    FROM kalshi_scalp_orders o
    CROSS JOIN bounds
    WHERE o.mode = $1
      AND o.outcome IN ('win', 'loss')
      AND o.pnl IS NOT NULL
      AND o.settled_at >= bounds.effective_start_at
      AND o.settled_at < bounds.next_reset_at
  )
  SELECT
    bounds.day_start_at,
    bounds.next_reset_at,
    regular.pnl AS regular_pnl,
    scalper.pnl AS scalper_pnl
  FROM bounds, regular, scalper
`;

/**
 * Settlement-level rows used by the read-only what-if calculator. Keeping the
 * actual cost beside each realized P&L preserves the economics of differently
 * sized wins and losses instead of applying one multiplier to the daily total.
 */
export const DAILY_PNL_SIMULATION_ROWS_SQL = `
  WITH bounds AS (
    SELECT
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')
        AT TIME ZONE 'America/New_York' AS day_start_at,
      (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York') + INTERVAL '1 day')
        AT TIME ZONE 'America/New_York' AS next_reset_at
  ),
  rows AS (
    SELECT
      'regular'::text AS strategy,
      b.bet_amount AS actual_cost,
      b.contract_count,
      b.pnl,
      true AS resolved
    FROM kalshi_bot_bets b
    CROSS JOIN bounds
    WHERE b.mode = $1
      AND b.source = 'bot'
      AND b.archived_at IS NULL
      AND b.action IN ('exit', 'late_recovery_exit', 'expired')
      AND b.exited_at >= bounds.day_start_at
      AND b.exited_at < bounds.next_reset_at

    UNION ALL

    SELECT
      'scalper'::text AS strategy,
      o.budget_spent AS actual_cost,
      o.filled_count AS contract_count,
      o.pnl,
      o.outcome IN ('win', 'loss') AND o.settled_at IS NOT NULL AS resolved
    FROM kalshi_scalp_orders o
    CROSS JOIN bounds
    WHERE o.mode = $1
      AND (
        (o.settled_at >= bounds.day_start_at AND o.settled_at < bounds.next_reset_at)
        OR (
          o.settled_at IS NULL
          AND o.created_at >= bounds.day_start_at
          AND o.created_at < bounds.next_reset_at
        )
      )
  )
  SELECT
    bounds.day_start_at,
    bounds.next_reset_at,
    rows.strategy,
    rows.actual_cost,
    rows.contract_count,
    rows.pnl,
    rows.resolved
  FROM bounds
  LEFT JOIN rows ON true
  ORDER BY rows.strategy
`;