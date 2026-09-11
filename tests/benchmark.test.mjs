/**
 * Benchmark unit/integration tests — fully offline, no live OpenAI API.
 * Complements `npm run benchmark:verify` (which stays a standalone command).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DIRECTIONS,
  applyMove,
  canMove,
  generateMaze,
  getNeighbor,
  relativeDelta,
  seededRandom,
  shortestPath,
  walkerObservation,
} from "../lib/maze/index.js";
import {
  DEFAULT_MAZES_PER_TIER,
  MAX_TURNS,
  MODEL_ALLOWLIST,
  PROMPT_HASH,
  RESPONSE_SCHEMA,
  ROUTE_LENGTH_TIERS,
  SCHEMA_HASH,
  WALKER_PROMPT,
  contractDescriptor,
  sha256,
} from "../benchmark/contract.js";
import {
  computeFixtureHash,
  generateFixtureSuite,
  verifyFixture,
} from "../benchmark/fixtures.js";
import { runEpisode } from "../benchmark/episode.js";
import { createMockAdapter } from "../benchmark/adapters/mock-adapter.js";
import { computePacingDelayMs, createOpenAIAdapter, extractOutputText, extractRateLimitHeaders, validateParsed } from "../benchmark/adapters/openai-adapter.js";
import { createOpenRouterAdapter } from "../benchmark/adapters/openrouter-adapter.js";
import { computeRetryDelayMs, parseDurationMs, retryDelay } from "../benchmark/adapters/retry-delay.js";
import { extractJsonObject } from "../benchmark/adapters/json-extract.js";
import { normalizeDecisionFields } from "../benchmark/adapters/decision-normalize.js";
import {
  computeBatchLatency,
  computeBatchMetrics,
  computeEpisodeMetrics,
  percentile,
} from "../benchmark/metrics.js";
import { regenerateSummary } from "../benchmark/summarize.js";
import { runBatch } from "../benchmark/run-batch.js";
import {
  encodeReusableTranscript,
  publishedEpisodeIdentity,
  publishedEpisodeIdentityHash,
} from "../benchmark/published-reuse.js";
import { mergePublishedRuns } from "../benchmark/publish-replays.js";
import {
  BENCHMARK_NAME,
  BENCHMARK_SHORT_NAME,
  BENCHMARK_THEME,
  formatBenchmarkFixtureId,
} from "../lib/benchmark-brand.js";

function openAIResponse({ id, status = "completed", model = "gpt-5.6-luna", text = null, usage = null }) {
  return {
    id,
    object: "response",
    created_at: 1,
    status,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    model,
    output: text === null ? [] : [{
      id: `${id}_message`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

test("maze core is deterministic and semantically stable", () => {
  const a = generateMaze(seededRandom("EMZ-V0-01"), "EMZ-V0-01", { size: 9, minRouteLength: 24, maxRouteLength: 31 });
  const b = generateMaze(seededRandom("EMZ-V0-01"), "EMZ-V0-01", { size: 9, minRouteLength: 24, maxRouteLength: 31 });
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.start, b.start);
  assert.deepEqual(a.exit, b.exit);
  assert.equal(formatBenchmarkFixtureId("emz-v0-02"), "EMZ-V0-02");
  assert.equal(formatBenchmarkFixtureId("custom-maze-seed"), "custom-maze-seed");
  assert.ok(a.routeLength >= 24);
  assert.ok(a.routeLength <= 31);

  // Blocked moves keep position; successful moves change it by exactly one.
  const cells = a.cells;
  const blockedDir = DIRECTIONS.find(({ key }) => !canMove(cells, a.start, key));
  if (blockedDir) {
    const blocked = applyMove(cells, a.start, blockedDir.key);
    assert.equal(blocked.result, "blocked");
    assert.deepEqual(blocked.position, a.start);
    assert.deepEqual(relativeDelta(blockedDir.key, "blocked"), { x: 0, y: 0 });
  }
  const openDir = DIRECTIONS.find(({ key }) => canMove(cells, a.start, key));
  assert.ok(openDir);
  const moved = applyMove(cells, a.start, openDir.key);
  assert.equal(moved.result, "moved");
  assert.deepEqual(moved.position, getNeighbor(a.start, openDir.key));
  assert.deepEqual(relativeDelta(openDir.key, "moved"), {
    x: moved.position.c - a.start.c,
    y: a.start.r - moved.position.r,
  });

  // BFS path is valid and optimal length is edge count.
  const path = shortestPath(cells, a.start, a.exit);
  assert.equal(path.length - 1, a.routeLength);
  assert.deepEqual(path[0], a.start);
  assert.deepEqual(path[path.length - 1], a.exit);
});

test("observation DTO never exposes hidden state", () => {
  const maze = generateMaze(seededRandom("leak-check"), "leak-check", { size: 9, minRouteLength: 24 });
  const observation = walkerObservation(maze.cells, maze.exit, maze.start, null, null);
  const serialized = JSON.stringify(observation);
  assert.ok(!/"r"/.test(serialized), "absolute rows must not appear in the observation DTO");
  assert.ok(!/"c"/.test(serialized), "absolute columns must not appear in the observation DTO");
  assert.ok(!serialized.includes("seed"));
  assert.ok(!serialized.includes("routeLength"));
  if (!observation.exitVisible) assert.ok(!/"isExit":true/.test(serialized));
  // Origin open/blocked classification agrees with the wall grid.
  for (const { key } of DIRECTIONS) {
    const open = canMove(maze.cells, maze.start, key);
    assert.equal(observation.openDirections.includes(key), open);
    assert.equal(observation.blockedDirections.includes(key), !open);
  }
});

test("generated v0 suites are deterministic, stratified, unique, and BFS-verified", () => {
  const fixtures = generateFixtureSuite("unit-suite", DEFAULT_MAZES_PER_TIER);
  assert.equal(fixtures.length, 9);
  assert.equal(new Set(fixtures.map((fixture) => fixture.seed)).size, 9);
  assert.equal(new Set(fixtures.map((fixture) => fixture.fixtureHash)).size, 9);
  assert.deepEqual(generateFixtureSuite("unit-suite", DEFAULT_MAZES_PER_TIER), fixtures);
  assert.notDeepEqual(
    generateFixtureSuite("another-suite", DEFAULT_MAZES_PER_TIER).map((fixture) => fixture.fixtureHash),
    fixtures.map((fixture) => fixture.fixtureHash),
  );
  fixtures.forEach((fixture) => {
    const tier = ROUTE_LENGTH_TIERS.find((candidate) => candidate.id === fixture.difficultyTier);
    assert.ok(tier);
    assert.deepEqual(verifyFixture(fixture), []);
    assert.equal(computeFixtureHash(fixture), fixture.fixtureHash);
    assert.equal(fixture.difficultyTier, tier.id);
    assert.ok(fixture.optimalPathLength >= tier.min);
    assert.ok(fixture.optimalPathLength <= tier.max);
    assert.ok(!fixture.optimalPath.some((point) => point.r < 0 || point.c < 0));
  });
  // Contract hashes are stable and non-trivial.
  assert.equal(SCHEMA_HASH, sha256(RESPONSE_SCHEMA));
  assert.equal(PROMPT_HASH, sha256(WALKER_PROMPT));
  assert.notEqual(PROMPT_HASH, SCHEMA_HASH);
  assert.deepEqual(RESPONSE_SCHEMA.required, ["estimated_position", "notes", "action"]);
  assert.equal(Object.hasOwn(RESPONSE_SCHEMA.properties, "observation_summary"), false);
  assert.match(WALKER_PROMPT, /use this field in any way you find useful/i);
  assert.doesNotMatch(WALKER_PROMPT, /prefer an open branch|backtrack from dead ends|if the exit is visible/i);
  assert.deepEqual(MODEL_ALLOWLIST, [
    "gpt-5.6-luna",
    "openai/gpt-5.6-luna",
    "deepseek/deepseek-v4.1-flash",
    "stealth/ox-alpha",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "deepseek/deepseek-v4-flash-0731",
    "z-ai/glm-5.3-flash",
  ]);
});

test("published reuse identity survives suite expansion but separates effort", () => {
  const fixture = generateFixtureSuite("reuse-suite", 1)[0];
  const base = {
    ...contractDescriptor(),
    mode: "live",
    resultClass: "official",
    provider: "openrouter",
    apiEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    modelRequested: "openai/gpt-5.6-luna",
    suiteSeed: "reuse-suite",
    mazesPerTier: 3,
    fixtureOrder: [fixture.fixtureId],
  };
  const expanded = { ...base, mazesPerTier: 6, fixtureOrder: [fixture.fixtureId, "another"] };
  assert.equal(
    publishedEpisodeIdentityHash(base, fixture),
    publishedEpisodeIdentityHash(expanded, fixture),
  );
  assert.notEqual(
    publishedEpisodeIdentityHash(base, fixture),
    publishedEpisodeIdentityHash({ ...base, reasoningEffort: "medium" }, fixture),
  );
});

test("publishing a batch preserves other indexed models and replaces matching runs", () => {
  const existing = [
    { id: "luna-1", model: "openai/gpt-5.6-luna", homepage_order: 1 },
    { id: "deepseek-1", model: "old-model", homepage_order: 2 },
  ];
  const published = [
    { id: "deepseek-1", model: "deepseek/deepseek-v4.1-flash", homepage_order: 2 },
    { id: "deepseek-2", model: "deepseek/deepseek-v4.1-flash", homepage_order: 3 },
  ];

  assert.deepEqual(mergePublishedRuns(existing, published), [
    existing[0],
    published[0],
    published[1],
  ]);
});

test("policy v0.1: a visibly blocked direction is a wall hit, not a termination", async () => {
  const fixtures = generateFixtureSuite("blocked-policy-suite", 1);
  const events = [];
  // The mock always picks a direction from blockedDirections: under v0.1 this
  // consumes turns as wall hits instead of terminating the episode.
  const result = await runEpisode({
    fixture: fixtures[0],
    maxTurns: 4,
    adapter: async ({ observation }) => ({
      attempts: [{ attempt: 1, latencyMs: 1, errorCategory: null, usage: null }],
      parsed: {
        estimated_position: { x: 0, y: 0 },
        notes: "c",
        action: observation.blockedDirections[0],
      },
      error: null,
    }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "unsolved_max_turns");
  const moves = events.filter((event) => event.type === "move");
  assert.equal(moves.length, 4);
  assert.ok(moves.every((move) => move.result === "blocked"));

  const metrics = computeEpisodeMetrics(events, fixtures[0]);
  assert.equal(metrics.wallHits, 4);
  assert.equal(metrics.successfulMoves, 0);
  assert.equal(metrics.invalidResponses, 0); // blocked choice \u2260 invalid response
  assert.equal(metrics.pathEfficiency, null);
  assert.equal(metrics.spl, 0);
});

test("metrics are reproducible from event logs with correct accounting", () => {
  const fixture = { optimalPathLength: 10, fixtureId: "f1" };
  const events = [
    { type: "episode_start", fixtureId: "f1" },
    { type: "turn_start", turn: 1, observation: {} },
    {
      type: "model_result", turn: 1,
      attempts: [
        { attempt: 1, latencyMs: 400, errorCategory: "timeout", usage: null },
        { attempt: 2, latencyMs: 100, errorCategory: null, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
      ],
      parsed: { direction: "up" }, errorCategory: null,
    },
    { type: "move", turn: 1, direction: "up", result: "blocked" },
    { type: "turn_start", turn: 2, observation: {} },
    {
      type: "model_result", turn: 2,
      attempts: [{ attempt: 1, latencyMs: 300, errorCategory: null, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }],
      parsed: { direction: "up" }, errorCategory: null,
    },
    { type: "move", turn: 2, direction: "up", result: "moved", won: true },
    { type: "episode_end", status: "solved", reason: "Exit reached.", turns: 2 },
  ];

  const metrics = computeEpisodeMetrics(events, fixture);
  assert.equal(metrics.solved, true);
  assert.equal(metrics.attemptedTurns, 2);
  assert.equal(metrics.validActions, 2);
  assert.equal(metrics.successfulMoves, 1);
  assert.equal(metrics.wallHits, 1);
  assert.equal(metrics.retryAttempts, 1);
  assert.equal(metrics.invalidResponses, 0);
  assert.equal(metrics.apiFailures, 0);
  assert.equal(metrics.pathEfficiency, 10); // 10 / 1
  assert.equal(metrics.spl, 1); // success * 10 / max(10, 1)
  assert.deepEqual(metrics.latencyMs, { p50: 300, p95: 400, max: 400, total: 800, samples: 3 });
  assert.equal(metrics.tokens.totalTokens, 60);

  // Unsolved episodes report null path efficiency, not a misleading ratio.
  const unsolved = computeEpisodeMetrics([
    { type: "turn_start", turn: 1, observation: {} },
    { type: "model_result", turn: 1, attempts: [{ attempt: 1, latencyMs: 5, errorCategory: "schema_violation" }], parsed: null, errorCategory: "invalid_response" },
    { type: "episode_end", status: "invalid_output", reason: "Model refused the request.", turns: 1 },
  ], fixture);
  assert.equal(unsolved.pathEfficiency, null);
  assert.equal(unsolved.spl, 0);
  assert.equal(unsolved.invalidResponses, 1);

  // Batch aggregation and latency percentiles.
  const batch = computeBatchMetrics([metrics, unsolved]);
  assert.equal(batch.totalEpisodes, 2);
  assert.equal(batch.solved, 1);
  assert.equal(batch.successRate, 0.5);
  assert.equal(batch.solvedOnlyPathEfficiency, 10);
  assert.equal(batch.totals.wallHits, 1);
  const latency = computeBatchLatency([[...events], []]);
  assert.equal(latency.samples, 3);
  assert.equal(latency.totalRequestLatencyMs, 800);
  assert.equal("totalWallClockMs" in latency, false);
  assert.equal(percentile([1, 2], 0.95), 2);
});

test("mock dry-run pipeline completes 9 isolated episodes and summaries regenerate", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "emz-test-"));
  try {
    const { batchDir, summary, outcomes } = await runBatch({
      dryRun: true,
      batchId: "test-dry-run",
      outDir: tempDir,
      commit: "test-commit",
      suiteSeed: "test-suite",
      mazesPerTier: 3,
    });
    assert.equal(outcomes.length, 9);
    for (const outcome of outcomes) {
      assert.ok(["solved", "unsolved_max_turns"].includes(outcome.status), outcome.status);
    }
    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.reasoningEffort, "low");
    assert.equal(summary.liveApiCall, false);
    assert.equal(summary.episodes.length, 9);
    assert.equal(summary.difficultyTiers.easy.totalEpisodes, 3);
    assert.equal(summary.difficultyTiers.medium.totalEpisodes, 3);
    assert.equal(summary.difficultyTiers.hard.totalEpisodes, 3);
    assert.ok(summary.disclaimer.includes("NOT a live"));

    // Manifest records the full contract.
    const manifest = JSON.parse(await readFile(path.join(batchDir, "manifest.json"), "utf8"));
    assert.equal(manifest.benchmarkVersion, "v0");
    assert.equal(manifest.benchmarkName, BENCHMARK_NAME);
    assert.equal(manifest.benchmarkShortName, BENCHMARK_SHORT_NAME);
    assert.equal(manifest.benchmarkTheme, BENCHMARK_THEME);
    assert.equal(manifest.modelRequested, "gpt-5.6-luna");
    assert.equal(manifest.modelReturned, "mock-explorer");
    assert.deepEqual(manifest.modelsReturned, ["mock-explorer"]);
    assert.equal(manifest.resultClass, "exploratory");
    assert.equal(manifest.commit, "test-commit");
    assert.equal(typeof manifest.dirty, "boolean");
    assert.match(manifest.sourceHash, /^[0-9a-f]{64}$/);
    assert.match(manifest.diffHash, /^[0-9a-f]{64}$/);
    assert.equal(manifest.maxTurns, MAX_TURNS);
    assert.equal(manifest.suiteSeed, "test-suite");
    assert.equal(manifest.mazesPerTier, 3);
    assert.ok(manifest.fixtureOrder.length === 9);
    assert.ok(manifest.fixtureOrder.every((fixtureId) => /^emz-v0-(easy|medium|hard)-\d{3}$/.test(fixtureId)));
    assert.ok(manifest.promptHash && manifest.schemaHash && manifest.rulesHash && manifest.fixtureSetHash);

    // Summaries must be regenerable from raw artifacts alone.
    const regenerated = await regenerateSummary(batchDir);
    assert.equal(regenerated.solved, summary.solved);
    assert.equal(regenerated.resultClass, "exploratory");
    assert.equal(regenerated.benchmarkShortName, BENCHMARK_SHORT_NAME);
    assert.equal(regenerated.benchmarkTheme, BENCHMARK_THEME);
    assert.equal(regenerated.successRate, summary.successRate);
    assert.deepEqual(regenerated.totals, summary.totals);
    assert.deepEqual(regenerated.latency, summary.latency);

    // Actual model identity is derived from raw attempts, not trusted from a
    // potentially stale requested-model field in the manifest.
    const tamperedManifest = { ...manifest, modelReturned: "wrong-model", modelsReturned: ["wrong-model"] };
    await writeFile(path.join(batchDir, "manifest.json"), `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    const modelRegenerated = await regenerateSummary(batchDir);
    assert.equal(modelRegenerated.modelReturned, "mock-explorer");
    assert.deepEqual(modelRegenerated.modelsReturned, ["mock-explorer"]);

    // Episode isolation: each transcript belongs to exactly one fixture.
    for (const fixtureId of manifest.fixtureOrder) {
      const transcript = await readFile(path.join(batchDir, "episodes", fixtureId, "transcript.jsonl"), "utf8");
      const events = transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const startIds = new Set(events.filter((event) => event.type === "episode_start").map((event) => event.fixtureId));
      assert.deepEqual([...startIds], [fixtureId]);
      const end = events.find((event) => event.type === "episode_end");
      assert.ok(end, `${fixtureId} transcript missing terminal event`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("tolerant JSON extraction (policy v0.2) parses formatting, never content", () => {
  const good = JSON.stringify({ notes: "s", action: "up" });
  assert.deepEqual(extractJsonObject(good), JSON.parse(good));
  assert.deepEqual(
    extractJsonObject("```json\n" + good + "\n```"),
    JSON.parse(good),
    "fenced JSON must parse",
  );
  assert.deepEqual(
    extractJsonObject("Let me think. We are at turn 2.\n\n" + good + "\nI hope this helps."),
    JSON.parse(good),
    "prose-wrapped JSON must extract",
  );
  // Strings containing braces must not confuse the scanner.
  assert.deepEqual(
    extractJsonObject('note: use { or } carefully ' + good),
    JSON.parse(good),
  );
  // Truncated / malformed JSON still fails — nothing is repaired.
  assert.throws(() => extractJsonObject('{"a": 1, "b": [1, 2'));
  assert.throws(() => extractJsonObject('no json here at all'));
});

test("OpenAI adapter records attempts and never repairs invalid output", async () => {
  // Offline validation helpers.
  const validDecision = { estimated_position: { x: 0, y: 0 }, notes: "c", action: "up" };
  assert.equal(validateParsed(validDecision), null);
  assert.equal(validateParsed({ action: "sideways" }), "schema_violation");
  assert.equal(validateParsed({ ...validDecision, notes: "x".repeat(281) }), "schema_violation");
  assert.equal(validateParsed({ ...validDecision, estimated_position: { x: 101, y: 0 } }), "schema_violation");
  assert.equal(validateParsed({ ...validDecision, extra: true }), "schema_violation");
  assert.equal(validateParsed({ ...validDecision, estimated_position: { x: 0, y: 0, extra: true } }), "schema_violation");
  assert.deepEqual(extractOutputText({ output_text: "{\"a\":1}" }), { text: "{\"a\":1}", refusal: null });
  assert.deepEqual(extractOutputText({ output: [{ content: [{ type: "refusal", refusal: "no" }] }] }), { text: null, refusal: "no" });

  // A 500 then success: transport retry allowed, both attempts recorded.
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { code: "server_error", message: "boom" } }), { status: 500 });
    }
    return new Response(JSON.stringify(openAIResponse({
      id: "resp_1",
      usage: {
        input_tokens: 5, output_tokens: 5, total_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      text: JSON.stringify({
        estimated_position: { x: 0, y: 0 }, notes: "c",
        action: "up",
      }),
    })), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_1" } });
  };
  const adapter = createOpenAIAdapter("test-key-not-a-secret", {
    fetchImpl,
    timeoutMs: 1000,
    retryDelayImpl: async () => {},
    pacingMs: 0,
  });
  const result = await adapter({ turn: 1, observation: {}, conversation: [] });
  assert.equal(calls.length, 2);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].errorCategory, "server_error");
  assert.equal(result.attempts[1].errorCategory, null);
  assert.equal(result.error, null);
  assert.equal(result.parsed.action, "up");
  assert.equal(calls[0].model, "gpt-5.6-luna");

  // Invalid JSON output: recorded, NOT retried.
  /** @type {number} */
  let invalidCalls = 0;
  const invalidFetch = async () => {
    invalidCalls += 1;
    return new Response(JSON.stringify(openAIResponse({
      id: "resp_2", text: "not json at all",
    })), { status: 200, headers: { "content-type": "application/json" } });
  };
  const invalidAdapter = createOpenAIAdapter("test-key-not-a-secret", { fetchImpl: invalidFetch, timeoutMs: 1000, pacingMs: 0 });
  const invalidResult = await invalidAdapter({ turn: 1, observation: {}, conversation: [] });
  assert.equal(invalidCalls, 1, "invalid model output must not consume a transport retry");
  assert.equal(invalidResult.parsed, null);
  assert.equal(invalidResult.error.category, "invalid_response");
  assert.equal(invalidResult.attempts[0].errorCategory, "invalid_structured_json");

  // Missing API key fails fast and never leaks the key into errors.
  assert.throws(() => createOpenAIAdapter(""));
});

