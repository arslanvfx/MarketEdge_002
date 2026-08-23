---
name: Regular live-order intents
description: Fail-closed rules for regular Kalshi entry and exit submissions when broker outcomes are uncertain.
---

# Regular live-order intents

**Rule:** Persist the exact exchange client order ID and claim the relevant entry or exit reservation before every live POST. Each intent permits one submission only. A malformed response, timeout, transport failure, or ambiguous HTTP status (including 5xx and throttling after send) is unknown exposure: retain the reservation and never retry or send an opposite order. Release only after a verified zero-fill/rejection.

**Why:** A broker or proxy can accept an order and still lose the response. Treating ambiguity as zero fill creates duplicate entries; retrying an uncertain close can sell twice and invert the position.

**How to apply:** Unknown/reserved entries block that symbol across later windows; unknown exits block further closes for that position. Shared window caps must be claimed atomically. Confirmed entry intents transition only after the local position is durable. Live entries and exits must not use same-tick size or remainder resubmissions.

**Recovery rule:** Automatically repair only `reserved` entries with strong local proof of the same bot fill: bot source, matching live symbol/window/ticker/side, valid count/price, and a tightly bounded post-intent timestamp. Never auto-reconcile `unknown` or manual-source activity. Do not depend on the bet row still having its original entry action because settlement and exits change that lifecycle field.

**Why:** Confirmed fills can be locally durable even if intent finalization fails, but a loose match can misclassify unrelated manual activity and release a reservation whose exchange outcome is still uncertain.

**Price rule:** Enforce known acceptable quotes immediately before POST and treat a fill that contradicts the submitted limit as unknown. A legitimate buy-limit price improvement below an entry band is held; never immediately sell it merely for being cheaper than the strategy’s entry floor.

**Exchange recovery rule:** Resolve an unknown regular intent only from fully paginated authenticated history with one exact economic match and internally consistent terminal order/fill evidence. Conflicting or incomplete evidence remains unresolved.

**Why:** Kalshi can return valid fractional quantities such as `3.60`, and current and historical endpoints can overlap. Integer coercion hides real fills, while loose matching or duplicate evidence can fabricate exposure.

**How to apply:** Repeated evidence may be collapsed only when it agrees. Any disagreement in identity, quantity, price, status, or settlement accounting must fail closed rather than choosing one source.

**Operator override rule:** A signed-in bot operator may explicitly clear an entry intent only after it has reached `unknown`. Never allow the override for `reserved`, which may still be pre-submit or in flight. Preserve the original row and structured actor/time/previous-state evidence under a distinct operator-cleared terminal status; do not represent the result as a zero fill or confirmed fill. Normal late resolution must not overwrite the operator-cleared record.

**Why:** A permanently ambiguous historical order can otherwise block a coin forever, but clearing an in-flight reservation creates duplicate-exposure risk. The explicit unknown-only override makes that tradeoff visible and auditable without weakening the live submission boundary.

**How to apply:** Lock and recheck the exact live row before clearing it, update only while its status remains unknown, and hide/reject the action for every other state. Removing it from unresolved predicates and active-cap indexes releases trading; retain confirmation copy that states the exchange outcome remains unknown.