-- Migration: add source column to kalshi_bot_bets
-- Tracks whether a bet was placed by the automated bot or manually via the dashboard.
-- Historical rows (placed before this migration) will be null, treated as "bot".
ALTER TABLE kalshi_bot_bets
  ADD COLUMN IF NOT EXISTS source text;
