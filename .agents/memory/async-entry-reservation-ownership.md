---
name: Async entry reservation ownership
description: Safety rule for releasing trading locks and max-bet tokens across asynchronous entry attempts.
---

Entry attempts that reserve a once-per-window lock or max-bet token must track ownership locally and release each reservation exactly once on every pre-fill abort, retryable zero-fill, or placement error. Cleanup must not depend on the current global decision or paper/live mode after an `await`.

**Why:** Operators can change modes while balance, orderbook, or order requests are in flight. Reading mutable global mode during cleanup can strand a lock that the tick acquired earlier, or let a tick release state it never owned. Missing one early return can also consume a max-bet opportunity without opening a position.

**How to apply:** Set a local ownership flag immediately after each reservation is claimed. Use one idempotent cleanup path for all exits before a confirmed fill. Retain reservations only for confirmed fills or an intentional rest-of-window block.