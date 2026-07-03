---
name: Paper/Live mode entry-mode safety
description: Why real-money bot actions must key off the position's captured entry mode, not the live global botMode
---

# Paper/Live mode entry-mode safety

Rule: Any per-position action with a real-money side effect (Kalshi sell orders,
real balance refresh) must key off the mode the position was OPENED in, not the
current global `botMode`. Positions carry `entryMode` for this; exits use
`pos.entryMode`.

**Why:** `closePosition()` used to check the live global `botMode` at exit time.
If the user switched the bot to paper while a live position was open, the real
sell order was skipped and the P&L was booked as a paper simulation — stranding
real money on the exchange. The user explicitly asked that switching back to
paper "stop the bot's real money betting" without abandoning live positions.

**How to apply:**
- `OpenPosition.entryMode` is set at entry and restored from the bet row's `mode`
  column on DB restore (`row.mode === "live" ? "live" : "paper"`).
- Snapshot the mode into a local `const entryMode = botMode;` BEFORE the first
  `await` in the entry path (order placement). A mode flip during the order fill
  would otherwise let a real live buy be recorded as paper and never sold.
- Persist that snapshot explicitly (pass `mode` into `persistBetRecord`) rather
  than letting the insert read the live global — same mid-fill race.
- Switching to paper is immediate (stops NEW real bets); already-open live
  positions still close with real sell orders via `entryMode`. Closing an open
  live position is capital protection, not new betting.
