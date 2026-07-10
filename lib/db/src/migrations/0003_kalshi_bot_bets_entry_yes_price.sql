-- Migration: add entry_yes_price column to kalshi_bot_bets
-- Stores the Kalshi YES contract price (0–1) at the moment the bet decision was made.
-- Used for conviction mode threshold analysis — allows win-rate breakdown by price band.
-- Historical rows (placed before this migration) will be null and are excluded from
-- threshold analysis queries (not treated as 0 to avoid skewing recommendations).
ALTER TABLE kalshi_bot_bets
  ADD COLUMN IF NOT EXISTS entry_yes_price numeric(8,4);
