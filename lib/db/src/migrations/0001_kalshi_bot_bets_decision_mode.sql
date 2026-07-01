-- Migration: add decision_mode column to kalshi_bot_bets
-- Tracks which decision strategy was active when each bet was placed.
-- Historical rows (placed before this migration) will be null, treated as "classic".
ALTER TABLE kalshi_bot_bets
  ADD COLUMN IF NOT EXISTS decision_mode text;
