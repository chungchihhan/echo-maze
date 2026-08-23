# Echo Maze

Echo Maze is an observable AI-agent game about navigating without a map.

An AI Walker begins at an unknown position inside a generated maze. It can only
see along open corridors until a wall blocks its view. The Walker must interpret
those observations, remember what happened in earlier turns, maintain its own
relative coordinate system, and eventually find the exit.

The interface makes that process visible. One side shows the Walker's concise
reasoning summaries and decisions; the other shows its limited view. A spectator
can reveal the complete maze to compare the Walker's belief with reality.

## What the game explores

- Navigation under partial observability
- Memory and spatial reasoning across a long conversation
- Self-maintained coordinates without access to absolute position
- Recovery from blocked moves, revisited paths, and incorrect beliefs
- The difference between an agent's stated model of the world and the actual maze

## Current game

- One autonomous Walker powered by `gpt-5.6-luna`
- Random solvable mazes with a minimum optimal route length
- Corridor-based line of sight; walls hide everything behind them
- Conversation-only memory within the current run
- No full map, route-finding tool, or external notebook for the Walker
- Observable reasoning summaries rather than hidden chain-of-thought
- Durable recordings of successful and failed runs
- Replay controls with scrubbing and adjustable playback speed

The replay system is an important part of Echo Maze: every run can be reviewed
afterward to understand where the Walker built an accurate map, became confused,
recovered, or failed.

## Project status

Echo Maze is an early prototype focused on the Solo Walker game. The immediate
goal is to learn how reliably an agent can build and use a spatial model from
limited observations and its own conversation history.

For local setup, architecture, and implementation details, see
[DEVELOPMENT.md](./DEVELOPMENT.md).
