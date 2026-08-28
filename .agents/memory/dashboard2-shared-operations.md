---
name: Dashboard 2 shared operations
description: Defines which mature execution modules Dashboard 2 reuses instead of owning.
---

Dashboard 2 owns the new regular-bet workflow, but it should surface the existing High-Value Scalper, regular Smart Exit/stop-loss, High-Value Scalper Fast Smart Exit, Smart Quiet Hours, and per-coin pause/max-bet controls directly.

**Why:** The user considers these modules perfected and explicitly wants the same canonical services and controls available from both dashboards. Cloning them would reinvent working logic and create competing execution paths or conflicting configuration.

**How to apply:** Reuse the existing frontend modules, APIs, configuration, lifecycle state, ledgers, reservations, and schedulers. Dashboard 2 may provide another control surface, but must not create Bot 2-specific copies. Its regular-entry runtime must enforce canonical Smart Hours and per-coin controls before sizing/reservation and again at final live placement.

Dashboard 2 regular-entry sizing treats the canonical bot `betSize` as a dollar cap alongside its own portfolio/contract ceilings. Smart Hours, data-gathering, and per-coin caps may lower it further, and the UI must show the effective limiting reason.

**Why:** A contract-count ceiling is not a stake target, and silently applying only downstream Smart Hours caps made small valid bets look like broken sizing.

**How to apply:** Keep price values in dollar-decimal form end to end (`0.79` means 79¢), calculate stake as contracts × entry cost, and expose both planned stake and the winning sizing cap.

Dashboard 2 operator sizing is dollar-native: expose “Dollars per bet,” derive the internal contract ceiling from that stake and the executable ask, and never ask the operator to configure contract count.

Dashboard 2 responsive hierarchy keeps Safety/Readiness near the top, stacks before squeezing at laptop/mobile widths, and keeps High-Value Scalping plus Smart Exit/Stop Loss collapsed by default.

**Why:** The operator explicitly found contract controls confusing and the previous scattered, compressed layout hard to use in ordinary windows and on mobile.

**How to apply:** Favor readable 12–14px content, comfortable spacing, mobile card views instead of compressed tables, and progressive disclosure for large secondary execution modules.

Dashboard 2 Live Targets must display the best current quote independently of entry-band eligibility and retain the last same-window ticker/quote during brief resnapshots.

**Why:** Filtering display data through the entry gate made values blink out whenever prices left the band or the authenticated book briefly reconnected, hiding useful real-time context.

**How to apply:** Keep safety fail-closed, visibly label retained data as refreshing/stale, and show a near-top live decision feed with current market reasons plus durable bet/fill events. Keep Active Positions above Live Targets; Live Targets must use fixed rows/columns with no internal vertical scrollbar or expansion jitter.

Dashboard 2 makes its own regular-entry decision from its authenticated Kalshi WebSocket top-of-book YES/NO asks for the exact ticker, then uses depth only to validate and execute that selected side.

**Why:** Bot 2 is intentionally an independent bot, but weighted whole-order cost and generic spot trend are the wrong inputs for selecting direction. Direction must come from direct Kalshi YES/NO asks; depth answers only how much can fill.

**How to apply:** Trigger from book updates, select only when exactly one direct ask is inside the configured band, and fail closed on stale/ticker-mismatched or dual-in-band books. Revalidate immediately before live submission and persist both asks plus the depth quote.