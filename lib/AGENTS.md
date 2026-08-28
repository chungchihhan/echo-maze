# Pure maze core guidance

## Scope

Applies to `lib/maze/**`.

## Purpose

This module is the single source of truth for Echo Maze environment semantics: direction constants, seeded maze generation, movement transitions, corridor line-of-sight observation, and BFS pathfinding. Both the browser UI (`app/page.tsx`) and the headless benchmark runner (`benchmark/episode.js`) import it verbatim so behavior cannot drift between them.

## Start here

- `types.js` — direction table, size/route constants, and JSDoc typedefs (including the narrow `WalkerObservation` DTO)
- `generator.js` — FNV-1a seeded PRNG, recursive-backtracker carving, `generateMaze`
- `transition.js` — `canMove`, `applyMove`, `relativeDelta` (blocked moves never change position or relative coordinates)
- `pathfinding.js` — BFS `shortestPath` / `optimalPathLength`
- `observe.js` — sightlines, visible points, and the visibility-safe observation builder
- `index.js` — barrel export consumed by UI and benchmark

## Architecture and boundaries

- No React, DOM, Cloudflare bindings, D1, Node-only APIs, or OpenAI imports are permitted here. This module must stay runnable in the browser bundle and in plain Node scripts.
- The observation DTO must never expose absolute coordinates, seeds, exit coordinates as data, or unseen cells; exit presence appears only as per-visible-cell `isExit`.
- Movement semantics: a successful move changes relative coordinates by exactly one step; a blocked move changes nothing.
- Changing any semantic here invalidates benchmark fixtures and requires regenerating them plus bumping the contract revision in `benchmark/contract.js`.

## Verification

1. `npm run lint`
2. `npm test` (core unit tests live in `tests/benchmark.test.mjs`)
3. `npm run benchmark:verify` after any semantic change
