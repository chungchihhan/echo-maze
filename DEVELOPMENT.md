# Echo Maze development guide

## Technology stack

- **React 19** and **TypeScript** for the interface and game client
- **Vinext** for Next.js App Router-compatible application conventions
- **Vite 8** for local development and production builds
- **Cloudflare Workers** for the server runtime
- **OpenAI Responses API** with `gpt-5.6-luna` for the Walker
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
- `app/api/agent/route.ts` builds the Walker prompt, calls the OpenAI Responses
  API, validates structured output, and returns the next decision.
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
3. The server asks the model for a structured response containing an
   observation summary, reasoning summary, believed relative position,
   coordinate note, and movement direction.
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

## Deployment

The repository is configured for OpenAI Sites with a Cloudflare Worker runtime
and D1 persistence. Hosted environments must provide `OPENAI_API_KEY`; the D1
binding is declared in `.openai/hosting.json`.

## Agent contributor instructions

Coding agents should also read [AGENTS.md](./AGENTS.md) before modifying the
repository.
