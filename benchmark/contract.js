/**
 * Echo Maze Benchmark v0 contract.
 *
 * Everything that must stay fixed across runs and models is defined here:
 * benchmark version, fixture order, model allowlist, observation semantics,
 * coordinate system, turn/timeout/retry policy, output schema, and the exact
 * prompt. Hashes over the prompt, schema, and rules are computed from these
 * definitions so any drift changes the recorded hash.
 */

import { createHash } from "node:crypto";
import { MIN_ROUTE_LENGTH } from "../lib/maze/types.js";

export const BENCHMARK_VERSION = "v0";
export const POLICY_REVISION = "v0.1";
export const GENERATOR_VERSION = "maze-gen-1";
export const OBSERVATION_VERSION = "corridor-sightline-v1";

/**
 * Seeds are provenance only. The runtime loads immutable fixture snapshots;
 * it never re-rolls a maze from a seed. Fixture files live in ./fixtures and
 * are named after this order.
 */
export const FIXTURE_SEEDS = [
  "ECHO-BENCH-V0-01",
  "ECHO-BENCH-V0-02",
  "ECHO-BENCH-V0-03",
  "ECHO-BENCH-V0-04",
  "ECHO-BENCH-V0-05",
  "ECHO-BENCH-V0-06",
  "ECHO-BENCH-V0-07",
  "ECHO-BENCH-V0-08",
  "ECHO-BENCH-V0-09",
  "ECHO-BENCH-V0-10",
];

export const FIXTURE_IDS = FIXTURE_SEEDS.map(
  (seed, index) => `echo-maze-bench-${BENCHMARK_VERSION}-${String(index + 1).padStart(2, "0")}`,
);

/** Models permitted in benchmark runs (exact provider model IDs). */
export const MODEL_ALLOWLIST = ["gpt-5.6-luna", "openai/gpt-5.6-luna", "stealth/ox-alpha"];
export const DEFAULT_MODEL = "gpt-5.6-luna";

/** Supported API providers. */
export const PROVIDERS = {
  openai: {
    id: "openai",
    endpoint: "https://api.openai.com/v1/responses",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  openrouter: {
    id: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
};

export const MAX_TURNS = 120;
export const TIMEOUT_MS = 90_000;
/** Transport-level attempts per turn for retryable failures only. */
export const MAX_ATTEMPTS_PER_TURN = 2;
export const MAX_OUTPUT_TOKENS_BASE = 900;
export const REASONING_EFFORT = "low";

export const RETRY_POLICY =
  "Transport failures (timeout, network error, HTTP 408/409/429/5xx, unreadable API response with 5xx, " +
  "incomplete or missing output) are retried up to 2 attempts per turn with exponential backoff honoring " +
  "Retry-After, plus fixed inter-request pacing; every attempt is recorded. " +
  "Invalid model output (unparseable JSON, schema violation, refusal) and a chosen direction that is " +
  "visibly blocked are NOT retried or repaired: they are recorded as invalid responses and terminate " +
  "the episode as unsolved.";

export const COORDINATE_SYSTEM =
  "Walker-relative coordinates start at (0,0). A successful move right changes x by +1, left by -1, " +
  "up by +1, down by -1. A blocked move changes nothing. The Walker never receives absolute maze rows/columns.";

export const HIDDEN_STATE_POLICY =
  "The prompt receives only the narrow observation DTO (open/blocked directions, corridor sightlines, " +
  "per-visible-cell open directions and isExit flag, last action/result) plus the current run's " +
  "conversation. No full maze, no exit coordinates, no seed, no optimal route, no unseen cells, and no " +
  "spectator state may enter the prompt.";

export const WALKER_PROMPT = [
  "You are the only agent inside Echo Maze.",
  "You cannot see a map, your absolute coordinates, or any hidden state. You have no route tool and no notebook.",
  "Your sole memory is the complete conversation from this run: prior observations, your prior reasoning summaries and decisions, and movement outcomes.",
  "Maintain your own relative coordinate system in that conversation. The starting cell is (0,0); moving right changes x by +1, left changes x by -1, up changes y by +1, and down changes y by -1.",
  "A successful prior move changes your coordinate by exactly one. A blocked prior move leaves it unchanged. Recalculate your current believed coordinate from the history every turn.",
  "Write one coordinate note for the current cell that records useful open directions, explored branches, dead ends, or a possible revisit. This note becomes part of the next turn's conversation.",
  "The current observation shows open and blocked absolute directions plus straight line-of-sight corridors. A wall hides everything beyond it.",
  "Use the conversation to build and revise a mental route: remember branches already attempted, recognize likely revisits from matching views and action history, and backtrack from dead ends.",
  "Never claim certainty about a location or unseen geometry. Never invent coordinates.",
  "If the exit is visible, choose the open direction whose sightline contains isExit=true.",
  "Otherwise prefer an open branch you believe has not been explored; when necessary, deliberately backtrack.",
  "Return a concise English observation summary and a concise, useful English reasoning summary that makes your memory strategy observable.",
  "Write the coordinate note in English as well.",
  "Choose exactly one direction from the currently open directions.",
].join(" ");

export const RESPONSE_SCHEMA_NAME = "solo_walker_decision";

export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    observation_summary: { type: "string", minLength: 1, maxLength: 220 },
    reasoning_summary: { type: "string", minLength: 1, maxLength: 360 },
    believed_position: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "integer", minimum: -100, maximum: 100 },
        y: { type: "integer", minimum: -100, maximum: 100 },
      },
      required: ["x", "y"],
    },
    coordinate_note: { type: "string", minLength: 1, maxLength: 280 },
    direction: { type: "string", enum: ["up", "right", "down", "left"] },
  },
  required: ["observation_summary", "reasoning_summary", "believed_position", "coordinate_note", "direction"],
};

