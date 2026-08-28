/**
 * One-time authoring script for Echo Maze Benchmark v0 fixtures.
 *
 * Generates the 10 frozen maze snapshots from the fixed contract seeds and
 * writes them to benchmark/fixtures/. Seeds are provenance only: after these
 * files exist, the benchmark runtime loads snapshots and never re-rolls.
 *
 * Usage: node benchmark/scripts/generate-fixtures.mjs [--force]
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateMaze, seededRandom } from "../../lib/maze/index.js";
import { FIXTURE_IDS, FIXTURE_SEEDS } from "../contract.js";
import { MIN_ROUTE_LENGTH } from "../../lib/maze/types.js";
import { computeFixtureHash, fixtureFromMaze } from "../fixtures.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const force = process.argv.includes("--force");

await mkdir(fixturesDir, { recursive: true });
const existing = new Set(await readdir(fixturesDir));

for (let index = 0; index < FIXTURE_SEEDS.length; index += 1) {
  const seed = FIXTURE_SEEDS[index];
  const fixtureId = FIXTURE_IDS[index];
  const fileName = `${fixtureId}.json`;
  if (existing.has(fileName) && !force) {
    console.log(`skip (exists): ${fileName}`);
    continue;
  }
  // Deterministic generation from the seed; identical to UI maze semantics.
  const maze = generateMaze(seededRandom(seed), seed, {
    size: 9,
    minRouteLength: MIN_ROUTE_LENGTH,
  });
  const fixture = fixtureFromMaze(maze, fixtureId);
  if (computeFixtureHash(fixture) !== fixture.fixtureHash) {
    throw new Error(`hash self-check failed for ${fixtureId}`);
  }
  await writeFile(path.join(fixturesDir, fileName), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(
    `wrote ${fileName} start=(${fixture.start.r},${fixture.start.c}) exit=(${fixture.exit.r},${fixture.exit.c}) optimal=${fixture.optimalPathLength}`,
  );
}
