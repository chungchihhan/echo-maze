# Worker runtime guidance

## Scope

Applies to `worker/**` and the Worker/Vite binding configuration that directly controls it.

## Purpose

This module is the Cloudflare Worker entrypoint. It handles image optimization and delegates application requests to Vinext's App Router handler; product behavior belongs in `app/` and persistence contracts belong in `db/`/`app/api/`.

## Start here

- `worker/index.ts` — Worker `fetch` entrypoint and binding interfaces
- `vite.config.ts` — Vinext, Sites, Cloudflare plugin, and local binding configuration
- `.openai/hosting.json` — hosted Sites project and D1 binding declarations
- `app/layout.tsx` — application output handed to the Worker handler
- `package.json` — build, dev, start, and test commands

## Architecture and boundaries

- `worker/index.ts` handles `/_vinext/image` through Cloudflare Images and sends all other requests to `vinext/server/app-router-entry`.
- The `DB`, `ASSETS`, and `IMAGES` binding names and shapes must remain aligned with `vite.config.ts` and `.openai/hosting.json`.
- Do not move maze logic, agent prompts, replay SQL, or UI state into the Worker entrypoint merely because it is the runtime boundary.
- Keep Worker-specific configuration compatible with the existing Vinext/Vite/Cloudflare stack; this repository is not a standard Next.js server.

## Commands

- `npm run dev` — run the local Worker-backed Vinext development server
- `npm run build` — validate the production Worker/application bundle
- `npm start` — start the built application locally
- `npm test` — build and run the rendered HTML regression test

## Editing constraints

- Preserve the existing bindings and `nodejs_compat` configuration unless the hosting/runtime contract changes deliberately.
- Keep image optimization behavior scoped to its existing path and delegate normal requests to Vinext.
- Do not deploy or change hosted resources unless the user explicitly asks.

## Verification

1. Run `npm run build` after Worker or Vite configuration changes.
2. Run `npm test` after changes that affect request routing or rendered output.
3. Run `npm run lint` for TypeScript or configuration source changes.
