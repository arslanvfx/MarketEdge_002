---
name: Dashboard refresh stability
description: Resource-isolation rules that prevent background trading and analytics work from blanking or restarting the dashboard.
---

The dashboard must retain its last valid authoritative value during background refreshes. A pending or failed refresh may show stale/refreshing status, but must not replace known data with a loading placeholder.

**Why:** Concurrent uncached totals and high-frequency market-book events exhausted shared process resources; the frontend connection restarted and the P&L card repeatedly returned to Loading even though neither symptom originated in the card itself.

**How to apply:** Coalesce identical authoritative totals, use a short bounded cache, bound both pool acquisition and SQL execution, and preserve the last successful value across route reloads. Never poll an authoritative aggregate faster than its cache lifetime.

Market streams must dispatch the first actionable event immediately, then burst-bound same-side churn while retaining one latest trailing pass after an in-flight action. A real side flip remains immediate, and final execution must always re-read the newest book.

**Why:** Applying every sequential depth delta as a full trading tick and info log created extreme CPU/native-memory/log pressure without improving order safety or fill speed.

**How to apply:** Keep high-volume detection/coalescing telemetry below info level. Preserve terminal quote, reservation, submission, fill, and error logs at operational levels.