---
name: Kalshi WebSocket book semantics
description: Non-obvious sequence and fixed-point rules for Kalshi multi-market order-book streams.
---

Treat the WebSocket `seq` as a single ordered stream per subscription `sid`, not per ticker. A multi-market subscription interleaves snapshots and deltas for different tickers under the same sequence.

**Why:** Per-ticker `seq + 1` checks falsely diagnosed every interleaved market message as a gap and caused continuous reconnects.

**How to apply:** Track the last sequence by `sid`; a real gap invalidates every book owned by that subscription until a new snapshot is received.

Store `count_fp` and `delta_fp` as exact integer hundredths, and expose only complete integer contracts as executable depth.

**Why:** Binary floating-point addition/subtraction can leave tiny negative residue after valid decimal deltas, falsely triggering underflow and resnapshot loops.

**How to apply:** Parse fixed-point counts strictly into hundredth units, apply deltas with safe-integer checks, floor aggregate depth to whole contracts, and compute price only across the authorized whole-contract quantity.

Fail-closed resnapshots must force-terminate the old socket before scheduling reconnect.

**Why:** A graceful WebSocket close can remain stuck in `CLOSING`; retaining that socket blocks every reconnect and leaves an autonomous bot with no executable books for hours.

**How to apply:** Clear book state and timers, detach the active socket, terminate it, then schedule a bounded reconnect. Add a connection timeout and log every restart reason.