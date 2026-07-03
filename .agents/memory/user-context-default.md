---
name: User context default
description: When the user shows an issue or asks about data, they mean production — not development.
---

# User context is always production

When the user shows a screenshot, mentions a number, reports an issue, or asks "why is X happening", they are referencing the **production** app and **production database** — not the development environment.

**Why:** The user confirmed explicitly that they always mean production unless they say otherwise. Dev DB has weeks of historical test data that does not match what they see in their deployed app.

**How to apply:**
- Always query `executeSql({ environment: "production" })` first when investigating a user-reported issue.
- Use `fetch_deployment_logs` (not workflow console logs) when debugging runtime errors.
- Never show the user dev-DB analysis without clearly labeling it as dev data.
- When production and dev diverge, trust production as the user's reality.
