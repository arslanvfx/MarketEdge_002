---
name: Contrarian Pyth excursion cadence
description: Durable safety rules for using Pyth commodity updates in fast Contrarian reversal detection.
---

Contrarian commodity movement evidence must come from a dedicated authoritative sampling lane and distinct Pyth publication timestamps. Repeated local polls of one oracle publication are not independent movement samples.

**Why:** Pyth commodity publications can arrive around five seconds apart. Requiring one distinct publication every second makes the detector permanently unevaluable, while trusting local receipt timestamps can make one stale publication look like a valid moving series.

**How to apply:** Keep the newest oracle publication within the strict freshness limit, verify each historical publication was fresh when collected, deduplicate publication times, and use cadence bounds compatible with real Pyth updates. Never coalesce this lane with cached/background quote jobs.