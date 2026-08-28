/**
 * Pure movement semantics: bounds checks, wall checks, and transitions.
 * The browser UI and the headless benchmark runner must both go through
 * these functions so environment behavior cannot drift.
 */

import { OPPOSITE, directionVector } from "./types.js";

/** @typedef {import("./types.js").Point} Point */
/** @typedef {import("./types.js").Cell} Cell */
/** @typedef {import("./types.js").DirectionKey} DirectionKey */
/** @typedef {import("./types.js").MoveResult} MoveResult */

/**
 * @param {Point} a
 * @param {Point} b
 * @returns {boolean}
 */
export function samePoint(a, b) {
  return a.r === b.r && a.c === b.c;
}

/**
 * @param {Point} point
 * @returns {string}
 */
export function pointKey(point) {
  return `${point.r},${point.c}`;
}

/**
 * Grid size is derived from the cells matrix (square mazes).
 *
 * @param {Cell[][]} cells
 * @param {Point} point
 * @returns {boolean}
 */
export function inBounds(cells, point) {
  const size = cells.length;
  return point.r >= 0 && point.r < size && point.c >= 0 && point.c < size;
}

/**
 * @param {Point} point
 * @param {DirectionKey} direction
 * @returns {Point}
 */
export function getNeighbor(point, direction) {
  const vector = directionVector(direction);
  return { r: point.r + (vector?.dr ?? 0), c: point.c + (vector?.dc ?? 0) };
}

/**
 * A move is possible only when the neighbor is in bounds and the shared wall
 * between the two cells is open on the origin side.
 *
 * @param {Cell[][]} cells
 * @param {Point} point
 * @param {DirectionKey} direction
 * @returns {boolean}
 */
export function canMove(cells, point, direction) {
  if (!inBounds(cells, point)) return false;
  const neighbor = getNeighbor(point, direction);
  if (!inBounds(cells, neighbor)) return false;
  return !cells[point.r][point.c].walls[direction];
}

/**
 * Apply one attempted move. Blocked moves leave the position unchanged.
 *
 * @param {Cell[][]} cells
 * @param {Point} position
 * @param {DirectionKey} direction
 * @returns {{ result: MoveResult, position: Point }}
 */
export function applyMove(cells, position, direction) {
  if (!canMove(cells, position, direction)) {
    return { result: "blocked", position };
  }
  return { result: "moved", position: getNeighbor(position, direction) };
}

/**
 * Relative-coordinate delta for a successful move. The Walker-relative system
 * starts at (0,0): right is +x, left is -x, up is +y, down is -y. Blocked
 * moves produce no delta.
 *
 * @param {DirectionKey} direction
 * @param {MoveResult} result
 * @returns {{ x: number, y: number }}
 */
export function relativeDelta(direction, result) {
  if (result !== "moved") return { x: 0, y: 0 };
  switch (direction) {
    case "up": return { x: 0, y: 1 };
    case "down": return { x: 0, y: -1 };
    case "right": return { x: 1, y: 0 };
    case "left": return { x: -1, y: 0 };
    default: return { x: 0, y: 0 };
  }
}

/**
 * Open/blocked direction keys at a cell.
 *
 * @param {Cell[][]} cells
 * @param {Point} point
 * @returns {{ openDirections: DirectionKey[], blockedDirections: DirectionKey[] }}
 */
export function directionStatus(cells, point) {
  const openDirections = [];
  const blockedDirections = [];
  for (const { key } of directionOrder()) {
    if (canMove(cells, point, key)) openDirections.push(key);
    else blockedDirections.push(key);
  }
  return { openDirections, blockedDirections };
}

function directionOrder() {
  return [
    { key: /** @type {DirectionKey} */ ("up") },
    { key: /** @type {DirectionKey} */ ("right") },
    { key: /** @type {DirectionKey} */ ("down") },
    { key: /** @type {DirectionKey} */ ("left") },
  ];
}

export { OPPOSITE };
