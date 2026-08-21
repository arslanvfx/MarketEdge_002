---
name: Scalper signed-in access
description: Durable access-policy decision for the High-Value Scalper controls.
---

Scalper control authorization intentionally matches the regular bot: any app user with a valid Clerk session may change Scalper settings, mode, enabled state, and circuit-breaker state. Signed-out requests must fail closed.

**Why:** The project already treats authenticated app users as trusted bot operators. A separate operator-ID secret or Scalper-only role system blocked the signed-in owner while every other bot control remained available, creating an inconsistent and confusing access model.

**How to apply:** Keep server-side Clerk authentication on every Scalper mutation and keep the capability response identity-free. Do not reintroduce a Scalper-only user-ID secret or role-claim bootstrap unless the user explicitly changes the access policy for the entire bot.