---
name: Scalper regular-position layering
description: Rules for safely allowing Scalper layers alongside compatible regular bot positions.
---

The Scalper may layer only on an open regular position with the exact same mode, normalized symbol, active window, ticker, and direction. An opposite-side match must be recorded as a conflict and abort the Scalper intent before broker submission. Compatibility reads the current in-memory regular position state synchronously at final execution boundaries; it must not add database, API, or network work to the final-minute order path.

**Why:** A stale preflight view can miss a regular position opened while the Scalper awaits safety work or intent persistence. A final synchronous read avoids opposing exposure without sacrificing the tight execution window.

**How to apply:** Keep regular and Scalper ownership separate: do not share caps, reservations, order mutation, settlement, or P&L. Persist a successful layer’s regular-position relationship on the Scalper order, and persist conflict evidence on its released reservation. Paper outcomes must atomically persist their final order and reservation release together.