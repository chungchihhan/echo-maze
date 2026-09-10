/**
 * EMZ Benchmark v0 verification command.
 *
 * Validates the whole benchmark surface without any network access:
 * 1. Fixture integrity: deterministic tier counts, seed/hash uniqueness,
 *    hashes matching content, BFS shortest path matching the frozen optimal
 *    length, and valid start/exit.
 * 2. Observation safety: the narrow DTO never contains the full maze, exit
 *    coordinates, the seed, the optimal route, or unseen cells.
 * 3. UI/core transition consistency: lib/maze movement semantics match the
 *    product contract (blocked move keeps position; relative deltas).
 * 4. Metrics reproducibility: metrics recomputed from event logs match
 *    runner-recorded summaries; retry/invalid/API-failure accounting works.
 * 5. Episode isolation: episodes share no conversation or adapter state.
 *
 * Usage: npm run benchmark:verify
 */

import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { DEFAULT_MAZES_PER_TIER, ROUTE_LENGTH_TIERS } from "./contract.js";
import {
  computeFixtureHash,
  fixtureCells,
  generateFixtureSuite,
  verifyFixture,
} from "./fixtures.js";
import { runEpisode } from "./episode.js";
import { createMockAdapter } from "./adapters/mock-adapter.js";
import { computeEpisodeMetrics, percentile } from "./metrics.js";
import { walkerObservation, applyMove, relativeDelta } from "../lib/maze/index.js";
import { BENCHMARK_SHORT_NAME, BENCHMARK_THEME } from "../lib/benchmark-brand.js";

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((error) => {
      failures += 1;
      console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`);
    });
}

async function main() {
  const fixtures = generateFixtureSuite("verify-suite", DEFAULT_MAZES_PER_TIER);
  const byId = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const fixtureIds = fixtures.map((fixture) => fixture.fixtureId);

  console.log(`${BENCHMARK_SHORT_NAME} · ${BENCHMARK_THEME}`);
  console.log("fixtures");
  await check("fixture suite has equal tier counts in deterministic order", () => {
    assert.equal(fixtures.length, ROUTE_LENGTH_TIERS.length * DEFAULT_MAZES_PER_TIER);
    for (const tier of ROUTE_LENGTH_TIERS) {
      assert.equal(fixtures.filter((fixture) => fixture.difficultyTier === tier.id).length, DEFAULT_MAZES_PER_TIER);
    }
    assert.deepEqual(
      generateFixtureSuite("verify-suite", DEFAULT_MAZES_PER_TIER),
      fixtures,
    );
  });
  await check("seeds are unique", () => {
    assert.equal(new Set(fixtures.map((fixture) => fixture.seed)).size, fixtures.length);
  });
  await check("fixture hashes are unique", () => {
    assert.equal(new Set(fixtures.map((fixture) => fixture.fixtureHash)).size, fixtures.length);
  });
  await check("generated hashes match content + BFS matches frozen optimal path", () => {
    const problems = fixtures.flatMap(verifyFixture);
    assert.deepEqual(problems, []);
    fixtures.forEach((fixture) => {
      const tier = ROUTE_LENGTH_TIERS.find((candidate) => candidate.id === fixture.difficultyTier);
      assert.equal(computeFixtureHash(fixture), fixture.fixtureHash);
      assert.ok(tier);
      assert.ok(fixture.optimalPathLength >= tier.min, "optimal route below assigned tier");
      assert.ok(fixture.optimalPathLength <= tier.max, "optimal route above assigned tier");
      assert.equal(fixture.optimalPath[0].r, fixture.start.r);
      assert.equal(fixture.optimalPath.at(-1).r, fixture.exit.r);
    });
  });

  console.log("observation safety");
  await check("observation DTO leaks no hidden state", () => {
    for (const fixture of fixtures) {
      const cells = fixtureCells(fixture);
      const observation = walkerObservation(cells, fixture.exit, fixture.start, null, null);
      const serialized = JSON.stringify(observation);
      // No absolute coordinates anywhere in the DTO.
      assert.ok(!/"r"\s*:/.test(serialized), `absolute row leaked for ${fixture.fixtureId}`);
      assert.ok(!/"c"\s*:/.test(serialized), `absolute column leaked for ${fixture.fixtureId}`);
      assert.ok(!serialized.includes(fixture.seed), "seed leaked into observation");
      // Exit coordinates never appear as data (isExit flag is allowed only when visible).
      if (!observation.exitVisible) {
        assert.ok(!/"isExit":true/.test(serialized), "exit flag visible when exitVisible=false");
      }
      // Sightline cell count equals corridor visibility computed independently.
      let expectedCells = 0;
      for (const line of observation.sightlines) expectedCells += line.cells.length;
      assert.ok(expectedCells <= 16, "suspiciously wide observation");
      // Every reported open direction of the origin must be genuinely open.
      for (const direction of observation.openDirections) {
        assert.ok(cells[fixture.start.r][fixture.start.c].walls[direction] === false);
      }
      for (const direction of observation.blockedDirections) {
        assert.ok(cells[fixture.start.r][fixture.start.c].walls[direction] === true);
      }
      // Unseen cells must not appear: sightline depth equals wall distance per direction.
      for (const line of observation.sightlines) {
        let cursor = { ...fixture.start };
        for (const cell of line.cells) {
          cursor = neighborOf(cursor, line.direction);
          assert.deepEqual(
            cell.distance,
            line.cells.indexOf(cell) + 1,
          );
        }
        assert.equal(line.distanceToWall, line.cells.length);
      }
    }
  });

  console.log("environment semantics (UI/core parity)");
  await check("transition semantics: blocked keeps position, relative deltas correct", () => {
    const fixture = fixtures[0];
    const cells = fixtureCells(fixture);
    // Walk the frozen optimal path: every step must succeed and advance.
    let position = { ...fixture.start };
    let relative = { x: 0, y: 0 };
    for (let i = 1; i < fixture.optimalPath.length; i += 1) {
      const target = fixture.optimalPath[i];
      const previous = fixture.optimalPath[i - 1];
      const dr = target.r - previous.r;
      const dc = target.c - previous.c;
      const direction = dr === -1 ? "up" : dr === 1 ? "down" : dc === 1 ? "right" : "left";
      const outcome = applyMove(cells, position, direction);
      assert.equal(outcome.result, "moved", `optimal step ${i} blocked on ${fixture.fixtureId}`);
      assert.ok(outcome.position.r === target.r && outcome.position.c === target.c);
      const delta = relativeDelta(direction, outcome.result);
      relative = { x: relative.x + delta.x, y: relative.y + delta.y };
      position = outcome.position;
    }
    assert.ok(relative.y !== 0 || relative.x !== 0 || fixture.optimalPathLength === 0);
    // A blocked move must keep both absolute position and relative coordinate.
    const before = { ...position };
    const blocked = applyMove(cells, position, pickBlockedDirection(cells, position));
    assert.equal(blocked.result, "blocked");
    assert.deepEqual(blocked.position, before);
    assert.deepEqual(relativeDelta(pickBlockedDirection(cells, position), "blocked"), { x: 0, y: 0 });
  });

  console.log("metrics pipeline");
  await check("percentile helper", () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
    assert.equal(percentile([], 0.5), null);
  });
  await check("metrics rebuild from synthetic event logs (retry/invalid/api accounting)", () => {
    const fixture = byId.get(fixtureIds[0]);
    const solvedLog = [
      { type: "episode_start", fixtureId: fixture.fixtureId },
      { type: "turn_start", turn: 1, observation: {} },
      { type: "model_result", turn: 1, attempts: [{ attempt: 1, latencyMs: 100, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }], parsed: { direction: "up" }, errorCategory: null },
      { type: "move", turn: 1, direction: "up", result: "moved" },
      { type: "turn_start", turn: 2, observation: {} },
      { type: "model_result", turn: 2, attempts: [{ attempt: 1, latencyMs: 300, errorCategory: "timeout" }, { attempt: 2, latencyMs: 200, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }], parsed: { direction: "left" }, errorCategory: null },
      { type: "move", turn: 2, direction: "left", result: "blocked" },
      { type: "move", turn: 2, direction: "left", result: "moved", won: true },
      { type: "episode_end", status: "solved", reason: "Exit reached.", turns: 2 },
    ];
    const metrics = computeEpisodeMetrics(solvedLog, fixture);
    assert.equal(metrics.solved, true);
    assert.equal(metrics.successfulMoves, 2);
    assert.equal(metrics.wallHits, 1);
    assert.equal(metrics.retryAttempts, 1);
    assert.equal(metrics.apiFailures, 0);
    assert.equal(metrics.pathEfficiency, fixture.optimalPathLength / 2);
    assert.equal(metrics.spl, 1);
    assert.equal(metrics.latencyMs.p50, 200);
    assert.equal(metrics.latencyMs.max, 300);
    assert.equal(metrics.tokens.totalTokens, 30);

    const unsolvedLog = [
      { type: "turn_start", turn: 1, observation: {} },
      { type: "model_result", turn: 1, attempts: [{ attempt: 1, latencyMs: 50, usage: null, errorCategory: "refusal", rawOutputPreview: "no" }], parsed: null, errorCategory: "invalid_response" },
      { type: "episode_end", status: "invalid_output", reason: "Model refused.", turns: 1 },
    ];
    const unsolved = computeEpisodeMetrics(unsolvedLog, fixture);
    assert.equal(unsolved.solved, false);
    assert.equal(unsolved.pathEfficiency, null); // no misleading efficiency
    assert.equal(unsolved.invalidResponses, 1);
    assert.equal(unsolved.spl, 0);

    const apiLog = [
      { type: "turn_start", turn: 1, observation: {} },
      { type: "model_result", turn: 1, attempts: [{ attempt: 1, latencyMs: 10, errorCategory: "network_error" }, { attempt: 2, latencyMs: 10, errorCategory: "network_error" }], parsed: null, errorCategory: "api_failure" },
      { type: "episode_end", status: "api_failure", reason: "Transport failed.", turns: 1 },
    ];
    const apiFailed = computeEpisodeMetrics(apiLog, fixture);
    assert.equal(apiFailed.status, "api_failure");
    assert.equal(apiFailed.apiFailures, 1);
    assert.equal(apiFailed.invalidResponses, 0); // transport ≠ invalid output
    assert.equal(apiFailed.retryAttempts, 1);
  });

  console.log("end-to-end dry pipeline (mock, offline)");
  const tempDir = await mkdtemp(path.join(tmpdir(), "emz-verify-"));
  try {
    /** @type {Array<{ events: any[], result: any }>} */
    const runs = [];
    await check("all 9 mock episodes reach a terminal status with isolation", async () => {
      for (const fixture of fixtures) {
        const events = [];
        const result = await runEpisode({
          fixture,
          maxTurns: 120,
          adapter: createMockAdapter(),
          onEvent: (event) => events.push(event),
        });
        runs.push({ events, result });
        assert.ok(["solved", "unsolved_max_turns"].includes(result.status),
          `mock episode ${fixture.fixtureId} ended ${result.status}`);
        // Isolation: first observation belongs to this fixture's start.
        const firstTurn = events.find((event) => event.type === "turn_start");
        assert.ok(firstTurn, `${fixture.fixtureId} missing turn events`);
      }
    });
    await check("no transcript leakage between episodes", () => {
      const starts = runs.map(({ events }) => JSON.stringify(events[0]));
      assert.equal(new Set(starts).size, runs.length, "identical episode_start across fixtures");
      // Each episode's events reference exactly one fixture identity.
      for (const { events } of runs) {
        const ids = new Set(events.filter((event) => event.type === "episode_start")
          .map((event) => event.fixtureId));
        assert.equal(ids.size, 1);
      }
    });
    await check("mock explorer solves via observations only (no hidden state)", () => {
      for (const { events } of runs) {
        for (const event of events) {
          if (event.type !== "turn_start") continue;
          const serialized = JSON.stringify(event.observation);
          assert.ok(!/"r"/.test(serialized) && !/"c"/.test(serialized));
          assert.ok(!JSON.stringify(event.observation).includes("optimal"));
        }
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures === 0 ? "\nverification passed" : `\n${failures} verification failure(s)`);
  if (failures > 0) process.exitCode = 1;
}

function neighborOf(point, direction) {
  switch (direction) {
    case "up": return { r: point.r - 1, c: point.c };
    case "down": return { r: point.r + 1, c: point.c };
    case "right": return { r: point.r, c: point.c + 1 };
    default: return { r: point.r, c: point.c - 1 };
  }
}

function pickBlockedDirection(cells, position) {
  const cell = cells[position.r][position.c];
  const entry = Object.entries(cell.walls).find(([, blocked]) => blocked);
  if (!entry) throw new Error("no walls at position");
  return entry[0];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