test("field normalization re-keys aliases without inventing content", () => {
  assert.deepEqual(
    normalizeDecisionFields({ navigationNote: "c", positionEstimate: { x: 0, y: 0 }, direction: "up" }),
    { notes: "c", estimated_position: { x: 0, y: 0 }, action: "up" },
  );
  assert.deepEqual(
    normalizeDecisionFields({ coordinateNote: "c", believedPosition: { x: 1, y: 2 }, move: "left" }),
    { notes: "c", estimated_position: { x: 1, y: 2 }, action: "left" },
  );
  // Canonical field wins over alias.
  const both = normalizeDecisionFields({ notes: "canonical", note: "alias" });
  assert.equal(both.notes, "canonical");
  // Missing content still fails validation after normalization.
  assert.equal(validateParsed(normalizeDecisionFields({ note: "n" })), "schema_violation");
  const unknown = normalizeDecisionFields({
    notes: "c",
    estimated_position: { x: 0, y: 0 },
    action: "up",
    extra: true,
  });
  assert.equal(unknown.extra, true);
  assert.equal(validateParsed(unknown), "schema_violation");
  // Non-objects pass through untouched.
  assert.deepEqual(normalizeDecisionFields(null), null);
});

test("OpenAI adapter forwards requested model and doubles incomplete-output budget", async () => {
  /** @type {any[]} */
  const bodies = [];
  /** @type {any[]} */
  const delays = [];
  const requestedModel = "gpt-5.6-sol";
  const good = JSON.stringify({
    estimated_position: { x: 0, y: 0 }, notes: "c",
    action: "up",
  });
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response(JSON.stringify(openAIResponse({
        id: "resp_1", status: "incomplete", model: "actual-model-a",
      })), {
        status: 200,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify(openAIResponse({
      id: "resp_2", model: "actual-model-b", text: good,
    })), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = createOpenAIAdapter("test-key-not-a-secret", {
    fetchImpl,
    model: requestedModel,
    timeoutMs: 1000,
    retryDelayImpl: async (...args) => delays.push(args),
    pacingMs: 0,
  });
  const result = await adapter({ turn: 1, observation: {}, conversation: [] });

  assert.deepEqual(bodies.map((body) => body.model), [requestedModel, requestedModel]);
  assert.deepEqual(bodies.map((body) => body.max_output_tokens), [2000, 4000]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.modelReturned), ["actual-model-a", "actual-model-b"]);
  assert.equal(result.attempts[0].modelRequested, requestedModel);
  assert.equal(delays.length, 1);
  assert.equal(delays[0][0], "0");
  assert.equal(result.error, null);
});

test("resume refuses incompatible manifests and preserves the original metadata", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "emz-resume-test-"));
  try {
    await runBatch({
      dryRun: true,
      batchId: "resume-test",
      outDir: tempDir,
      commit: "source-a",
      suiteSeed: "resume-suite",
      mazesPerTier: 1,
    });
    const manifestPath = path.join(tempDir, "manifest.json");
    const before = await readFile(manifestPath, "utf8");

    await assert.rejects(
      () => runBatch({
        dryRun: true,
        outDir: tempDir,
        resume: true,
        model: "openai/gpt-5.6-luna",
        commit: "source-b",
      }),
      /manifest is incompatible.*modelRequested/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), before);

    const resumed = await runBatch({
      dryRun: true,
      outDir: tempDir,
      resume: true,
      model: "gpt-5.6-luna",
      commit: "source-a",
    });
    assert.equal(resumed.outcomes.filter((outcome) => outcome.skipped).length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("an expanded suite reuses matching published episodes and runs only new fixtures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "emz-public-reuse-test-"));
  const firstDir = path.join(root, "first");
  const expandedDir = path.join(root, "expanded");
  const publicDir = path.join(root, "public-replay-data");
  try {
    await runBatch({
      dryRun: true,
      batchId: "reuse-first",
      outDir: firstDir,
      suiteSeed: "reuse-suite",
      mazesPerTier: 1,
      reusePublic: false,
    });
    const manifest = JSON.parse(await readFile(path.join(firstDir, "manifest.json"), "utf8"));
    const fixtures = generateFixtureSuite("reuse-suite", 1);
    await mkdir(path.join(publicDir, "runs"), { recursive: true });
    for (const fixture of fixtures) {
      const raw = await readFile(
        path.join(firstDir, "episodes", fixture.fixtureId, "transcript.jsonl"),
        "utf8",
      );
      const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const transcript = encodeReusableTranscript(events);
      const identity = publishedEpisodeIdentity(manifest, fixture);
      const detail = {
        benchmark: { reuse: {
          identity,
          identityHash: publishedEpisodeIdentityHash(manifest, fixture),
          transcriptHash: sha256(transcript),
          transcript,
        } },
        run: { id: `published--${fixture.fixtureId}`, updatedAt: 1 },
      };
      await writeFile(
        path.join(publicDir, "runs", `${fixture.fixtureId}.json`),
        `${JSON.stringify(detail)}\n`,
      );
    }

    const expanded = await runBatch({
      dryRun: true,
      batchId: "reuse-expanded",
      outDir: expandedDir,
      suiteSeed: "reuse-suite",
      mazesPerTier: 2,
      publicReplayDir: publicDir,
    });
    assert.equal(expanded.outcomes.length, 6);
    assert.equal(expanded.outcomes.filter((outcome) => outcome.reused).length, 3);
    assert.deepEqual(
      expanded.outcomes.filter((outcome) => outcome.reused).map((outcome) => outcome.fixtureId),
      ["emz-v0-easy-001", "emz-v0-medium-001", "emz-v0-hard-001"],
    );
    assert.equal(expanded.summary.recordedEpisodes, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenRouter adapter retries length-truncated output with doubled budget", async () => {
  /** @type {any[]} */
  const bodies = [];
  const good = JSON.stringify({
    estimated_position: { x: 0, y: 0 }, notes: "c",
    action: "up",
  });
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({
        id: "gen_1", model: "m", usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 },
        choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"notes":' } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: "gen_2", model: "m", usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: good } }],
    }), { status: 200 });
  };
  const requestedModel = "openrouter/test-model";
  const adapter = createOpenRouterAdapter("test-key-not-a-secret", {
    fetchImpl,
    model: requestedModel,
    reasoningEffort: "medium",
    retryDelayImpl: async () => {},
    pacingMs: 0,
    timeoutMs: 1000,
  });
  const result = await adapter({ turn: 1, observation: {}, conversation: [] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 2000);
  assert.equal(bodies[1].max_tokens, 4000);
  assert.deepEqual(bodies.map((body) => body.reasoning), [
    { effort: "medium" },
    { effort: "medium" },
  ]);
  assert.equal(result.attempts[0].errorCategory, "incomplete_output");
  assert.deepEqual(result.attempts.map((attempt) => attempt.modelRequested), [requestedModel, requestedModel]);
  assert.equal(result.error, null);
  assert.equal(result.parsed.action, "up");
});

