---
name: Conviction entry sizing & proximity band
description: Order time-in-force rules for larger conviction entries, and why proximity thresholds must stay in the calibrated band everywhere config baselines merge
---

# Conviction entry time-in-force

**Rule:** Real-book conviction entries accept partial fills (IOC-style) and track the position by ACTUAL fill count; the empty-book poller-fallback path must stay all-or-nothing (FOK). On an insufficient-resting-volume rejection, retry once at half size (min 1), then treat a second rejection as a normal zero-fill — never as an error. Non-volume errors must always propagate.

**Why:** All-or-nothing orders that worked at 1 contract get rejected wholesale at 12–18 contracts even when most of the volume exists — fill rate collapsed when bet size rose from ~$1 to $10. But Kalshi market makers only fill FOK reactively against an empty book; IOC there cancels instantly with zero fills.

**How to apply:** Entries use the size-fallback helper in the trader module; exits never do — exits depend on the volume-rejection throw to keep the in-memory position open for retry. The limit price still hard-caps fill cost, so zone enforcement and post-fill checks are unchanged.

# Proximity calibrated band

**Rule:** Strike-proximity thresholds must stay in the calibrated band (global ≤0.05%, per-coin ≤ its calibrated suggestion). Any code path that merges a config baseline — startup migration, mode-switch presets, built-in mode defaults — must clamp to this band; the one-time migration flag alone is not enough because presets/defaults are re-applied on every mode switch.

**Why:** In-zone conviction gaps are naturally 0.01–0.06% and ATR scaling (cap 1.2×) adds up to 20%; thresholds above the band block essentially every entry, silently.

**How to apply:** Deliberately tighter user values are preserved; explicit user edits are applied after the clamp so they win. When adding a new preset/default source, route it through the shared clamp helper.
