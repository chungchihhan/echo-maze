/**
 * Convert a completed benchmark batch into compact, public replay assets.
 *
 * Usage:
 *   node benchmark/publish-replays.js results/<batch> [--out public/replay-data]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureCells, loadFixture } from "./fixtures.js";
import {
  BENCHMARK_NAME,
  BENCHMARK_SHORT_NAME,
  BENCHMARK_THEME,
} from "../lib/benchmark-brand.js";
import {
  encodeReusableTranscript,
  publishedEpisodeIdentity,
  publishedEpisodeIdentityHash,
} from "./published-reuse.js";
import { sha256 } from "./contract.js";

const THINK_FRAME_MS = 2200;
const MOVE_FRAME_MS = 6800;
const END_HOLD_MS = 4000;

function parseArgs(argv) {
  const source = argv[0];
  if (!source) throw new Error("Usage: node benchmark/publish-replays.js results/<batch> [--out public/replay-data]");
  let out = "public/replay-data";
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--out") out = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { source: path.resolve(source), out: path.resolve(out) };
}

function parseJsonLines(raw) {
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function publicEvents(events) {
  const output = [];
  let sequence = 0;
  for (const event of events) {
    if (event.type === "turn_start") {
      output.push({
        sequence: ++sequence,
        createdAt: 0,
        turn: event.turn,
        phase: "walker_think",
        type: "agent_request",
        payload: { role: "solo_walker", turn: event.turn, observation: event.observation },
      });
      continue;
    }
    if (event.type === "model_result" && event.parsed) {
      output.push({
        sequence: ++sequence,
        createdAt: 0,
        turn: event.turn,
        phase: "walker_think",
        type: "solo_walker_response",
        payload: {
          turn: event.turn,
          estimatedPosition: event.parsed.estimated_position ?? event.parsed.position_estimate ?? event.parsed.believed_position,
          notes: event.parsed.notes ?? event.parsed.navigation_note ?? event.parsed.coordinate_note,
          action: event.parsed.action ?? event.parsed.direction,
        },
      });
      continue;
    }
    if (event.type === "model_result" && !event.parsed) {
      output.push({
        sequence: ++sequence,
        createdAt: 0,
        turn: event.turn,
        phase: "walker_think",
        type: "agent_error",
        payload: { error: event.errorCategory ?? "Agent response unavailable" },
      });
      continue;
    }
    if (event.type === "move") {
      output.push({
        sequence: ++sequence,
        createdAt: 0,
        turn: event.turn,
        phase: "walker_move",
        type: "solo_walker_move",
        payload: {
          direction: event.direction,
          result: event.result,
          from: event.from,
          to: event.to,
          relativePosition: event.relativePosition,
          won: event.won,
        },
      });
    }
  }
  return output;
}

function playbackDurationMs(events) {
  const durations = [THINK_FRAME_MS];
  for (const event of events) {
    if (event.type === "solo_walker_response") durations.push(MOVE_FRAME_MS);
    else if (event.type === "solo_walker_move" || event.type === "environment_move" || event.type === "agent_error") {
      durations.push(THINK_FRAME_MS);
    }
  }
  durations[durations.length - 1] = END_HOLD_MS;
  return durations.reduce((total, duration) => total + duration, 0);
}

function publishedStatus(summary, transcript) {
  if (summary.status !== "api_failure") return summary.status;
  const lastModelResult = transcript.filter((event) => event.type === "model_result").at(-1);
  const lastCategory = lastModelResult?.attempts?.at(-1)?.errorCategory;
  return lastCategory === "rate_limit_exceeded" || lastCategory === "http_429"
    ? "infra_interrupted"
    : summary.status;
}

async function main() {
  const { source, out } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  await mkdir(path.join(out, "runs"), { recursive: true });
  const runs = [];
  let existingRuns = [];
  let existingCuration = new Map();
  try {
    const existingIndex = JSON.parse(await readFile(path.join(out, "index.json"), "utf8"));
    existingRuns = existingIndex.runs ?? [];
    existingCuration = new Map(existingRuns.map((run) => [run.id, {
      featured: run.featured,
      homepageOrder: run.homepage_order,
    }]));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let nextHomepageOrder = existingRuns.reduce(
    (highest, run) => Math.max(highest, Number.isFinite(run.homepage_order) ? run.homepage_order : 0),
    0,
  ) + 1;

  for (const fixtureId of manifest.fixtureOrder ?? []) {
    const episodeDir = path.join(source, "episodes", fixtureId);
    const [rawTranscript, rawSummary, fixture] = await Promise.all([
      readFile(path.join(episodeDir, "transcript.jsonl"), "utf8"),
      readFile(path.join(episodeDir, "episode-summary.json"), "utf8"),
      loadFixture(source, fixtureId),
    ]);
    const transcript = parseJsonLines(rawTranscript);
    const reuseTranscript = encodeReusableTranscript(transcript);
    const summary = JSON.parse(rawSummary);
    const events = publicEvents(transcript);
    const playbackDuration = playbackDurationMs(events);
    const id = `${manifest.batchId}--${fixtureId}`;
    const curation = existingCuration.get(id);
    const status = publishedStatus(summary, transcript);
    const startedAt = transcript.find((event) => event.type === "episode_start")?.startedAt ?? manifest.createdAt;
    const endedAt = transcript.find((event) => event.type === "episode_end")?.endedAt ?? startedAt;
    const detail = {
      version: 3,
      source: "benchmark",
      benchmark: {
        batchId: manifest.batchId,
        benchmarkName: manifest.benchmarkName ?? BENCHMARK_NAME,
        benchmarkShortName: manifest.benchmarkShortName ?? BENCHMARK_SHORT_NAME,
        benchmarkTheme: manifest.benchmarkTheme ?? BENCHMARK_THEME,
        benchmarkVersion: manifest.benchmarkVersion,
        policyRevision: manifest.policyRevision,
        reasoningEffort: manifest.reasoningEffort ?? null,
        resultClass: manifest.resultClass,
        provider: manifest.provider,
        originalStatus: summary.status,
        playbackDurationMs: playbackDuration,
        reuse: {
          identity: publishedEpisodeIdentity(manifest, fixture),
          identityHash: publishedEpisodeIdentityHash(manifest, fixture),
          transcriptHash: sha256(reuseTranscript),
          transcript: reuseTranscript,
        },
      },
      run: {
        id,
        createdAt: startedAt,
        updatedAt: endedAt,
        status,
        model: manifest.modelReturned ?? manifest.modelRequested,
        mazeSeed: fixtureId,
        maze: {
          cells: fixtureCells(fixture),
          start: fixture.start,
          exit: fixture.exit,
          routeLength: fixture.optimalPathLength,
          seed: fixture.seed,
        },
        initialPosition: fixture.start,
      },
      metrics: {
        attemptedTurns: summary.metrics.attemptedTurns,
        successfulMoves: summary.metrics.successfulMoves,
        wallHits: summary.metrics.wallHits,
        invalidResponses: summary.metrics.invalidResponses,
        apiFailures: summary.metrics.apiFailures,
        retryAttempts: summary.metrics.retryAttempts,
        optimalPathLength: summary.metrics.optimalPathLength,
        pathEfficiency: summary.metrics.pathEfficiency,
        spl: summary.metrics.spl,
      },
      events,
    };
    await writeFile(path.join(out, "runs", `${id}.json`), `${JSON.stringify(detail)}\n`);
    runs.push({
      id,
      created_at: startedAt,
      updated_at: endedAt,
      status,
      model: detail.run.model,
      maze_seed: fixtureId,
      event_count: events.length,
      max_turn: summary.turns,
      had_error: status === "invalid_output" || status === "api_failure" || status === "infra_interrupted" ? 1 : 0,
      successful_moves: summary.metrics.successfulMoves,
      wall_hits: summary.metrics.wallHits,
      spl: summary.metrics.spl,
      batch_id: manifest.batchId,
      suite_seed: manifest.suiteSeed,
      policy_revision: manifest.policyRevision,
      reasoning_effort: manifest.reasoningEffort ?? null,
      playback_duration_ms: playbackDuration,
      featured: curation?.featured ?? true,
      homepage_order: curation?.homepageOrder ?? nextHomepageOrder++,
    });
  }

  const mergedRuns = mergePublishedRuns(existingRuns, runs);
  await writeFile(path.join(out, "index.json"), `${JSON.stringify({ version: 1, runs: mergedRuns }, null, 2)}\n`);
  console.log(`Published ${runs.length} replay(s) from ${manifest.batchId} to ${out} (${mergedRuns.length} indexed total)`);
}

export function mergePublishedRuns(existingRuns, publishedRuns) {
  const publishedIds = new Set(publishedRuns.map((run) => run.id));
  return [
    ...existingRuns.filter((run) => !publishedIds.has(run.id)),
    ...publishedRuns,
  ].sort((left, right) => {
    const leftOrder = Number.isFinite(left.homepage_order) ? left.homepage_order : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(right.homepage_order) ? right.homepage_order : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
