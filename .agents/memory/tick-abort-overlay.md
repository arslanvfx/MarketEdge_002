---
name: Tick-time abort reasons & one-shot IOC remainder
description: Two invariants for bot dashboard skip reasons and conviction partial-fill sizing
---

# Tick-time abort reason invariant

**Rule:** every post-dispatch early return in the bot tick (any gate that aborts
an order after the Phase-3 loop dispatched the coin) must record a
human-readable abort reason keyed `sym:windowKey`, or the dashboard shows a
stale loop-level reason ("price in zone — monitoring") for a coin that was
actually blocked. This includes non-obvious terminal paths: zero-fill
outcomes, order placement errors, and placement-time smart-hours rejections.

**Why:** operators repeatedly saw misleading skip reasons — the real tick-time
block (proximity re-check, cross-check bounce, direction guard…) was only in
logs. These gates are numerous and easy to miss when adding new ones.

**How to apply:** when adding ANY new gate/early-return between dispatch and
order placement, record the abort reason before `return`. A successful fill
must clear the coin's entry; the map clears on window transition; rows where a
bet was placed are never overridden.

# At-most-two exchange orders per entry (conviction real-book IOC)

**Rule:** thin books cause partial IOC fills, so the bot may re-submit the
unfilled remainder ONCE at the SAME limit price — but the hard invariant is at
most TWO exchange orders per entry, total. The standard entry helper's
half-size volume fallback already counts as the second order; when it fired,
NO remainder may follow. The remainder submission itself must run in
single-attempt mode (fallback disabled) so its own volume rejection is final.

**Why:** a $10 configured bet was landing as $4–7 on thin books; but naive
"one retry" layering on top of the fallback helper silently allows a third
exchange submission — this exact bug was caught in review twice.

**How to apply:** route any remainder/top-up through a pure decision function
that sees the helper's actual attempted size (not the requested size), blend
fill prices by weighted average, respect the ≥3-min-remaining floor, and treat
a 0-fill remainder as final.
