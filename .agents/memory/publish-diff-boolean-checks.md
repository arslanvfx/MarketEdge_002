---
name: Publish diff boolean checks
description: Avoid a Publish schema-diff serialization failure caused by bare boolean check constraints.
---

Boolean check constraints intended to require a true value should use an explicit comparison such as `column = TRUE`, not the bare form `CHECK (column)`.

**Why:** The Publish development-to-production diff can mis-serialize a bare boolean expression as a nested `CHECK (CHECK (column))`, which PostgreSQL rejects during migration validation even though the original development constraint is valid.

**How to apply:** For new or repaired boolean constraints, use explicit equality and inspect the regenerated Publish diff. Validate the exact generated statements in an isolated or rolled-back schema before asking the user to publish.