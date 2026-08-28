---
name: Conviction entry sizing & proximity band
description: Order time-in-force rules for larger conviction entries, and the global-only proximity clamp on mode-switch baselines
---

# Conviction entry time-in-force

**Rule:** All regular conviction entries, including guarded poller fallback, accept partial fills with IOC and track the position by ACTUAL fill count. Submit at the exact verified executable quote, capped by the conviction zone. Each guarded entry invocation emits exactly one broker request; a definitive insufficient-volume rejection becomes a zero-fill and may be reconsidered only by the next fully guarded tick. Non-volume errors must always propagate.

**Why:** Regular bets are expected to be IOC. A July 2026 change made conviction FOK; a later correction restored real-book IOC but silently left guarded poller fallback on FOK. Paper mode treated the displayed quote as a fill while fallback FOK rejected the whole request whenever full size was unavailable. IOC captures available contracts without leaving a resting order or authorizing price chase.

**How to apply:** Regular conviction entries use IOC at the exact verified quote for every quote source. Pass single-attempt mode to the entry helper; do not add an internal half-size or remainder request. Exits depend on the volume-rejection throw to keep the in-memory position open for retry. Confirmed fills retain durable symbol/window ownership; ambiguous outcomes retain ownership and halt re-entry.

# Global proximity threshold — mode-switch baseline clamp

**Rule:** The GLOBAL `strikeProximityMinPct` is clamped to ≤ 0.05% whenever built-in mode defaults or saved presets are merged as a mode-switch baseline. Per-coin `strikeProximityMinPctOverrides` are **NEVER modified** by any migration, clamp, or mode-switch — they are intentional operator risk controls and must be honored exactly as configured.

**Why:** In-zone conviction gaps are naturally 0.01–0.06%; a stale 0.30% global (the old built-in default) blocks essentially every entry. A one-time startup migration handles first-boot, but the mode-switch path re-merges baselines every time — the un-guarded clamp runs there too.

**How to apply:** Use `clampProximityToCalibratedBand(partial)` on the merged baseline inside the mode-switch endpoint, before request-body overrides are applied (so explicit user edits still win). Never route per-coin overrides through any clamp.
