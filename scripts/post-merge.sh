#!/bin/bash
set -euo pipefail

# Keep post-merge setup non-interactive and non-destructive. This project has
# runtime-managed tables that are intentionally absent from the shared Drizzle
# schema, so a blanket `drizzle-kit push` proposes dropping live tables.
# Schema changes must use explicit, idempotent migrations owned by the feature.
pnpm install --frozen-lockfile
