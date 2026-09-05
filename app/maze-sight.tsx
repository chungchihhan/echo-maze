"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Maze, Point } from "../lib/maze/types.js";
import { wallSegments, type WallSegment } from "./maze-structure";

type Vector = { x: number; y: number };
type VisibilityPoint = Vector & { angle: number };

const CORNER_EPSILON = 0.00008;
const GEOMETRY_EPSILON = 0.000001;
const DEFAULT_LIGHT_TRANSITION_MS = 1_100;

function svgId(value: string) {
  return value.replaceAll(":", "");
}

function cubicBezierCoordinate(t: number, control1: number, control2: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * control1 + 3 * inverse * t * t * control2 + t * t * t;
}

function walkerTransitionEasing(progress: number) {
  let lower = 0;
  let upper = 1;
  let curveTime = progress;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    curveTime = (lower + upper) * 0.5;
    if (cubicBezierCoordinate(curveTime, 0.22, 0.36) < progress) lower = curveTime;
    else upper = curveTime;
  }
  return cubicBezierCoordinate(curveTime, 1, 1);
}

function raySegmentIntersection(origin: Vector, angle: number, wall: WallSegment) {
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const wallVector = { x: wall.x2 - wall.x1, y: wall.y2 - wall.y1 };
  const denominator = direction.x * wallVector.y - direction.y * wallVector.x;
  if (Math.abs(denominator) < 0.000001) return null;

  const offset = { x: wall.x1 - origin.x, y: wall.y1 - origin.y };
  const rayDistance = (offset.x * wallVector.y - offset.y * wallVector.x) / denominator;
  const wallDistance = (offset.x * direction.y - offset.y * direction.x) / denominator;
  if (rayDistance < 0 || wallDistance < -0.000001 || wallDistance > 1.000001) return null;

  return {
    x: origin.x + direction.x * rayDistance,
    y: origin.y + direction.y * rayDistance,
    distance: rayDistance,
  };
}

function visibilityPolygon(maze: Maze, origin: Vector) {
  const walls = wallSegments(maze);
  const angles = walls.flatMap((wall) => [
    Math.atan2(wall.y1 - origin.y, wall.x1 - origin.x),
    Math.atan2(wall.y2 - origin.y, wall.x2 - origin.x),
  ]).flatMap((angle) => [angle - CORNER_EPSILON, angle, angle + CORNER_EPSILON]);

  return angles.map((angle): VisibilityPoint | null => {
    let closest: ReturnType<typeof raySegmentIntersection> = null;
    for (const wall of walls) {
      const hit = raySegmentIntersection(origin, angle, wall);
      if (hit && (!closest || hit.distance < closest.distance)) closest = hit;
    }
    return closest ? { x: closest.x, y: closest.y, angle } : null;
  }).filter((point): point is VisibilityPoint => point !== null)
    .sort((left, right) => left.angle - right.angle);
}

function mergeCollinearWalls(segments: WallSegment[]) {
  const groups = new Map<string, WallSegment[]>();
  for (const wall of segments) {
    const horizontal = wall.y1 === wall.y2;
    const key = horizontal ? `h:${wall.y1}` : `v:${wall.x1}`;
    const group = groups.get(key) ?? [];
    group.push(wall);
    groups.set(key, group);
  }

  const merged: WallSegment[] = [];
  for (const [groupKey, group] of groups) {
    const horizontal = groupKey.startsWith("h:");
    const sorted = [...group].sort((left, right) => horizontal ? left.x1 - right.x1 : left.y1 - right.y1);
    let current = { ...sorted[0] };
    for (const wall of sorted.slice(1)) {
      const currentEnd = horizontal ? current.x2 : current.y2;
      const nextStart = horizontal ? wall.x1 : wall.y1;
      if (nextStart <= currentEnd + GEOMETRY_EPSILON) {
        if (horizontal) current.x2 = Math.max(current.x2, wall.x2);
        else current.y2 = Math.max(current.y2, wall.y2);
      } else {
        merged.push({ ...current, key: `merged-${merged.length}` });
        current = { ...wall };
      }
    }
    merged.push({ ...current, key: `merged-${merged.length}` });
  }
  return merged;
}

function rayThroughPointWallParameter(origin: Vector, point: Vector, wall: WallSegment) {
  const direction = { x: point.x - origin.x, y: point.y - origin.y };
  const wallVector = { x: wall.x2 - wall.x1, y: wall.y2 - wall.y1 };
  const denominator = direction.x * wallVector.y - direction.y * wallVector.x;
  if (Math.abs(denominator) < GEOMETRY_EPSILON) return null;

  const offset = { x: wall.x1 - origin.x, y: wall.y1 - origin.y };
  const rayDistance = (offset.x * wallVector.y - offset.y * wallVector.x) / denominator;
  const wallParameter = (offset.x * direction.y - offset.y * direction.x) / denominator;
  if (rayDistance <= 0 || wallParameter <= GEOMETRY_EPSILON || wallParameter >= 1 - GEOMETRY_EPSILON) return null;
  return wallParameter;
}

function pointIsOccluded(origin: Vector, point: Vector, walls: WallSegment[], targetWall: WallSegment) {
  const direction = { x: point.x - origin.x, y: point.y - origin.y };
  return walls.some((wall) => {
    if (wall.key === targetWall.key) return false;
    const wallVector = { x: wall.x2 - wall.x1, y: wall.y2 - wall.y1 };
    const denominator = direction.x * wallVector.y - direction.y * wallVector.x;
    if (Math.abs(denominator) < GEOMETRY_EPSILON) return false;
    const offset = { x: wall.x1 - origin.x, y: wall.y1 - origin.y };
    const rayDistance = (offset.x * wallVector.y - offset.y * wallVector.x) / denominator;
    const wallParameter = (offset.x * direction.y - offset.y * direction.x) / denominator;
    return rayDistance > GEOMETRY_EPSILON
      && rayDistance < 1 - GEOMETRY_EPSILON
      && wallParameter >= -GEOMETRY_EPSILON
      && wallParameter <= 1 + GEOMETRY_EPSILON;
  });
}

