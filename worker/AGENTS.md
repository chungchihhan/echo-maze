# Worker runtime guidance

## Scope

Applies to `worker/**` and the Worker/Vite binding configuration that directly controls it.

## Purpose

This module is the Cloudflare Worker entrypoint. It delegates application requests to Vinext's App Router handler; product behavior belongs in `app/` and persistence contracts belong in `db/`/`app/api/`.

## Start here

- `worker/index.ts` — Worker entrypoint delegating to Vinext
- `vite.config.ts` — Vinext and Cloudflare plugin configuration
- `wrangler.jsonc` — direct Cloudflare Worker production configuration
- `app/layout.tsx` — application output handed to the Worker handler
- `package.json` — build, dev, start, and test commands

## Architecture and boundaries

- `worker/index.ts` delegates requests to `vinext/server/app-router-entry`; static assets are emitted and wired by the Cloudflare Vite plugin.
- Direct Cloudflare deployment defaults to a read-only public site. `ENABLE_LIVE_API` must remain `false` unless the agent and replay APIs have deliberately been secured and their required bindings are configured.
- `wrangler.jsonc` is the source of truth for direct Cloudflare deployment.
- Do not move maze logic, agent prompts, replay SQL, or UI state into the Worker entrypoint merely because it is the runtime boundary.
- Keep Worker-specific configuration compatible with the existing Vinext/Vite/Cloudflare stack; this repository is not a standard Next.js server.

## Commands

- `npm run dev` — run the local Worker-backed Vinext development server
- `npm run build` — validate the production Worker/application bundle
- `npm start` — start the built application locally
- `npm run preview` — build and preview in the Cloudflare Workers runtime
- `npm test` — build and run the rendered HTML regression test

## Editing constraints

- Preserve the existing bindings and `nodejs_compat` configuration unless the hosting/runtime contract changes deliberately.
- Do not add Cloudflare bindings that the public read-only site does not use.
- Do not deploy or change hosted resources unless the user explicitly asks.

## Verification

1. Run `npm run build` after Worker or Vite configuration changes.
2. Run `npm test` after changes that affect request routing or rendered output.
3. Run `npm run lint` for TypeScript or configuration source changes.
