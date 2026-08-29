/**
 * Echo Maze Benchmark v0 contract.
 *
 * Everything that must stay fixed across runs and models is defined here:
 * benchmark version, route-length tiers, model allowlist, observation semantics,
 * coordinate system, turn/timeout/retry policy, output schema, and the exact
 * prompt. Hashes over the prompt, schema, and rules are computed from these
 * definitions so any drift changes the recorded hash.
 */

import { createHash } from "node:crypto";
import { MAX_ROUTE_LENGTH, MIN_ROUTE_LENGTH } from "../lib/maze/types.js";

export const BENCHMARK_VERSION = "v0";
export const POLICY_REVISION = "v0.7";
export const GENERATOR_VERSION = "maze-gen-2";
export const OBSERVATION_VERSION = "corridor-sightline-v1";

/** Route-length tiers used by every generated benchmark suite. */
export const ROUTE_LENGTH_TIERS = [
  { id: "easy", label: "Easy", min: 16, max: 23 },
  { id: "medium", label: "Medium", min: 24, max: 31 },
  { id: "hard", label: "Hard", min: 32, max: 39 },
];
export const DEFAULT_MAZES_PER_TIER = 3;
export const MAX_MAZES_PER_TIER = 100;

/** Models permitted in benchmark runs (exact provider model IDs). */
export const MODEL_ALLOWLIST = [
  "gpt-5.6-luna",
  "openai/gpt-5.6-luna",
  "stealth/ox-alpha",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "deepseek/deepseek-v4-flash-0731",
];
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
export const TIMEOUT_MS = 180_000;
/** Transport-level attempts per turn for retryable failures only. */
export const MAX_ATTEMPTS_PER_TURN = 2;
export const MAX_OUTPUT_TOKENS_BASE = 2000;
export const REASONING_EFFORT = "low";

export const RETRY_POLICY =
  "Transport failures (timeout (180s), network error, HTTP 408/409/429/5xx, unreadable API response with 5xx, " +
  "incomplete or missing output) are retried up to 2 attempts per turn with exponential backoff honoring " +
  "Retry-After, plus fixed inter-request pacing; every attempt is recorded. " +
  "Invalid model output (unparseable JSON, schema violation, refusal) is not retried or repaired: it is " +
  "recorded as an invalid response and terminates the episode as unsolved. A valid direction that is " +
  "visibly blocked is not retried or repaired: it is executed as a blocked move, counts as a wall hit, " +
  "consumes the turn, and the episode continues.";

export const COORDINATE_SYSTEM =
  "Walker-relative coordinates start at (0,0). A successful move right changes x by +1, left by -1, " +
  "up by +1, down by -1. A blocked move changes nothing. The Walker never receives absolute maze rows/columns.";

export const HIDDEN_STATE_POLICY =
  "The prompt receives only the narrow observation DTO (open/blocked directions, corridor sightlines, " +
  "per-visible-cell open directions and isExit flag, last action/result) plus the current run's " +
  "conversation. No full maze, no exit coordinates, no seed, no optimal route, no unseen cells, and no " +
  "spectator state may enter the prompt.";

export const WALKER_PROMPT = [
  "You are the Walker inside Echo Maze.",
  "Your goal is to reach the exit.",
  "You cannot see the complete maze, your absolute position, or any hidden state. You have no route-finding tool.",
  "Each turn, you receive your current local observation, open and blocked absolute directions, straight line-of-sight information, the result of your previous action, and the complete conversation from the current run.",
  "The starting cell is defined as relative position (0,0). A successful move right changes x by +1, left changes x by -1, up changes y by +1, and down changes y by -1. A blocked move does not change your position.",
  "Return exactly three fields.",
  "estimated_position: Your current estimate of your relative position. This is your own estimate and may be wrong.",
  "notes: Notes that will be included in later turns of this run. You may use this field in any way you find useful. Choose your own format and decide what is worth recording.",
  "action: Choose exactly one of up, right, down, or left.",
  "Explore the maze using your own strategy and reach the exit. Base your decisions only on the provided observations and conversation.",
].join(" ");

export const RESPONSE_SCHEMA_NAME = "solo_walker_decision";

export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    estimated_position: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "integer", minimum: -100, maximum: 100 },
        y: { type: "integer", minimum: -100, maximum: 100 },
      },
      required: ["x", "y"],
    },
    notes: { type: "string", minLength: 1, maxLength: 280 },
    action: { type: "string", enum: ["up", "right", "down", "left"] },
  },
  required: ["estimated_position", "notes", "action"],
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
  maxRouteLength: MAX_ROUTE_LENGTH,
  routeLengthTiers: ROUTE_LENGTH_TIERS,
  defaultMazesPerTier: DEFAULT_MAZES_PER_TIER,
  maxMazesPerTier: MAX_MAZES_PER_TIER,
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
  outputExtractionPolicy:
    "Policy v0.2: response parsing is tolerant of formatting, not of content. If the whole response is not " +
    "JSON, markdown fences are stripped and/or the first complete brace-balanced {...} object is extracted. " +
    "Answer content is never altered; malformed JSON still fails as invalid_structured_json.",
  outputTokenBudgetPolicy:
    "Policy v0.3: max output tokens raised 900 -> 2000 so verbose reasoning models can finish their JSON " +
    "answer; responses ending on the length limit are categorized as incomplete_output and retried once " +
    "with a doubled budget before counting as an episode-level failure.",
  fieldNormalizationPolicy:
    "Policy v0.4: well-formed decisions under unambiguous field aliases (e.g. reasoning -> reasoning_summary, " +
    "believedPosition -> believed_position) are re-keyed to the canonical schema before validation. Canonical " +
    "fields always win; values are never invented; decisions missing required content still fail.",
  outputFieldPolicy:
    "Policy v0.6: the environment observation is not repeated by the model. Each decision contains only a " +
    "self-reported estimated position, free-form notes for later turns, and an action.",
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
    routeLengthTiers: ROUTE_LENGTH_TIERS,
    defaultMazesPerTier: DEFAULT_MAZES_PER_TIER,
    maxMazesPerTier: MAX_MAZES_PER_TIER,
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
