/**
 * Seeded benchmark fixture generation, persistence, loading, and verification.
 *
 * Every batch generates its own stratified suite, then freezes the complete
 * snapshots inside that batch's artifacts for resume, summary, and replay.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { canMove, generateMaze, seededRandom, shortestPath, samePoint } from "../lib/maze/index.js";
import { BENCHMARK_FIXTURE_PREFIX } from "../lib/benchmark-brand.js";
import {
  BENCHMARK_VERSION,
  GENERATOR_VERSION,
  MAX_MAZES_PER_TIER,
  ROUTE_LENGTH_TIERS,
  sha256,
} from "./contract.js";

/** @typedef {import("../lib/maze/types.js").Point} Point */
const LEGACY_FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Frozen maze snapshot on disk.
 *
 * @typedef {{
 *   fixtureId: string,
 *   seed: string,
 *   generatorVersion: string,
 *   benchmarkVersion: string,
 *   difficultyTier: "easy"|"medium"|"hard",
 *   width: number,
 *   height: number,
 *   start: Point,
 *   exit: Point,
 *   walls: Array<Array<{ up: boolean, right: boolean, down: boolean, left: boolean }>>,
 *   optimalPathLength: number,
 *   optimalPath: Point[],
 *   fixtureHash: string,
 * }} MazeFixture
 */

function fixturePath(batchDir, fixtureId) {
  return path.join(batchDir, "fixtures", `${fixtureId}.json`);
}

/**
 * @param {string} batchDir
 * @param {string} fixtureId
 * @returns {Promise<MazeFixture>}
 */
export async function loadFixture(batchDir, fixtureId) {
  const raw = await readFile(fixturePath(batchDir, fixtureId), "utf8").catch((error) => {
    if (error?.code !== "ENOENT") throw error;
    return readFile(path.join(LEGACY_FIXTURES_DIR, `${fixtureId}.json`), "utf8");
  });
  return JSON.parse(raw);
}

/**
 * Recompute the canonical hash over everything except the stored hash itself.
 *
 * @param {MazeFixture} fixture
 */
export function computeFixtureHash(fixture) {
  const { fixtureHash, ...rest } = fixture;
  void fixtureHash;
  return sha256(rest);
}

/** Load all batch-local fixtures in manifest order. */
export async function loadAllFixtures(batchDir, fixtureOrder) {
  return Promise.all(fixtureOrder.map((fixtureId) => loadFixture(batchDir, fixtureId)));
}

/** Generate one deterministic, stratified fixture suite. */
export function generateFixtureSuite(suiteSeed, mazesPerTier) {
  if (typeof suiteSeed !== "string" || suiteSeed.trim().length === 0) {
    throw new Error("suiteSeed must be a non-empty string.");
  }
  if (!Number.isInteger(mazesPerTier) || mazesPerTier < 1 || mazesPerTier > MAX_MAZES_PER_TIER) {
    throw new Error(`mazesPerTier must be an integer from 1 to ${MAX_MAZES_PER_TIER}.`);
  }

  return ROUTE_LENGTH_TIERS.flatMap((tier) =>
    Array.from({ length: mazesPerTier }, (_, index) => {
      const sequence = String(index + 1).padStart(3, "0");
      const fixtureId = `${BENCHMARK_FIXTURE_PREFIX}-${BENCHMARK_VERSION}-${tier.id}-${sequence}`;
      const mazeSeed = `${suiteSeed}:${tier.id}:${sequence}`;
      const maze = generateMaze(seededRandom(mazeSeed), mazeSeed, {
        size: 9,
        minRouteLength: tier.min,
        maxRouteLength: tier.max,
      });
      return fixtureFromMaze(maze, fixtureId, tier.id);
    }),
  );
}

/** Persist generated snapshots inside a batch artifact directory. */
export async function writeFixtureSuite(batchDir, fixtures) {
  const fixturesDir = path.join(batchDir, "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  await Promise.all(fixtures.map((fixture) =>
    writeFile(fixturePath(batchDir, fixture.fixtureId), `${JSON.stringify(fixture, null, 2)}\n`, "utf8")));
}

/**
 * Structural verification of one fixture. Returns a list of problems
 * (empty when valid).
 *
 * @param {MazeFixture} fixture
 * @returns {string[]}
 */
