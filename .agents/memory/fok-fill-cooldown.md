---
name: Confirmed zero-fill retries
description: Conviction zero fills retry on a guarded five-second cadence with fresh authenticated books; uncertain outcomes remain locked
---

## Rule
Conviction entries may retry an authoritative zero fill after at least five seconds, up to ten submissions per symbol/window. Every retry requires a newer authenticated book version and complete executable depth inside the configured band. Timeouts, malformed responses, transport failures, partial fills, positive fills, reserved orders, and unresolved outcomes remain locked.

**Why:** The proven behavior allowed guarded retries around five-second tick cycles. A later one-second poller-qualified retry policy was too aggressive and could resubmit after the executable book materially changed.

**How to apply:** Keep the durable intent reservation authoritative. Enforce the cooldown and ten-attempt ceiling atomically across restarts/processes. Require a changed authenticated book version plus final exact-book revalidation before every conviction IOC retry.
