# Benchmark pipeline guidance

## Scope

Applies to `benchmark/**`. Fixtures under `benchmark/fixtures/` and archived experiment records under `benchmark/experiments/` are part of this contract.

## Purpose

This module implements the headless Echo Maze Benchmark: a versioned contract, immutable maze fixtures, model adapters, an append-only episode state machine, event-log-derived metrics, a sequential batch runner, and offline verification. It shares environment semantics with the UI through `../lib/maze/` and never depends on the browser.

## Start here

- `contract.js` — versioned v0 contract (policy revision v0.4): fixture order, model allowlist, turn/timeout/retry policy, prompt, schema, output framing, and their hashes
- `fixtures/` + `fixtures.js` — ten frozen maze snapshots with content hashes; runtime loads snapshots and never re-rolls seeds
- `adapters/openai-adapter.js`, `adapters/openrouter-adapter.js` — provider transports; transport retries recorded with exponential backoff honoring Retry-After; invalid model output recorded, never repaired
- `adapters/retry-delay.js` — shared bounded backoff and Retry-After parsing used by both live adapters
- `adapters/mock-adapter.js` — deterministic offline explorer used by dry runs
- `episode.js` — episode state machine emitting append-only events
- `metrics.js` — all metrics recomputed from event logs (SPL, path efficiency null when unsolved, latency percentiles, token usage)
- `run-batch.js` / `summarize.js` / `verify.js` — batch CLI, artifact regeneration, invariant verification
- `provenance.js` — git cleanliness, working-tree content hash, and diff hash for artifact provenance

## Architecture and boundaries

- Prompts receive only the narrow observation DTO from `lib/maze` plus the current run's conversation. Full mazes, exit coordinates, seeds, optimal routes, or spectator state must not enter prompts.
- Policy v0.4: a parsed direction that is visibly blocked counts as a wall hit consuming the turn; the episode continues. Schema violations and refusals terminate the episode as `invalid_output` without repair.
- Metrics come from event logs, never from in-memory counters.
- Filesystem artifacts under `results/` (gitignored) are canonical; D1, if added later, is only a projection.
- Fixture regeneration (`scripts/generate-fixtures.mjs --force`) is an intentional contract change requiring hash review.

## Commands

```bash
npm run benchmark:verify      # offline invariant checks
npm run benchmark:dry-run     # full 10-episode mock pipeline
OPENAI_API_KEY=... npm run benchmark:run            # live via OpenAI Responses API
OPENROUTER_API_KEY=... npm run benchmark:run -- --provider openrouter --model <id>   # live via OpenRouter
npm run benchmark:summary -- results/<dir>          # regenerate summaries from artifacts
npm run benchmark:run -- --dry-run --resume results/<dir> # resume a compatible dry-run batch
```

Live runs require a clean git worktree. Dry runs may run from a dirty checkout,
but record `dirty`, `sourceHash`, and `diffHash` in the manifest. Resume never
overwrites an existing manifest before checking model/provider, contract hashes,
fixture identity, and source provenance compatibility.

## Verification

1. `npm run lint`
2. `npm test` (offline tests cover adapters, metrics, fixtures)
3. `npm run benchmark:verify` before and after any behavioral change
