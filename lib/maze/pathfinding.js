/**
 * Pure BFS pathfinding over the maze wall grid.
 */

import { DIRECTIONS } from "./types.js";
import { canMove, getNeighbor, pointKey, samePoint } from "./transition.js";

/** @typedef {import("./types.js").Point} Point */
/** @typedef {import("./types.js").Cell} Cell */

/**
 * Breadth-first shortest path inclusive of both endpoints.
 * Returns an empty array when the goal is unreachable.
 *
 * @param {Cell[][]} cells
 * @param {Point} start
 * @param {Point} goal
 * @returns {Point[]}
 */
export function shortestPath(cells, start, goal) {
  const queue = [start];
  /** @type {Map<string, Point | null>} */
  const previous = new Map([[pointKey(start), null]]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || samePoint(current, goal)) break;
    for (const direction of DIRECTIONS) {
      if (!canMove(cells, current, direction.key)) continue;
      const next = getNeighbor(current, direction.key);
      if (previous.has(pointKey(next))) continue;
      previous.set(pointKey(next), current);
      queue.push(next);
    }
  }
  if (!previous.has(pointKey(goal))) return [];
  /** @type {Point[]} */
  const path = [];
  let cursor = goal;
  while (cursor) {
    path.unshift(cursor);
    cursor = previous.get(pointKey(cursor)) ?? null;
  }
  return path;
}

/**
 * Optimal route length in moves (edges), not cells.
 *
 * @param {Cell[][]} cells
 * @param {Point} start
 * @param {Point} goal
 * @returns {number}
 */
export function optimalPathLength(cells, start, goal) {
  return Math.max(0, shortestPath(cells, start, goal).length - 1);
}
