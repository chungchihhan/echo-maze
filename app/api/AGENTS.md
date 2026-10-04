# Application API guidance

## Scope

Applies to `app/api/**` and its server-only HTTP route handlers.

## Purpose

This module is the server boundary for model calls and durable replay storage. It owns request validation, external API error handling, and D1 compatibility; it does not own browser state or visual presentation.

## Start here

- `app/api/agent/route.ts` — Solo Walker request policy with OpenAI (Vercel AI SDK) and TypeSafe Jev providers, plus timeout/retry and error diagnostics
- `lib/ai/` — shared OpenAI/OpenRouter transport, TypeSafe System One client, and the Walker prompt/schema
- `app/api/replays/route.ts` — D1 table setup, replay run/event writes, listing, compact playback, and export response
- `db/schema.ts` — Drizzle representation of the replay tables
- `wrangler.jsonc` — add the `DB` binding here when live replay persistence is enabled
- `tests/rendered-html.test.mjs` — current server-rendered product-shell assertions

## Architecture and boundaries

- `POST /api/agent` is gated by `ENABLE_LIVE_API=true`. It accepts `provider: "openai"` (default) or `provider: "typesafe"`.
- OpenAI path reads `OPENAI_API_KEY` and uses the shared Vercel AI SDK client with `gpt-5.6-luna`.
- TypeSafe path reads `TYPESAFE_AI_API_KEY` or `TYPESAFE_API_KEY` and uses `lib/ai/typesafe-client.js` to ask Jev for a Choice over open directions. Relative coordinates stay code-owned; notes are synthesized from the probability distribution.
- The only supported flow is `role: "solo_walker"`; do not add other agent roles without an explicit product decision.
- The agent route enforces structured output but does not repair or reject a blocked action; the environment records it as a wall hit. OpenAI uses a 90-second timeout with up to two attempts; TypeSafe uses a 30-second timeout with up to two attempts.
- `POST /api/replays` stores the run header and ordered event stream in D1. `GET /api/replays` serves both the run library and full/compact replay payloads consumed by the browser.
- Keep `cloudflare:workers`, secrets, and D1 access inside server routes. Do not import route handlers, environment bindings, or database clients into `app/page.tsx`.
- If replay schema or event payloads change, update the Drizzle schema, migration strategy, table-creation SQL, and replay playback/export compatibility together.

## Commands

- `npm run dev` — exercise the route handlers through the local application
- `npm run lint` — lint route and server source
- `npm test` — build and run the repository regression test
- `npm run db:generate` — generate a Drizzle migration after an intentional schema change

## Editing constraints

- Never print, return, or commit `OPENAI_API_KEY`, `TYPESAFE_AI_API_KEY`, `TYPESAFE_API_KEY`, or other environment secrets.
- Preserve the structured response contract, model identifier, retry/timeout diagnostics, and no-store response behavior unless the product contract explicitly changes.
- Do not send spectator-only maze state, absolute position, route data, or hidden game state to the Solo Walker prompt.
- Keep API error payloads useful for replay/error logging without including sensitive request content.

## Verification

1. Run `npm run lint` after route or schema-adjacent edits.
2. Run `npm test` after changing route imports, response contracts, or build integration.
3. Inspect the relevant replay request/response payload shape when changing event types or D1 columns.
