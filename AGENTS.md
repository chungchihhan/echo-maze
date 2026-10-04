<!-- SHARED-PROJECT-STATE:BEGIN -->
## Shared project status (local worktree coordination)

For current assignments, progress and blockers, run:
`python3 /Users/liminchen/.codex/skills/agent-project-system/scripts/shared_status.py --repo . status`
All linked worktrees use the same external store. Read `get TASK_ID` before `put ... --expected-version N`; use a stable session/task owner. Imported `untriaged` records are historical claims, not current completion evidence.
For live coordination this section supersedes branch-local status/backlog/plan progress instructions below. Keep architecture, outcomes, acceptance contracts and commit-bound evidence versioned. Do not rewrite tracked status files as a competing global live board. Missing state requires reconciliation. Domain-specific authority (for example Notes GTD and investment strategy/account records) remains unchanged.
<!-- SHARED-PROJECT-STATE:END -->

# Echo Maze repository guidance

## First pass

1. Identify the module that owns the requested behavior.
2. Read that module's `AGENTS.md` before broad exploration or edits; for API work, read both `app/AGENTS.md` and `app/api/AGENTS.md`.
3. Start from the module's listed entrypoints and run its narrowest checks before broader repository validation.

## Module map

| Path | Responsibility | Read next |
| --- | --- | --- |
| `app/` | Browser UI, Solo Walker presentation loop, layout, and styling | `app/AGENTS.md` |
| `app/api/` | Server-only agent and replay HTTP routes | `app/api/AGENTS.md` |
| `lib/maze/` | Pure maze core shared by UI and benchmark (types, generation, movement, observation, pathfinding) | `lib/AGENTS.md` |
| `benchmark/` | Headless benchmark pipeline: contract, fixtures, adapters, runner, metrics, verification | `benchmark/AGENTS.md` |
| `db/` | Drizzle schema and Cloudflare D1 client boundary | `db/AGENTS.md` |
| `worker/` | Cloudflare Worker runtime entrypoint and request handoff | `worker/AGENTS.md` |
| `tests/` | Rendered HTML/source contract tests plus offline benchmark tests | `tests/AGENTS.md` |

## Project intent

Echo Maze is currently a Solo Walker game, not an experiment or a two-agent
Navigator/Walker game. Preserve that product framing unless the user explicitly
changes it.

The Walker navigates a hidden maze using corridor-based line of sight,
conversation history from the current run, and self-maintained relative
coordinates. It must not receive the full maze, absolute position, route data,
or hidden game state.

## Product invariants

- The current model is `gpt-5.6-luna`.
- The Walker starts its relative coordinate system at `(0,0)`.
- A successful move changes the relative coordinate by one; a blocked move does
  not change it.
- Walls block vision. Do not expose cells or the exit through a wall.
- Spectator-only map information must never enter the Walker prompt.
- Memory is limited to the current run's conversation. Do not add cross-run
  memory without explicit approval.
- The Walker has no route tool or external notebook.
- UI reasoning text is an observable summary, never described as hidden
  chain-of-thought.
- Record both successful and failed runs so they can be replayed.
- Keep all user-facing interface text in English unless asked otherwise.

## Working rules

- Preserve the existing Vinext, Vite, Cloudflare Worker, and npm structure.
- Use `apply_patch` for manual file edits.
- Keep secrets only in ignored environment files. Never print or commit API
  keys.
- Preserve user changes in a dirty worktree and avoid destructive Git commands.
- Do not commit files under `docs/`; they are private local product notes.
- When replay events or D1 schema change, keep recording, listing, compact
  playback, and export behavior compatible.
- Do not deploy or commit unless the user asks.

## Benchmark comparison defaults

- For comparisons against the current public model runs, use suite seed
  `emz-public-v0`, `--mazes-per-tier 3` (nine mazes total), and
  `--reasoning-effort low`.
- Keep those three settings identical across models and use a distinct
  `--out` directory for each run. Changing suite seed, maze count, or reasoning
  effort creates a different comparison condition.
- Live runs require a clean Git worktree. Read `benchmark/AGENTS.md` and
  `DEVELOPMENT.md` for the provider command and benchmark details.

## Validation

Run checks in proportion to the change:

```bash
npm run lint
npm run build
npm test
npm run benchmark:verify     # required for any change under lib/ or benchmark/
```

For documentation-only changes, inspect links and `git diff`; a production build
is not normally necessary.

## Further context

Read `README.md` for the product description and `DEVELOPMENT.md` for setup and
architecture.
