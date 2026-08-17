---
name: Conviction entry sizing & proximity band
description: Order time-in-force rules for larger conviction entries, and the global-only proximity clamp on mode-switch baselines
---

# Conviction entry time-in-force

**Rule:** Real-book conviction entries accept partial fills (IOC-style) and track the position by ACTUAL fill count; the empty-book poller-fallback path must stay all-or-nothing (FOK). On an insufficient-resting-volume rejection, retry once at half size (min 1), then treat a second rejection as a normal zero-fill — never as an error. Non-volume errors must always propagate.

**Why:** All-or-nothing orders that worked at 1 contract get rejected wholesale at 12–18 contracts even when most of the volume exists — fill rate collapsed when bet size rose from ~$1 to $10. But Kalshi market makers only fill FOK reactively against an empty book; IOC there cancels instantly with zero fills.

**How to apply:** Entries use the size-fallback helper in the trader module; exits never do — exits depend on the volume-rejection throw to keep the in-memory position open for retry. The limit price still hard-caps fill cost, so zone enforcement and post-fill checks are unchanged.

# Global proximity threshold — mode-switch baseline clamp

**Rule:** The GLOBAL `strikeProximityMinPct` is clamped to ≤ 0.05% whenever built-in mode defaults or saved presets are merged as a mode-switch baseline. Per-coin `strikeProximityMinPctOverrides` are **NEVER modified** by any migration, clamp, or mode-switch — they are intentional operator risk controls and must be honored exactly as configured.

**Why:** In-zone conviction gaps are naturally 0.01–0.06%; a stale 0.30% global (the old built-in default) blocks essentially every entry. A one-time startup migration handles first-boot, but the mode-switch path re-merges baselines every time — the un-guarded clamp runs there too.

**How to apply:** Use `clampProximityToCalibratedBand(partial)` on the merged baseline inside the mode-switch endpoint, before request-body overrides are applied (so explicit user edits still win). Never route per-coin overrides through any clamp.
