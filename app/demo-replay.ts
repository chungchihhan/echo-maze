import replay from "./demo-replay.json";
import type { Maze, Point } from "../lib/maze/types.js";

export type DemoReplayDetail = {
  version: 1;
  run: {
    id: string;
    createdAt: number;
    updatedAt: number;
    status: string;
    model: string;
    mazeSeed: string;
    maze: Maze;
    initialPosition: Point;
  };
  events: Array<{
    sequence: number;
    createdAt: number;
    turn: number;
    phase: string;
    type: string;
    payload: unknown;
  }>;
};

export const DEMO_REPLAY_DETAIL = replay as DemoReplayDetail;

// This fixture is derived from the successful live OpenRouter run. The raw
// transcript stays in benchmark/experiments/artifacts and is not shipped to
// the browser; only the sanitized replay fields in demo-replay.json are used.
export const DEMO_REPLAY_PROVENANCE = {
  batchId: "live-luna-r3",
  fixtureId: "echo-maze-bench-v0-02",
  transcript: "benchmark/experiments/artifacts/live-luna-r3/episodes/echo-maze-bench-v0-02/transcript.jsonl",
  model: "openai/gpt-5.6-luna",
  status: "solved",
  turns: 68,
  successfulMoves: 68,
  wallHits: 0,
  invalidResponses: 0,
  optimalPathLength: 26,
} as const;