export function verifyFixture(fixture) {
  /** @type {string[]} */
  const problems = [];
  const size = fixture.width;

  if (fixture.generatorVersion !== GENERATOR_VERSION) {
    problems.push(`${fixture.fixtureId}: generatorVersion mismatch`);
  }
  if (fixture.benchmarkVersion !== BENCHMARK_VERSION) {
    problems.push(`${fixture.fixtureId}: benchmarkVersion mismatch`);
  }
  const tier = ROUTE_LENGTH_TIERS.find((candidate) => candidate.id === fixture.difficultyTier);
  if (!tier) {
    problems.push(`${fixture.fixtureId}: unknown difficultyTier`);
  } else if (
    fixture.optimalPathLength < tier.min ||
    fixture.optimalPathLength > tier.max
  ) {
    problems.push(
      `${fixture.fixtureId}: optimal route ${fixture.optimalPathLength} outside ${tier.id} tier ${tier.min}-${tier.max}`,
    );
  }
  if (fixture.walls.length !== size || fixture.walls.some((row) => row.length !== size)) {
    problems.push(`${fixture.fixtureId}: walls grid is not ${size}x${size}`);
    return problems;
  }
  if (!inGrid(fixture.start, size)) problems.push(`${fixture.fixtureId}: start out of grid`);
  if (!inGrid(fixture.exit, size)) problems.push(`${fixture.fixtureId}: exit out of grid`);
  if (samePoint(fixture.start, fixture.exit)) {
    problems.push(`${fixture.fixtureId}: start equals exit`);
  }
  if (computeFixtureHash(fixture) !== fixture.fixtureHash) {
    problems.push(`${fixture.fixtureId}: stored fixtureHash does not match content`);
  }

  if (problems.length === 0) {
    // Cross-check BFS against the frozen optimal path.
    const cells = fixtureCells(fixture);
    const path = shortestPath(cells, fixture.start, fixture.exit);
    if (path.length === 0) {
      problems.push(`${fixture.fixtureId}: exit unreachable from start`);
    } else {
      if (path.length - 1 !== fixture.optimalPathLength) {
        problems.push(
          `${fixture.fixtureId}: BFS optimal length ${path.length - 1} != frozen ${fixture.optimalPathLength}`,
        );
      }
      if (path.length !== fixture.optimalPath.length
        || path.some((point, index) => !samePoint(point, fixture.optimalPath[index]))) {
        problems.push(`${fixture.fixtureId}: frozen optimalPath differs from BFS path`);
      }
      for (let i = 1; i < fixture.optimalPath.length; i += 1) {
        const from = fixture.optimalPath[i - 1];
        const to = fixture.optimalPath[i];
        if (!stepIsOpen(cells, from, to)) {
          problems.push(`${fixture.fixtureId}: optimalPath step ${i} crosses a wall or bound`);
          break;
        }
      }
    }
  }
  return problems;
}

/**
 * Rebuild the runtime cell matrix from a fixture's frozen walls.
 *
 * @param {MazeFixture} fixture
 */
export function fixtureCells(fixture) {
  return fixture.walls.map((row, r) =>
    row.map((walls, c) => ({ r, c, walls: { ...walls } })),
  );
}

/**
 * Authoring helper: derive a full fixture record from a generated maze.
 *
 * @param {{ cells: import("../lib/maze/types.js").Cell[][], start: Point, exit: Point, routeLength: number, seed: string }} maze
 * @param {string} fixtureId
 * @param {"easy"|"medium"|"hard"} difficultyTier
 * @returns {MazeFixture}
 */
export function fixtureFromMaze(maze, fixtureId, difficultyTier) {
  const path = shortestPath(maze.cells, maze.start, maze.exit);
  const record = {
    fixtureId,
    seed: maze.seed,
    generatorVersion: GENERATOR_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
    difficultyTier,
    width: maze.cells.length,
    height: maze.cells.length,
    start: { ...maze.start },
    exit: { ...maze.exit },
    walls: maze.cells.map((row) => row.map((cell) => ({ ...cell.walls }))),
    optimalPathLength: Math.max(0, path.length - 1),
    optimalPath: path.map((point) => ({ ...point })),
  };
  return { ...record, fixtureHash: sha256(record) };
}

function inGrid(point, size) {
  return Number.isInteger(point.r) && Number.isInteger(point.c)
    && point.r >= 0 && point.r < size && point.c >= 0 && point.c < size;
}

function stepIsOpen(cells, from, to) {
  const dr = to.r - from.r;
  const dc = to.c - from.c;
  const direction = dr === -1 && dc === 0 ? "up"
    : dr === 1 && dc === 0 ? "down"
      : dr === 0 && dc === 1 ? "right"
        : dr === 0 && dc === -1 ? "left" : null;
  if (!direction) return false;
  return canMove(cells, from, direction);
}
