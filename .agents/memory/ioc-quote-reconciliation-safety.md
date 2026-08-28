---
name: IOC quote and reconciliation safety
description: Durable safety rules for depth-priced IOC orders and ambiguous exchange outcomes.
---

An IOC quote that spans multiple levels must keep two prices separate: the weighted expected fill price and the marginal price required to make the entire quoted size marketable. Submit at the marginal price; use weighted or broker-confirmed averages only for estimates and accounting.

**Why:** Reusing a weighted average as a limit can exclude the worst level included in the quoted depth. For NO contracts, preserve the side-proceeds floor before converting it to the exchange's YES-price field.

**How to apply:** Any entry or exit path that aggregates depth must carry both values explicitly and test asymmetric multi-level books for YES and NO.

An ambiguous order outcome must remain unresolved unless exchange evidence proves the persisted client-order or order identity. Ticker, side, and timestamp proximity are not identity.

**Why:** A manual or unrelated same-market fill can otherwise be misattributed, releasing an exposure lock and allowing duplicate risk.

**How to apply:** Keep unknown intents blocking new exposure and ownership changes until identity-proof reconciliation or an explicit audited operator resolution exists.