---
name: Kalshi TBD target markets
description: Safe handling for current Kalshi 15-minute contracts that publish quotes before a numeric target.
---

Kalshi may publish a current 15-minute contract with a valid ticker, close time,
exchange route, and YES/NO quotes while `floor_strike` is absent and the market
subtitle says the target is TBD. Market identity must be selected by the intended
close time, not by requiring a numeric strike.

**Why:** Filtering the market list by `floor_strike` discarded every current
contract and selected an already-closed numeric-strike contract instead. The
dashboard then showed stale targets with blank prices. Concurrent unsigned
per-symbol polling also hit public API limits and starved later symbols.

**How to apply:** Cache and display the current ticker and quotes even when its
target is null, use authenticated market reads when credentials exist, and only
confirm a target when the strike is finite and positive. Any trading path that
depends on target distance, direction, or settlement identity must remain
fail-closed until the numeric target is authoritative.