/**
 * Output framing appended to the user message by every provider adapter so
 * structured-output compliance is requested identically regardless of
 * whether the transport natively enforces a JSON schema.
 */
export const OUTPUT_FRAMING =
  "\n\nRespond with ONLY a single valid JSON object (no markdown, no extra text) exactly matching this JSON schema: "
  + JSON.stringify(RESPONSE_SCHEMA);

/** Stable JSON stringify with recursively sorted object keys. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/** @param {unknown} value */
export function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export const PROMPT_HASH = sha256(WALKER_PROMPT);
export const SCHEMA_HASH = sha256(RESPONSE_SCHEMA);

export const RULES = {
  benchmarkVersion: BENCHMARK_VERSION,
  generatorVersion: GENERATOR_VERSION,
  observationVersion: OBSERVATION_VERSION,
  mazeSize: 9,
  minRouteLength: MIN_ROUTE_LENGTH,
  coordinateSystem: COORDINATE_SYSTEM,
  hiddenStatePolicy: HIDDEN_STATE_POLICY,
  maxTurns: MAX_TURNS,
  timeoutMs: TIMEOUT_MS,
  maxAttemptsPerTurn: MAX_ATTEMPTS_PER_TURN,
  retryPolicy: RETRY_POLICY,
  maxOutputTokensBase: MAX_OUTPUT_TOKENS_BASE,
  reasoningEffort: REASONING_EFFORT,
  modelAllowlist: MODEL_ALLOWLIST,
  outputFraming: "JSON-only output instruction (OUTPUT_FRAMING) appended to every request; response_format json_schema also passed where supported.",
  moveSemantics: "One attempted move per turn; blocked moves keep the Walker in place.",
  episodeTermination: [
    "solved: the Walker reaches the exit",
    "unsolved_max_turns: turn budget exhausted",
    "invalid_output: invalid structured output (unparseable JSON, schema violation, refusal); no repair, no retry",
    "api_failure: retryable transport failure not resolved within the attempt budget",
  ],
  blockedDirectionPolicy:
    "Policy v0.1: a parsed decision naming a visibly blocked direction is recorded as an attempted move " +
    "with result \"blocked\" (wall hit), consuming the turn. The episode continues; the behavior is never " +
    "repaired or retried within the turn.",
  scoring: {
    pathEfficiency: "optimalPathLength / successfulMoves for solved episodes; null for unsolved episodes",
    spl: "success * optimalPathLength / max(optimalPathLength, successfulMoves)",
  },
};

export const RULES_HASH = sha256(RULES);

/** Full contract descriptor embedded in every manifest. */
export function contractDescriptor() {
  return {
    benchmarkId: "echo-maze-benchmark",
    benchmarkVersion: BENCHMARK_VERSION,
    policyRevision: POLICY_REVISION,
    generatorVersion: GENERATOR_VERSION,
    observationVersion: OBSERVATION_VERSION,
    fixtureOrder: FIXTURE_IDS,
    modelAllowlist: MODEL_ALLOWLIST,
    defaultModel: DEFAULT_MODEL,
    maxTurns: MAX_TURNS,
    timeoutMs: TIMEOUT_MS,
    maxAttemptsPerTurn: MAX_ATTEMPTS_PER_TURN,
    retryPolicy: RETRY_POLICY,
    maxOutputTokensBase: MAX_OUTPUT_TOKENS_BASE,
    reasoningEffort: REASONING_EFFORT,
    coordinateSystem: COORDINATE_SYSTEM,
    hiddenStatePolicy: HIDDEN_STATE_POLICY,
    promptHash: PROMPT_HASH,
    schemaHash: SCHEMA_HASH,
    rulesHash: RULES_HASH,
  };
}
