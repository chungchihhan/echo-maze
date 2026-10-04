import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  generateMaze,
  seededRandom,
  walkerObservation,
  canMove,
  getNeighbor,
  samePoint,
  optimalPathLength,
} from "../../lib/maze/index.js";
import {
  createTypeSafeClient,
  formatChoiceNotes,
  buildVisitedKeys,
  preferUnvisitedDirections,
  relativeNeighbor,
} from "../../lib/ai/typesafe-client.js";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "artifacts/live-jev-lab");

const apiKey = process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("TYPESAFE_AI_API_KEY missing");

const seed = "ECHO-MAZE-DEMO";
const maze = generateMaze(seededRandom(seed), "DEMO01");
const maxTurns = 80;
const client = createTypeSafeClient({ apiKey, model: "jev-latest" });

let position = maze.start;
let relative = { x: 0, y: 0 };
let lastAction = null;
let lastResult = null;
const conversation = [];
const events = [];
const createdAt = Date.now();

events.push({
  type: "run_start",
  createdAt,
  payload: {
    model: "jev-latest",
    provider: "typesafe",
    seed,
    mazeSeed: maze.seed,
    start: maze.start,
    exit: maze.exit,
    optimalPathLength: optimalPathLength(maze.cells, maze.start, maze.exit),
    policy: "prefer-unvisited-open-directions",
  },
});

let status = "abandoned";
for (let turn = 1; turn <= maxTurns; turn += 1) {
  const observation = walkerObservation(maze.cells, maze.exit, position, lastAction, lastResult);
  const visitedKeys = buildVisitedKeys(conversation, relative);
  const candidates = preferUnvisitedDirections(observation.openDirections, relative, visitedKeys);
  const decisionStart = Date.now();
  const result = await client.chooseDirection({
    openDirections: candidates,
    timeoutMs: 30_000,
    state: {
      goal: "Reach the exit using only local corridor observations and relative coordinates.",
      turn,
      relativePosition: relative,
      visitedRelativeKeys: [...visitedKeys],
      visitedCount: visitedKeys.size,
      candidateDirections: candidates,
      currentObservation: observation,
      recentTurns: conversation.slice(-12),
    },
  });
  if (!result.ok) {
    events.push({ type: "agent_error", turn, createdAt: Date.now(), payload: result.error });
    status = "error";
    break;
  }

  const notes = formatChoiceNotes(result.data);
  const action = result.data.choice;
  events.push({
    type: "solo_walker_response",
    turn,
    createdAt: Date.now(),
    payload: {
      model: result.meta.model,
      action,
      notes,
      estimatedPosition: relative,
      decision: {
        probabilities: result.data.probabilities,
        confidence: result.data.confidence,
        source: result.data.source,
        candidates,
        visitedCount: visitedKeys.size,
      },
      meta: result.meta,
      latencyMs: Date.now() - decisionStart,
    },
  });

  const nextAbs = canMove(maze.cells, position, action) ? getNeighbor(position, action) : position;
  const moveResult = samePoint(nextAbs, position) ? "blocked" : "moved";
  const nextRel = moveResult === "moved" ? relativeNeighbor(relative, action) : relative;
  const won = samePoint(nextAbs, maze.exit);
  events.push({
    type: "solo_walker_move",
    turn,
    createdAt: Date.now(),
    payload: {
      direction: action,
      result: moveResult,
      from: position,
      to: nextAbs,
      relativePosition: nextRel,
      won,
    },
  });

  conversation.push({
    turn,
    observation,
    estimatedPosition: relative,
    notes,
    action,
    result: moveResult,
  });

  position = nextAbs;
  relative = nextRel;
  lastAction = action;
  lastResult = moveResult;
  process.stdout.write(`turn ${turn}: ${action} -> ${moveResult}${won ? " WIN" : ""}\n`);
  if (won) {
    status = "won";
    break;
  }
}

const summary = {
  batchId: "live-jev-lab",
  model: "jev-latest",
  provider: "typesafe",
  seed,
  status,
  turns: conversation.length,
  successfulMoves: conversation.filter((turn) => turn.result === "moved").length,
  wallHits: conversation.filter((turn) => turn.result === "blocked").length,
  visitedCells: buildVisitedKeys(conversation, relative).size,
  optimalPathLength: optimalPathLength(maze.cells, maze.start, maze.exit),
  finalRelative: relative,
  createdAt,
  finishedAt: Date.now(),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(outDir, "transcript.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify({
  batchId: "live-jev-lab",
  mode: "live",
  resultClass: "exploratory",
  provider: "typesafe",
  modelRequested: "jev-latest",
  modelReturned: status === "error" ? null : "jev-latest",
  policy: "Live Lab prefer-unvisited relative exploration via TypeSafe Choice",
  entrypoint: "/?lab=1",
  createdAt,
  summary,
}, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
