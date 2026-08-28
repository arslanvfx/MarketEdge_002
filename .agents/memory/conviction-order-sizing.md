---
name: Conviction entry sizing, zero-fill retry safety, and proximity band
description: IOC ownership rules, durable zero-fill throttling, per-symbol spot preparation, and the global-only proximity clamp
---

# Conviction entry time-in-force

**Rule:** All regular conviction entries, including guarded poller fallback, accept partial fills with IOC and track the position by ACTUAL fill count. Submit at the exact verified executable quote, capped by the conviction zone. Each guarded invocation emits exactly one broker request. An authoritative zero fill has a 30-second minimum retry interval keyed by mode, symbol, and original window, enforced both in memory and by the durable claim transaction. Non-volume errors must always propagate.

**Why:** Regular bets are expected to be IOC. A July 2026 change made conviction FOK; a later correction restored real-book IOC but silently left guarded poller fallback on FOK. Paper mode treated the displayed quote as a fill while fallback FOK rejected the whole request whenever full size was unavailable. After IOC restoration, independent dispatch paths retried authoritative zero fills up to ten times in about 22 seconds. Those calls did not overlap, but the burst was unsafe. Separately, globally coalesced spot batches let one slow product prevent another symbol from receiving its next fresh safety sample.

**How to apply:** Regular conviction entries use IOC at the exact verified quote for every quote source. Pass single-attempt mode to the entry helper; do not add an internal half-size or remainder request. Stamp zero-fill cooldown ownership before releasing any entry reservation, using captured mode and window rather than mutable globals; the database claim must independently enforce the same floor across restarts. Confirmed fills retain durable symbol/window ownership, ambiguous outcomes retain ownership and halt re-entry, and fresh spot sampling must coalesce/publish per symbol so unrelated feeds cannot cause head-of-line blocking. Stop, mode-switch, and rollover callbacks must fail ownership checks before publishing.

# Global proximity threshold — mode-switch baseline clamp

**Rule:** The GLOBAL `strikeProximityMinPct` is clamped to ≤ 0.05% whenever built-in mode defaults or saved presets are merged as a mode-switch baseline. Per-coin `strikeProximityMinPctOverrides` are **NEVER modified** by any migration, clamp, or mode-switch — they are intentional operator risk controls and must be honored exactly as configured.

**Why:** In-zone conviction gaps are naturally 0.01–0.06%; a stale 0.30% global (the old built-in default) blocks essentially every entry. A one-time startup migration handles first-boot, but the mode-switch path re-merges baselines every time — the un-guarded clamp runs there too.

**How to apply:** Use `clampProximityToCalibratedBand(partial)` on the merged baseline inside the mode-switch endpoint, before request-body overrides are applied (so explicit user edits still win). Never route per-coin overrides through any clamp.