function wallPoint(wall: WallSegment, parameter: number) {
  return {
    x: wall.x1 + (wall.x2 - wall.x1) * parameter,
    y: wall.y1 + (wall.y2 - wall.y1) * parameter,
  };
}

function visibleWallIntervals(maze: Maze, origin: Vector) {
  const sourceWalls = wallSegments(maze);
  const walls = mergeCollinearWalls(sourceWalls);
  const corners = sourceWalls.flatMap((wall) => [{ x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }]);
  const visible: WallSegment[] = [];

  for (const wall of walls) {
    const cuts = [0, 1, ...corners.map((corner) => rayThroughPointWallParameter(origin, corner, wall))
      .filter((parameter): parameter is number => parameter !== null)]
      .sort((left, right) => left - right)
      .filter((parameter, index, values) => index === 0 || parameter - values[index - 1] > GEOMETRY_EPSILON);
    let activeStart: number | null = null;

    for (let index = 0; index < cuts.length - 1; index += 1) {
      const start = cuts[index];
      const end = cuts[index + 1];
      if (end - start <= GEOMETRY_EPSILON) continue;
      const midpoint = wallPoint(wall, (start + end) / 2);
      const intervalVisible = !pointIsOccluded(origin, midpoint, walls, wall);

      if (intervalVisible && activeStart === null) activeStart = start;
      const closesInterval = activeStart !== null && (!intervalVisible || index === cuts.length - 2);
      if (closesInterval) {
        const activeEnd = intervalVisible && index === cuts.length - 2 ? end : start;
        const from = wallPoint(wall, activeStart);
        const to = wallPoint(wall, activeEnd);
        visible.push({ key: `visible-${visible.length}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
        activeStart = null;
      }
    }
  }
  return visible;
}

export function MazeSightLayer({
  maze,
  position,
  transitionMs = DEFAULT_LIGHT_TRANSITION_MS,
}: {
  maze: Maze;
  position: Point;
  transitionMs?: number;
}) {
  const instanceId = svgId(useId());
  const maskId = `walker-sight-mask-${instanceId}`;
  const blurId = `walker-sight-blur-${instanceId}`;
  const gradientId = `walker-sight-gradient-${instanceId}`;
  const wallGradientId = `walker-wall-gradient-${instanceId}`;
  const size = maze.cells.length;
  const [lightPosition, setLightPosition] = useState<Vector>(() => ({ x: position.c + 0.5, y: position.r + 0.5 }));
  const lightPositionRef = useRef(lightPosition);
  const polygon = useMemo(() => visibilityPolygon(maze, lightPosition), [lightPosition, maze]);
  const visibleWalls = useMemo(() => visibleWallIntervals(maze, lightPosition), [lightPosition, maze]);
  const polygonPoints = polygon.map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`).join(" ");

  useEffect(() => {
    const from = lightPositionRef.current;
    const to = { x: position.c + 0.5, y: position.r + 0.5 };
    const moveDistance = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    let frame = 0;

    if (moveDistance < GEOMETRY_EPSILON) return undefined;
    if (moveDistance > 1 + GEOMETRY_EPSILON || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      frame = window.requestAnimationFrame(() => {
        lightPositionRef.current = to;
        setLightPosition(to);
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const startedAt = performance.now();
    const animate = (now: number) => {
      const progress = Math.min((now - startedAt) / transitionMs, 1);
      const eased = walkerTransitionEasing(progress);
      const next = {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      };
      lightPositionRef.current = next;
      setLightPosition(next);
      if (progress < 1) frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [position.c, position.r, transitionMs]);

  return (
    <svg
      className="maze-sight-canvas maze-sight-svg"
      viewBox={`0 0 ${size} ${size}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-sight-renderer="visibility-polygon"
    >
      <defs>
        <filter id={blurId} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="0.075" />
        </filter>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-1" y="-1" width={size + 2} height={size + 2}>
          <polygon points={polygonPoints} fill="white" filter={`url(#${blurId})`} />
        </mask>
        <radialGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          cx={lightPosition.x}
          cy={lightPosition.y}
          r={Math.max(3.4, size * 0.72)}
        >
          <stop offset="0" stopColor="#f0f7ff" stopOpacity="0.98" />
          <stop offset="0.16" stopColor="#527ceb" stopOpacity="0.96" />
          <stop offset="0.52" stopColor="#0033e5" stopOpacity="0.9" />
          <stop offset="1" stopColor="#102a72" stopOpacity="0.58" />
        </radialGradient>
        <radialGradient
          id={wallGradientId}
          gradientUnits="userSpaceOnUse"
          cx={lightPosition.x}
          cy={lightPosition.y}
          r={Math.max(3.4, size * 0.72)}
        >
          <stop offset="0" stopColor="#c0d0ff" stopOpacity="0.96" />
          <stop offset="0.42" stopColor="#c0d0ff" stopOpacity="0.72" />
          <stop offset="1" stopColor="#c0d0ff" stopOpacity="0.42" />
        </radialGradient>
      </defs>
      <rect width={size} height={size} fill={`url(#${gradientId})`} mask={`url(#${maskId})`} />
      <g className="maze-sight-walls" stroke={`url(#${wallGradientId})`}>
        {visibleWalls.map((wall) => (
          <line key={wall.key} x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} />
        ))}
      </g>
    </svg>
  );
}
