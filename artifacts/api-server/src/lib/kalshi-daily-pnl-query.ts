/**
 * Daily realized P&L has deliberately narrow ownership:
 *   - regular bot settlements from kalshi_bot_bets with source='bot'
 *   - canonical High-Value Scalper settlements from kalshi_scalp_orders
 *
 * Manual orders, legacy mirrored Scalper rows, Contrarian experiments, and
 * observational/shadow studies are excluded. The database resolves New York
 * midnight so DST transitions use the correct UTC offset.
 */
export const DAILY_TRADING_PNL_SQL = `
  WITH bounds AS (
    SELECT
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')
        AT TIME ZONE 'America/New_York' AS day_start_at,
      (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York') + INTERVAL '1 day')
        AT TIME ZONE 'America/New_York' AS next_reset_at
  ),
  regular AS (
    SELECT COALESCE(SUM(b.pnl), 0) AS pnl
    FROM kalshi_bot_bets b
    CROSS JOIN bounds
    WHERE b.mode = $1
      AND b.source = 'bot'
      AND b.archived_at IS NULL
      AND b.action IN ('exit', 'late_recovery_exit', 'expired')
      AND b.exited_at >= bounds.day_start_at
      AND b.exited_at < bounds.next_reset_at
  ),
  scalper AS (
    SELECT COALESCE(SUM(o.pnl), 0) AS pnl
    FROM kalshi_scalp_orders o
    CROSS JOIN bounds
    WHERE o.mode = $1
      AND o.outcome IN ('win', 'loss')
      AND o.pnl IS NOT NULL
      AND o.settled_at >= bounds.day_start_at
      AND o.settled_at < bounds.next_reset_at
  )
  SELECT
    bounds.day_start_at,
    bounds.next_reset_at,
    regular.pnl AS regular_pnl,
    scalper.pnl AS scalper_pnl
  FROM bounds, regular, scalper
`;