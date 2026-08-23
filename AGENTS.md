# AGENTS.md

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

## Repository map

- Main interface and game loop: `app/page.tsx`
- Styles: `app/globals.css`
- OpenAI agent route: `app/api/agent/route.ts`
- Replay API: `app/api/replays/route.ts`
- D1 schema: `db/schema.ts`
- Cloudflare Worker entry: `worker/index.ts`
- Hosting bindings: `.openai/hosting.json`

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

## Validation

Run checks in proportion to the change:

```bash
npm run build
npm test
npm run lint
```

For documentation-only changes, inspect links and `git diff`; a production build
is not normally necessary.

## Further context

Read `README.md` for the product description and `DEVELOPMENT.md` for setup and
architecture.
