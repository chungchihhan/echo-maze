# Test guidance

## Scope

Applies to `tests/**` and the repository test commands that execute those files.

## Purpose

This module verifies the built Vinext/Worker application from the outside: server-rendered HTML, product-shell text, and important source-level contract assertions. It is not a unit-test replacement for browser interaction or live OpenAI calls.

## Start here

- `tests/rendered-html.test.mjs` — rendered HTML/product-shell assertions and UI source-contract checks
- `tests/benchmark.test.mjs` — offline benchmark unit/integration tests (fixtures, metrics, adapters, mock pipeline)
- `package.json` — `test`, `build`, and `lint` command definitions
- `worker/index.ts` — runtime module imported by the rendered test
- `app/page.tsx` — source of the UI contract under assertion
- `app/api/agent/route.ts` — source of the agent contract under assertion
- `lib/maze/`, `benchmark/` — shared core and pipeline covered by the tests

## Architecture and boundaries

- `npm test` builds first, then imports `dist/server/index.js` and calls the Worker fetch handler with a test asset binding.
- Assertions intentionally cover observable output and selected source contracts; they should not require a live API key or a D1 service.
- Keep assertions aligned with the current Solo Walker product; do not treat stale assertions as the product contract.
- Do not make tests depend on hidden model chain-of-thought, external network availability, or persisted user data.

## Commands

- `npm test` — build and execute all Node test files (`tests/*.test.mjs`); requires no network or API key
- `npm run build` — isolate build failures before running the test suite
- `npm run lint` — lint application and test-adjacent source

## Editing constraints

- Prefer stable observable strings, response status/content type, and explicit source contracts over brittle snapshots.
- Add new assertions only when they encode an intentional product or runtime invariant.
- Keep tests deterministic and offline; use fixtures or injected doubles for external services.

## Verification

1. Run `npm test` for any test or rendered-output change.
2. Run `npm run lint` when changing test JavaScript or related source.
3. If the test fails before assertions, inspect the preceding `npm run build` output first.
