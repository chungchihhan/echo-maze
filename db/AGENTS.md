# Database guidance

## Scope

Applies to `db/**`. Replay migration files under `drizzle/**` are part of the same persistence contract when a schema change requires them.

## Purpose

This module defines the durable replay data model and exposes the D1-backed Drizzle client. It does not own game rules, model prompts, browser UI, or Worker request routing.

## Start here

- `db/schema.ts` — `replay_runs` and `replay_events` Drizzle tables
- `db/index.ts` — D1 binding guard and Drizzle client factory
- `drizzle/` — checked-in migration history and metadata
- `app/api/replays/route.ts` — runtime SQL/table compatibility boundary
- `wrangler.jsonc` — add the `DB` binding here when live persistence is enabled

## Architecture and boundaries

- `replay_runs` stores run identity, model, maze seed/JSON, initial position, status, and timestamps.
- `replay_events` stores an ordered `(run_id, sequence)` event stream used to reconstruct compact and full replays.
- D1 access is server-only. UI code must call the replay API rather than importing this module.
- The replay route currently ensures its tables with SQL at runtime, so a schema edit is incomplete until `db/schema.ts`, migrations, and that route remain consistent.

## Commands

- `npm run db:generate` — generate a Drizzle migration after an intentional schema change
- `npm test` — build and run the repository regression test after persistence-facing changes
- `npm run lint` — catch TypeScript and source-level regressions

## Editing constraints

- Preserve replay compatibility for successful, failed, abandoned, and stopped runs.
- Keep the composite replay event key and event ordering semantics stable unless the replay reader and migration plan change together.
- Do not put secrets, environment configuration, or UI concerns in `db/**`.
- Do not edit generated migration metadata by hand unless the migration workflow requires it.

## Verification

1. Run `npm run db:generate` and inspect the generated migration for intentional schema changes.
2. Run `npm run lint`.
3. Run `npm test` for changes that affect D1 shape or replay payloads.
