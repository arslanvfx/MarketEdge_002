---
name: Stock trading dashboard frontend
description: How the market-edge "Stocks" vertical is structured and the two backend-shape gotchas that shaped it
---

# Stock trading dashboard frontend (market-edge)

The Stocks vertical lives in `artifacts/market-edge/src/pages/stocks/` with a shared
client in `src/lib/stocks-api.ts` (types mirror `api-server/src/lib/stock/types.ts`,
plus `stockGet`/`stockAuth` fetch helpers and formatters). Routes are lazy-loaded in
`App.tsx` under `/stocks/*`; the sidebar "Stocks" group is in `components/layout.tsx`
(emerald accent, distinct from crypto's cyan admin group). Emerald is the stock accent.

## Backend-shape gotchas (not obvious from the UI code)
- **`/stocks/bot/pnl` is mode-filtered server-side (`WHERE mode = cfg.mode`), but
  `/stocks/bot/history` is NOT.** The Performance page mixes both (summary cards from
  pnl, charts from history). To keep them coherent, the page fetches `/bot/status` for
  the current mode and filters history-derived charts to `r.mode === mode`. If you add
  more history-derived analytics, apply the same mode filter or they'll disagree with
  the summary cards.
- **No manual-close endpoint and no performance-breakdown endpoint exist.** Performance
  analytics (cumulative P&L, win-rate by sector/mode, best/worst tickers) are ALL derived
  client-side from `/bot/history` rows. Signal-type breakdown isn't possible until the
  history endpoint exposes the entry signal (stored as jsonb but not selected).

## Conventions
- All queries poll at 10s (`refetchInterval: 10_000`) per the "poll 5–10s" requirement.
- Mutations (watchlist toggle, scan, bot config/cycle) surface failures via the existing
  `useToast` hook — never swallow silently, since auth/broker-not-connected are common.
- Unconfigured-Alpaca is a first-class state: `/meta` returns `configured:false`, and the
  shell shows a banner; every page renders empty states rather than erroring.
- Candlesticks in `stock-detail.tsx` are a hand-rolled SVG (Recharts has no candlestick);
  RSI/Bollinger and the Performance charts use Recharts.

**Profitability-first rule:** stock surfaces lead with dollar metrics (P&L, profit factor, expectancy, R); win rate is secondary only. Do not reintroduce win-rate-led cards or crypto-style win/loss outcome badges.
