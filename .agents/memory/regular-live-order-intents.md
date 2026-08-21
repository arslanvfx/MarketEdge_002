---
name: Regular live-order intents
description: Fail-closed rules for regular Kalshi entry and exit submissions when broker outcomes are uncertain.
---

# Regular live-order intents

**Rule:** Persist the exact exchange client order ID and claim the relevant entry or exit reservation before every live POST. Each intent permits one submission only. A malformed response, timeout, transport failure, or ambiguous HTTP status (including 5xx and throttling after send) is unknown exposure: retain the reservation and never retry or send an opposite order. Release only after a verified zero-fill/rejection.

**Why:** A broker or proxy can accept an order and still lose the response. Treating ambiguity as zero fill creates duplicate entries; retrying an uncertain close can sell twice and invert the position.

**How to apply:** Unknown/reserved entries block that symbol across later windows; unknown exits block further closes for that position. Shared window caps must be claimed atomically. Confirmed entry intents transition only after the local position is durable. Live entries and exits must not use same-tick size or remainder resubmissions.

**Price rule:** Enforce known acceptable quotes immediately before POST and treat a fill that contradicts the submitted limit as unknown. A legitimate buy-limit price improvement below an entry band is held; never immediately sell it merely for being cheaper than the strategy’s entry floor.