test("retry policy honors Retry-After and bounded exponential fallback", () => {
  assert.equal(computeRetryDelayMs("3", 1), 3000);
  assert.equal(computeRetryDelayMs("1m30s", 1), 90000);
  assert.equal(parseDurationMs("2m3.5s"), 123500);
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(computeRetryDelayMs(null, 2, 2000, 0), 4000);
  assert.equal(computeRetryDelayMs(null, 10, 2000, 0), 120000);
});

test("OpenAI exhausted 429s are infrastructure interruptions with quota diagnostics", async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: { code: "rate_limit_exceeded", type: "tokens", message: "Please retry later." },
    }), {
      status: 429,
      headers: {
        "retry-after": "0",
        "x-request-id": `req_${calls}`,
        "x-ratelimit-limit-tokens": "250000",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "30s",
      },
    });
  };
  const adapter = createOpenAIAdapter("test-key-not-a-secret", {
    fetchImpl,
    timeoutMs: 1000,
    retryDelayImpl: async (...args) => delays.push(args),
    pacingMs: 0,
  });
  const result = await adapter({ turn: 1, observation: {}, conversation: [] });
  assert.equal(calls, 4);
  assert.equal(delays.length, 3);
  assert.equal(result.error.category, "infra_interrupted");
  assert.equal(result.attempts[0].rateLimit.remainingTokens, "0");
  assert.equal(result.attempts[0].providerError.message, "Please retry later.");
  assert.equal(result.attempts[0].requestId, "req_1");
});

