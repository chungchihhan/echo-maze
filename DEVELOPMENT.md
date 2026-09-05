# Echo Maze development guide

## Technology stack

- **React 19** and **TypeScript** for the interface and game client
- **Vinext** for Next.js App Router-compatible application conventions
- **Vite 8** for local development and production builds
- **Cloudflare Workers** for the server runtime
- **Vercel AI SDK** as the shared model boundary, with OpenAI Responses and
  OpenRouter providers
- **OpenAI Responses API** with `gpt-5.6-luna` for the current hosted Walker
- **Cloudflare D1** for durable run and event storage
- **Drizzle ORM and Drizzle Kit** for the D1 schema and migrations
- **CSS** in `app/globals.css` for most of the visual design
- **OpenAI Sites** and Cloudflare for hosting

Vinext provides familiar Next.js-style files such as `app/page.tsx` and API
route handlers while producing a Vite-powered Cloudflare Worker application.
This repository is therefore not running the standard Next.js runtime.

## Local setup

Requirements:

- Node.js 22.13 or newer
- An OpenAI API key with API billing enabled

Install dependencies:

```bash
npm install
```

Create `.env.local` from the example and add the key:

```bash
cp .env.example .env.local
```

```dotenv
OPENAI_API_KEY=your_api_key_here
```

ChatGPT Plus and OpenAI API billing are separate. Never commit `.env.local` or
an API key.

Start the local application:

```bash
npm run dev
```

The development server normally opens at `http://localhost:3000`.

## Useful commands

```bash
npm run dev          # Start the local development server
npm run build        # Create and validate the production build
npm test             # Build and run repository tests
npm run lint         # Run ESLint
npm run db:generate  # Generate Drizzle migrations after schema changes
```

## Application structure

- `app/page.tsx` contains the game interface, client-side game loop, run
  recording, and replay playback.
- `app/globals.css` contains the interface styling and responsive behavior.
- `lib/ai/vercel-client.js` is the shared single-attempt Vercel AI SDK boundary
  for OpenAI and OpenRouter. SDK retries are disabled so each caller can own
  its retry policy and diagnostics.
- `lib/ai/walker-decision.js` owns the shared Walker prompt and structured
  decision schema.
- `app/api/agent/route.ts` calls the shared AI client and returns the next
  structured decision.
- `app/api/replays/route.ts` creates, updates, lists, and exports replay data.
- `db/schema.ts` defines the D1 replay tables.
- `db/index.ts` exposes the Drizzle D1 client.
- `worker/index.ts` is the Cloudflare Worker entry point.
- `vite.config.ts` combines Vinext, Sites, and Cloudflare Vite integration.
- `.openai/hosting.json` declares the Sites project and its `DB` D1 binding.

## Game and agent flow

1. The browser generates a solvable maze and places the Walker and exit.
2. The Walker receives its current line-of-sight observation and the complete
   conversation from the current run.
3. The server asks the model for a structured response containing its estimated
   relative position, free-form navigation notes, and movement action.
4. The browser applies exactly one attempted move and reports whether it
   succeeded, hit a wall, or reached the exit.
5. The next request includes the accumulated history so the Walker can update
   its spatial model.

The Walker's coordinate origin is its starting cell `(0,0)`. Right and left
change `x`; up and down change `y`. These are relative coordinates maintained by
the model, not the maze's hidden absolute row and column.

## Observability

The displayed reasoning is a short model-authored summary requested as part of
the structured response. It is intended to expose the Walker's working model
and decision strategy; it is not private or hidden model chain-of-thought.

The spectator map may reveal ground truth in the interface, but that information
is not sent to the Walker. The Walker receives only its observation, movement
outcomes, and prior conversation from the same run.

## Replay persistence

Every run is represented by a row in `replay_runs` and an ordered series of
records in `replay_events`. Events include agent requests, model responses,
movement outcomes, errors, and terminal status. Both successful and failed runs
can therefore be inspected and replayed.

The application uses the D1 binding named `DB`. Local generated output,
transcripts, environment files, and the private `docs/` decision notes are
ignored by Git.

## Benchmark (Echo Maze Benchmark v0)

The repository includes a reproducible, headless benchmark pipeline that is
decoupled from the browser UI. The UI and the benchmark runner share one pure
maze core (`lib/maze/`), so environment semantics cannot drift between them.

- `lib/maze/` — pure maze core: types, seeded generation, movement
  transitions, corridor line-of-sight observation, BFS pathfinding. No React,
  DOM, Cloudflare, D1, or OpenAI dependencies.
- `benchmark/contract.js` — the versioned v0 contract (policy revision v0.8):
  route-length tiers, suite defaults, model allowlist, max turns, timeout,
  retry policy, prompt, strict output schema, and their hashes. A parsed
  direction that is visibly blocked counts as a wall hit and consumes the
  turn; schema violations and refusals terminate the episode.
