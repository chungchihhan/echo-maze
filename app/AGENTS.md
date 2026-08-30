# Application guidance

## Scope

Applies to `app/**`, including the browser UI, layout, styling, and route-handler subtree.

## Purpose

This module owns the Solo Walker presentation: maze rendering, the client-side turn loop, and replay controls. Environment semantics (generation, movement, line-of-sight observation) live in [`lib/AGENTS.md`](../lib/AGENTS.md); server-only agent and D1 behavior is governed by [`app/api/AGENTS.md`](api/AGENTS.md).

## Start here

- `app/page.tsx` — public landing route; mounts the featured Walker replay from `app/echo-maze.tsx`
- `app/replay/page.tsx` — full replay workspace route with the library, Agent Output, and Walker View
- `app/echo-maze.tsx` — shared client presentation, maze rendering, replay playback, and retained live-loop implementation
- `app/api/agent/route.ts` — model prompt, structured response validation, timeout, and retry boundary
- `app/api/replays/route.ts` — replay persistence and export/listing API
- `app/globals.css` — product UI styling and responsive layout
- `app/layout.tsx` — document metadata and root language/layout

## Architecture and boundaries

- `app/page.tsx` is a read-only landing route: it presents the sanitized featured replay and must not initialize a live run or call `/api/agent`.
- `app/replay/page.tsx` is the full read-only replay workspace. It may read and export saved runs through `/api/replays` but must not initialize a live run or call `/api/agent`.
- The retained live-loop implementation and `/api/agent` boundary are not mounted by a public route.
- The spectator can reveal the full maze in the UI, but spectator-only map state must not enter the Solo Walker request payload.
- Keep browser code independent of Cloudflare bindings, API keys, D1 clients, and server-only imports. Cross the boundary through the existing HTTP routes.
- Keep the current product framing as one Solo Walker powered by `gpt-5.6-luna`; do not reintroduce a two-agent Navigator/Walker UI without an explicit product decision.

## Commands

- `npm run dev` — run the local Vinext application while editing UI or routes
- `npm run build` — validate the production application build
- `npm test` — build and run the rendered HTML regression test
- `npm run lint` — lint the application and repository source

## Editing constraints

- Preserve the observation redaction, corridor line-of-sight, relative-coordinate, and replay invariants in the repository root guidance.
- Keep user-facing interface text in English unless the user asks for another language.
- When replay event payloads or statuses change, keep recording, listing, compact playback, and export compatible.
- Do not place secrets in client code or commit ignored environment files.

## Verification

1. Run `npm run lint` for UI or route changes.
2. Run `npm test` for changes that affect rendered markup, game state, or route/build integration.
3. Run `npm run build` separately when the change crosses the Vinext or Worker boundary.
