# Benchmark pipeline guidance

## Scope

Applies to `benchmark/**`. Batch-local fixture snapshots under `results/` are artifacts; archived experiment records under `benchmark/experiments/` are part of this contract.

## Purpose

This module implements the headless Echo Maze Benchmark (EMZ Benchmark), themed "Memory in Motion": a versioned contract, seeded and stratified maze suites, batch-local immutable snapshots, model adapters, an append-only episode state machine, event-log-derived metrics, a sequential batch runner, and offline verification. It shares environment semantics with the UI through `../lib/maze/` and never depends on the browser.

## Start here

- `contract.js` — versioned v0 contract (policy revision v0.8): route-length tiers, suite defaults, model allowlist, turn/timeout/retry/pacing policy, prompt, schema, SDK transport revision, output framing, and their hashes
- `fixtures.js` — deterministic suite generation plus batch-local snapshot persistence, loading, hashing, and verification
- `adapters/vercel-adapter.js` — benchmark retry, pacing, output extraction, and attempt diagnostics around the shared Vercel AI SDK transport
- `adapters/openai-adapter.js`, `adapters/openrouter-adapter.js` — thin provider entrypoints; SDK retries stay disabled so benchmark retries remain observable
- `adapters/retry-delay.js` — shared bounded backoff and Retry-After parsing used by both live adapters
- `adapters/mock-adapter.js` — deterministic offline explorer used by dry runs
- `episode.js` — episode state machine emitting append-only events
- `metrics.js` — all metrics recomputed from event logs (SPL, path efficiency null when unsolved, latency percentiles, token usage)
- `run-batch.js` / `summarize.js` / `verify.js` — batch CLI, artifact regeneration, invariant verification
- `publish-replays.js` — converts a completed local batch into compact, commit-safe assets under `public/replay-data` for the public observation channel
- `provenance.js` — git cleanliness, working-tree content hash, and diff hash for artifact provenance

## Architecture and boundaries

- Prompts receive only the narrow observation DTO from `lib/maze` plus the current run's conversation. Full mazes, exit coordinates, seeds, optimal routes, or spectator state must not enter prompts.
- Policy v0.7: each batch generates equal fixture counts in the 16–23, 24–31, and 32–39 route-length tiers. The default is three per tier and `--mazes-per-tier` is configurable. Model output remains `estimated_position`, free-form `notes`, and `action`.
- Metrics come from event logs, never from in-memory counters.
- Filesystem artifacts under `results/` (gitignored) are canonical; D1, if added later, is only a projection.
- Every batch records its suite seed, per-tier count, fixture order, full snapshots, and fixture-set hash. The Walker must never receive any of them.

## Commands

```bash
npm run benchmark:verify      # offline invariant checks
npm run benchmark:dry-run     # defaults to 3 mazes per tier (9 total)
OPENAI_API_KEY=... npm run benchmark:run            # live via OpenAI Responses API
OPENROUTER_API_KEY=... npm run benchmark:run -- --provider openrouter --model <id>   # live via OpenRouter
npm run benchmark:summary -- results/<dir>          # regenerate summaries from artifacts
npm run benchmark:run -- --dry-run --resume results/<dir> # resume a compatible dry-run batch
```

Live runs require a clean git worktree. Dry runs may run from a dirty checkout,
but record `dirty`, `sourceHash`, and `diffHash` in the manifest. Resume never
overwrites an existing manifest before checking model/provider, contract hashes,
suite seed, per-tier count, fixture identity, and source provenance compatibility.

## Verification

1. `npm run lint`
2. `npm test` (offline tests cover adapters, metrics, fixtures)
3. `npm run benchmark:verify` before and after any behavioral change