- `benchmark/fixtures.js` — generates a deterministic suite from `suiteSeed`,
  with equal counts in the 16–23, 24–31, and 32–39 optimal-route tiers. Each
  batch freezes its walls, start, exit, canonical optimal path, and hash under
  `results/<batch>/fixtures/` for resume, summary regeneration, and replay.
- `benchmark/adapters/` — benchmark policy around the shared Vercel AI SDK
  transport. Each request records the requested and provider-returned model,
  applies the same schema gate, and records transport retries with exponential
  backoff and `Retry-After`; invalid model output is never repaired. The SDK's
  own retry is disabled. A deterministic mock adapter supports offline dry runs.
- `benchmark/episode.js` — headless episode state machine emitting an
  append-only event log per episode.
- `benchmark/metrics.js` — all metrics are recomputed from raw event logs:
  success rate, SPL, solved-only path efficiency (null for unsolved episodes),
  wall hits, invalid responses, API failures, retry attempts, latency
  p50/p95/max, and token usage.
- `benchmark/run-batch.js` — sequential one-command batch runner producing
  `manifest.json`, per-episode JSONL transcripts, `episode-summary.json`, and
  `summary.json` / `summary.md`. `--resume` only continues a manifest with the
  same model, provider, contract hashes, suite seed, per-tier count, fixture
  set, and source provenance. Live runs reject dirty worktrees. Manifests
  retain dirty/source/diff hashes for exploratory dry runs, and actual model
  identity is derived from raw provider responses.
- `benchmark/verify.js` — offline verification of fixtures, observation leak
  safety, transition semantics, metrics accounting, and episode isolation.

### Maze suites

Every batch generates a new suite unless `--suite-seed` is provided. A suite
always contains equal numbers of mazes from all three tiers:

- Easy: optimal route length 16–23 moves
- Medium: optimal route length 24–31 moves
- Hard: optimal route length 32–39 moves

`--mazes-per-tier` controls the number generated in each tier. It defaults to
3, so a normal batch contains 9 mazes. Valid values are 1–100. The combination
of `suiteSeed`, tier, and index determines each maze; reusing the same seed and
count therefore reproduces the same suite for another model. Increasing the
count preserves the existing prefix in each tier and adds more mazes.

When no suite seed is supplied, the runner creates one and records it in the
manifest and summary. The complete generated snapshots are stored under
`results/<batch>/fixtures/`. They are spectator and replay artifacts only and
are never sent to the Walker.

Each episode has a hard limit of 120 turns. Reaching the limit without finding
the exit produces `unsolved_max_turns`; there is no separate repeated-cycle
detector.

### Running the benchmark

Run a live 9-maze Luna batch using a named suite:

```bash
node --env-file=.env.local benchmark/run-batch.js \
  --provider openai \
  --model gpt-5.6-luna \
  --suite-seed luna-2026-08-29-01 \
  --mazes-per-tier 3 \
  --out results/luna-2026-08-29-01
```

Use the same `--suite-seed` and `--mazes-per-tier` when comparing another
model. Change the output directory so the batches remain separate.

Other useful commands:

```bash
npm run benchmark:verify    # verify fixtures + pipeline invariants (offline)
npm run benchmark:dry-run   # defaults to 3 mazes per tier (9 total)
npm run benchmark:run -- --dry-run --resume results/<dir> # resume a compatible dry run
npm run benchmark:summary -- results/<dir> # regenerate summaries from artifacts
```

### Publishing benchmark runs to the website

Completing a benchmark does not update the website automatically. Raw batch
artifacts stay under the gitignored `results/` directory. To make a completed
batch available to the homepage and Replay Library, publish it into the static
replay dataset:

```bash
npm run replay:publish -- results/luna-2026-08-29-01
```

Use the relevant batch directory in place of `luna-2026-08-29-01`. Publishing
converts solved, failed, and max-turn episodes into the public replay format,
writes individual runs under `public/replay-data/runs/`, and replaces
`public/replay-data/index.json` with an index for the selected batch. It does
not call a model or rerun the benchmark.

Refresh the browser after publishing. If the development server does not pick
up the static asset changes, restart it with `npm run dev`. Unlike `results/`,
the files under `public/replay-data/` are tracked and must be committed if the
replays should appear on the deployed website.

Dry-run results are clearly labeled and are not live model results. Batch
artifacts under `results/` are local outputs and ignored by Git. Archived
live experiment records live in `benchmark/experiments/`.

## Deployment

The repository is configured for OpenAI Sites with a Cloudflare Worker runtime
and D1 persistence. Hosted environments must provide `OPENAI_API_KEY`; the D1
binding is declared in `.openai/hosting.json`.

## Agent contributor instructions

Coding agents should also read [AGENTS.md](./AGENTS.md) before modifying the
repository.
