---
name: PostgreSQL parameter arithmetic
description: Preventing ambiguous-operator failures in parameterized PostgreSQL writes.
---

When a SQL expression performs arithmetic between placeholders, cast both operands explicitly, such as `$1::numeric * $2::numeric`.

**Why:** PostgreSQL does not reliably infer placeholder operand types from the destination INSERT column. An uncast placeholder multiplication failed at runtime with SQLSTATE 42725 and silently prevented Smart Exit lifecycle ownership.

**How to apply:** Cast every placeholder participating in arithmetic or overloaded operators, and include a regression check for execution-critical SQL.