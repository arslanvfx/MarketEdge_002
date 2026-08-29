---
name: api-server unit test setup
description: How API tests/builds run, including native TS-strip constraints and runtime-only identifier failures.
---

## How tests run
`artifacts/api-server` uses Node's built-in runner: `node --test 'src/**/*.test.ts'` (script `test`). No vitest/jest/tsx dependency is added — Node 24 strips TS types natively. Validation step `test` runs `pnpm --filter @workspace/api-server test`.

## Non-obvious constraints
- **Test files MUST import local modules with the explicit `.ts` extension** (e.g. `import { x } from "./autopilot.ts"`). Native type-stripping does no extension resolution for relative ESM imports.
  **Why:** without the extension Node throws ERR_MODULE_NOT_FOUND at runtime.
  **How to apply:** because of this, `allowImportingTsExtensions: true` is set in `artifacts/api-server/tsconfig.json`. That is safe ONLY because api-server is type-checked with `tsc --noEmit` and *built with esbuild* (build.mjs), never emitted by tsc. The root `tsc --build` references only `lib/*`, not api-server.

- **Keep heavy/impure logic out of the unit under test.** `crypto.ts` imports `@workspace/db`, which throws at import time if `DATABASE_URL` is unset and opens a pg Pool. To unit-test pure decision logic, extract it into a dependency-free sibling module (pattern: `autopilot.ts` holds pure `computeAutoPilotDecisions`/`claudeEnabledFor`; `crypto.ts` is a thin wrapper that feeds it live analytics). Tests import only the pure module.

- **A successful API esbuild build does not prove identifiers are declared.** Add an executable or source-wiring regression test when introducing mode flags used in long-running scheduler paths.
  **Why:** esbuild bundled an undeclared scheduler-local mode flag successfully; production then threw a `ReferenceError` on every tick while focused helper tests still passed.
  **How to apply:** after changing scheduler branching, run the actual scheduler path when practical and add a regression assertion that any new local flag is declared before its first use.

## Pre-existing state (as of this work)
`pnpm --filter @workspace/api-server typecheck` already reports ~8 errors in `crypto.ts` (Anthropic SDK `.content` on a possibly-streamed response, and a null-filter type predicate around the coin-predictions array) unrelated to auto-pilot. Don't assume new edits caused them — check the line numbers.