test("rate-limit header extraction omits an empty diagnostic object", () => {
  assert.equal(extractRateLimitHeaders(new Headers()), null);
  assert.equal(
    extractRateLimitHeaders(new Headers({ "x-ratelimit-reset-requests": "1s" })).resetRequests,
    "1s",
  );
});

test("OpenAI pacing uses provider token limits when available", () => {
  assert.equal(computePacingDelayMs(null, null, 5000), 5000);
  assert.equal(computePacingDelayMs({ input_tokens: 40_000 }, { limitTokens: "200000" }, 5000), 15000);
  assert.equal(computePacingDelayMs({ input_tokens: 1_000 }, { limitTokens: "200000" }, 5000), 5000);
});

test("infrastructure interruptions do not lower benchmark success rate", () => {
  const scored = {
    status: "solved", solved: true, spl: 1, pathEfficiency: 1,
    attemptedTurns: 1, validActions: 1, successfulMoves: 1, wallHits: 0,
    invalidResponses: 0, apiFailures: 0, infraInterruptions: 0, retryAttempts: 0,
    tokens: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
  };
  const interrupted = {
    ...scored, status: "infra_interrupted", solved: false, spl: 0, pathEfficiency: null,
    infraInterruptions: 1,
  };
  const batch = computeBatchMetrics([scored, interrupted]);
  assert.equal(batch.recordedEpisodes, 2);
  assert.equal(batch.totalEpisodes, 1);
  assert.equal(batch.successRate, 1);
  assert.equal(batch.totals.infraInterruptions, 1);
});

test("retry delay does not subtract request latency from Retry-After", async () => {
  /** @type {number[]} */
  const waits = [];
  await retryDelay("3", 1, 2000, async (waitMs) => waits.push(waitMs));
  assert.deepEqual(waits, [3000]);
});

test("mock adapter state cannot leak across episodes", async () => {
  const fixtures = generateFixtureSuite("isolation-suite", 1);
  const first = await runEpisode({
    fixture: fixtures[0],
    maxTurns: MAX_TURNS,
    adapter: createMockAdapter(),
    onEvent: () => {},
  });
  const second = await runEpisode({
    fixture: fixtures[0],
    maxTurns: MAX_TURNS,
    adapter: createMockAdapter(),
    onEvent: () => {},
  });
  // Fresh adapter state: identical deterministic replay.
  assert.equal(first.status, second.status);
  assert.equal(first.turns, second.turns);
});
