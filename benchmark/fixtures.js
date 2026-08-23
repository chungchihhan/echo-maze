/**
 * Immutable benchmark fixture loading and verification.
 *
 * Fixtures are frozen maze snapshots. The runtime never re-generates a maze
 * from a seed; the generator is only used by the authoring script
 * (scripts/generate-fixtures.mjs) and by verification (BFS cross-check).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { canMove, shortestPath, samePoint } from "../lib/maze/index.js";
import { FIXTURE_IDS, GENERATOR_VERSION, BENCHMARK_VERSION, sha256 } from "./contract.js";

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures";

/** @typedef {import("../lib/maze/types.js").Point} Point */

/**
 * Frozen maze snapshot on disk.
 *
 * @typedef {{
 *   fixtureId: string,
 *   seed: string,
 *   generatorVersion: string,
 *   benchmarkVersion: string,
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

function fixturePath(fixtureId) {
  return path.join(FIXTURES_DIR, `${fixtureId}.json`);
}

/**
 * @param {string} fixtureId
 * @returns {Promise<MazeFixture>}
 */
export async function loadFixture(fixtureId) {
  const raw = await readFile(fixturePath(fixtureId), "utf8");
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

/** Load all fixtures in contract order. */
export async function loadAllFixtures() {
  return Promise.all(FIXTURE_IDS.map(loadFixture));
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
 * @returns {MazeFixture}
 */
export function fixtureFromMaze(maze, fixtureId) {
  const path = shortestPath(maze.cells, maze.start, maze.exit);
  const record = {
    fixtureId,
    seed: maze.seed,
    generatorVersion: GENERATOR_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
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
