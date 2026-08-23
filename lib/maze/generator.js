/**
 * Deterministic seeded maze generation (recursive backtracker on a fixed
 * square grid, exit chosen among cells meeting the minimum optimal route
 * length). The generator is used to author fixtures; benchmark runtime loads
 * immutable snapshots instead of re-rolling seeds.
 */

import { DIRECTIONS, MAZE_SIZE, MIN_ROUTE_LENGTH } from "./types.js";
import { OPPOSITE } from "./transition.js";
import { optimalPathLength } from "./pathfinding.js";
import { pointKey } from "./transition.js";

/** @typedef {import("./types.js").Point} Point */
/** @typedef {import("./types.js").Cell} Cell */
/** @typedef {import("./types.js").Maze} Maze */
/** @typedef {() => number} RandomSource */

/**
 * FNV-1a seeded PRNG. Same seed string always yields the same sequence.
 *
 * @param {string} seedText
 * @returns {RandomSource}
 */
export function seededRandom(seedText) {
  let state = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @template T
 * @param {T[]} items
 * @param {RandomSource} [random]
 * @returns {T[]}
 */
export function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/**
 * @param {number} size
 * @returns {Cell[][]}
 */
function makeCells(size) {
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => ({
      r, c, walls: { up: true, right: true, down: true, left: true },
    })),
  );
}

/**
 * Carve a perfect maze (spanning tree) with a recursive backtracker.
 *
 * @param {RandomSource} random
 * @param {number} size
 * @returns {Cell[][]}
 */
export function carveMaze(random, size = MAZE_SIZE) {
  const cells = makeCells(size);
  const origin = { r: 0, c: 0 };
  const visited = new Set([pointKey(origin)]);
  /** @type {Point[]} */
  const stack = [origin];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const options = shuffle(DIRECTIONS, random).filter((direction) => {
      const neighbor = {
        r: current.r + direction.dr,
        c: current.c + direction.dc,
      };
      return (
        neighbor.r >= 0 && neighbor.r < size &&
        neighbor.c >= 0 && neighbor.c < size &&
        !visited.has(pointKey(neighbor))
      );
    });
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const direction = options[0];
    const next = {
      r: current.r + direction.dr,
      c: current.c + direction.dc,
    };
    cells[current.r][current.c].walls[direction.key] = false;
    cells[next.r][next.c].walls[OPPOSITE[direction.key]] = false;
    visited.add(pointKey(next));
    stack.push(next);
  }
  return cells;
}

/**
 * Generate a solvable maze whose optimal route length meets the minimum.
 *
 * @param {RandomSource} [random]
 * @param {string} [seedLabel]
 * @param {{ size?: number, minRouteLength?: number }} [options]
 * @returns {Maze}
 */
export function generateMaze(random = Math.random, seedLabel = undefined, options = {}) {
  const size = options.size ?? MAZE_SIZE;
  const minRouteLength = options.minRouteLength ?? MIN_ROUTE_LENGTH;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const cells = carveMaze(random, size);
    const start = { r: Math.floor(random() * size), c: Math.floor(random() * size) };
    /** @type {Array<{ point: Point, routeLength: number }>} */
    const exits = [];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const point = { r, c };
        const routeLength = optimalPathLength(cells, start, point);
        if (routeLength >= minRouteLength && !(r === start.r && c === start.c)) {
          exits.push({ point, routeLength });
        }
      }
    }
    if (exits.length > 0) {
      const selected = exits[Math.floor(random() * exits.length)];
      return {
        cells,
        start,
        exit: selected.point,
        routeLength: selected.routeLength,
        seed: seedLabel ?? Math.floor(random() * 0xffffffff).toString(36).slice(0, 6).toUpperCase(),
      };
    }
  }
  throw new Error("Could not generate a connected maze.");
}
