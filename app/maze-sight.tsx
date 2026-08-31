"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Maze, Point } from "../lib/maze/types.js";
import { wallSegments, type WallSegment } from "./maze-structure";

type SightParams = {
  gridSize: number;
  intensity: number;
  walkerCell: readonly [number, number];
};

const SIGHT_SHADER = /* wgsl */ `
struct Params {
  gridSize: f32,
  intensity: f32,
  walkerCell: vec2f,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> cellWalls: array<f32>;
@group(0) @binding(2) var<storage, read> bounceWalls: array<vec4f>;

const WALL_UP: u32 = 1u;
const WALL_RIGHT: u32 = 2u;
const WALL_DOWN: u32 = 4u;
const WALL_LEFT: u32 = 8u;

fn cellIsInside(cell: vec2i) -> bool {
  let size = i32(params.gridSize);
  return cell.x >= 0 && cell.y >= 0 && cell.x < size && cell.y < size;
}

fn cellWallMask(cell: vec2i) -> u32 {
  if (!cellIsInside(cell)) {
    return WALL_UP | WALL_RIGHT | WALL_DOWN | WALL_LEFT;
  }
  let size = i32(params.gridSize);
  return u32(cellWalls[u32(cell.y * size + cell.x)]);
}

fn rayVisibility(origin: vec2f, destinationPoint: vec2f) -> f32 {
  let destination = clamp(destinationPoint, vec2f(0.0005), vec2f(params.gridSize - 0.0005));
  let ray = destination - origin;
  let rayLength = length(ray);
  if (rayLength < 0.0001) {
    return 1.0;
  }

  let direction = ray / rayLength;
  var cell = vec2i(i32(floor(origin.x)), i32(floor(origin.y)));
  let endCell = vec2i(i32(floor(destination.x)), i32(floor(destination.y)));
  let stepX: i32 = select(-1, 1, direction.x >= 0.0);
  let stepY: i32 = select(-1, 1, direction.y >= 0.0);
  var tDeltaX = 10000.0;
  var tDeltaY = 10000.0;
  var tMaxX = 10000.0;
  var tMaxY = 10000.0;

  if (abs(direction.x) > 0.0001) {
    let nextBoundaryX = select(f32(cell.x), f32(cell.x + 1), stepX > 0);
    tDeltaX = abs(1.0 / direction.x);
    tMaxX = max((nextBoundaryX - origin.x) / direction.x, 0.0);
  }
  if (abs(direction.y) > 0.0001) {
    let nextBoundaryY = select(f32(cell.y), f32(cell.y + 1), stepY > 0);
    tDeltaY = abs(1.0 / direction.y);
    tMaxY = max((nextBoundaryY - origin.y) / direction.y, 0.0);
  }

  // A 9x9 maze needs at most 18 crossings. The fixed upper bound keeps the
  // shader valid for slightly larger mazes without scanning every wall.
  for (var iteration = 0u; iteration < 32u; iteration = iteration + 1u) {
    if (cell.x == endCell.x && cell.y == endCell.y) {
      return 1.0;
    }

    let mask = cellWallMask(cell);
    let wallX = select(WALL_LEFT, WALL_RIGHT, stepX > 0);
    let wallY = select(WALL_UP, WALL_DOWN, stepY > 0);

    if (abs(tMaxX - tMaxY) < 0.0001) {
      if ((mask & wallX) != 0u || (mask & wallY) != 0u) {
        return 0.0;
      }
      cell = cell + vec2i(stepX, stepY);
      tMaxX = tMaxX + tDeltaX;
      tMaxY = tMaxY + tDeltaY;
    } else if (tMaxX < tMaxY) {
      if ((mask & wallX) != 0u) {
        return 0.0;
      }
      cell = cell + vec2i(stepX, 0);
      tMaxX = tMaxX + tDeltaX;
    } else {
      if ((mask & wallY) != 0u) {
        return 0.0;
      }
      cell = cell + vec2i(0, stepY);
      tMaxY = tMaxY + tDeltaY;
    }

    if (!cellIsInside(cell)) {
      return 0.0;
    }
  }
  return 0.0;
}

fn normalizeOrZero(value: vec2f) -> vec2f {
  let valueLength = length(value);
  if (valueLength < 0.0001) {
    return vec2f(0.0, 0.0);
  }
  return value / valueLength;
}

fn bounceRadiance(worldPosition: vec2f, walkerPosition: vec2f, wall: vec4f) -> f32 {
  let wallEdge = wall.zw - wall.xy;
  if (length(wallEdge) < 0.0001) {
    return 0.0;
  }

  let wallMidpoint = (wall.xy + wall.zw) * 0.5;
  let walkerToWall = wallMidpoint - walkerPosition;
  let sourceDistance = length(walkerToWall);
  if (sourceDistance < 0.0001) {
    return 0.0;
  }

  // Orient the wall normal toward Walker so the diffuse lobe stays on the
  // illuminated side instead of leaking through the wall.
  let edgeDirection = normalizeOrZero(wallEdge);
  var wallNormal = vec2f(-edgeDirection.y, edgeDirection.x);
  let wallToWalker = normalizeOrZero(walkerPosition - wallMidpoint);
  if (dot(wallNormal, wallToWalker) < 0.0) {
    wallNormal = -wallNormal;
  }

  let incomingDirection = normalizeOrZero(walkerToWall);
  let reflectionDirection = normalizeOrZero(incomingDirection - 2.0 * dot(incomingDirection, wallNormal) * wallNormal);
  let wallToFragment = worldPosition - wallMidpoint;
  let fragmentDistance = length(wallToFragment);
  if (fragmentDistance < 0.0001) {
    return 0.0;
  }

  let fragmentDirection = normalizeOrZero(wallToFragment);
  let diffuse = max(dot(wallNormal, fragmentDirection), 0.0);
  let reflection = pow(max(dot(reflectionDirection, fragmentDirection), 0.0), 6.0);
  let sourceFalloff = 1.0 / (1.0 + 0.20 * sourceDistance + 0.10 * sourceDistance * sourceDistance);
  let bounceFalloff = 1.0 / (1.0 + 0.32 * fragmentDistance + 0.18 * fragmentDistance * fragmentDistance);

  // A broad Lambertian wash plus a tighter specular streak gives the visible
  // maze a subtle one-bounce response without turning the hidden space into a map.
  return sourceFalloff * bounceFalloff * (0.72 * diffuse + 0.42 * reflection);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let floorColor = vec3f(0.0, 0.0, 0.0);
  let beamColor = vec3f(0.03, 0.14, 0.52);
  let lightColor = vec3f(0.92, 0.97, 1.0);
  let bounceColor = vec3f(0.16, 0.33, 0.86);
  let worldPosition = uv * params.gridSize;
  let walkerPosition = params.walkerCell + vec2f(0.5, 0.5);
  let delta = worldPosition - walkerPosition;
  let distanceFromWalker = length(delta);

  // Five points across a small physical emitter create a distance-dependent
  // penumbra. Every sample still traverses the maze grid and stops at walls.
  let sourceRadius = 0.075;
  let visibility = 0.36 * rayVisibility(walkerPosition, worldPosition)
    + 0.16 * rayVisibility(walkerPosition + vec2f(sourceRadius, sourceRadius * 0.24), worldPosition)
    + 0.16 * rayVisibility(walkerPosition + vec2f(-sourceRadius * 0.62, sourceRadius * 0.78), worldPosition)
    + 0.16 * rayVisibility(walkerPosition + vec2f(-sourceRadius * 0.82, -sourceRadius * 0.48), worldPosition)
    + 0.16 * rayVisibility(walkerPosition + vec2f(sourceRadius * 0.45, -sourceRadius), worldPosition);
  let softVisibility = smoothstep(0.0, 1.0, visibility);
  let falloff = 1.0 / (1.0 + 0.16 * distanceFromWalker + 0.09 * distanceFromWalker * distanceFromWalker);
  let directLight = clamp(softVisibility * falloff * params.intensity, 0.0, 0.94);

  var bounceEnergy = 0.0;
  for (var bounceIndex = 0u; bounceIndex < arrayLength(&bounceWalls); bounceIndex = bounceIndex + 1u) {
    bounceEnergy = bounceEnergy + bounceRadiance(worldPosition, walkerPosition, bounceWalls[bounceIndex]);
  }
  // Indirect light is also clipped by the same soft visibility mask. This is
  // important: a visible wall may reflect light, but it cannot illuminate a
  // fragment that is fully behind another wall.
  let bounceMask = softVisibility * softVisibility;
  let bounceLight = clamp(bounceEnergy * 0.045 * params.intensity * bounceMask, 0.0, 0.42);

  let colorMix = clamp(exp(-distanceFromWalker * 0.52), 0.0, 1.0);
  let litColor = mix(beamColor, lightColor, colorMix);
  return vec4f(clamp(floorColor + litColor * directLight + bounceColor * bounceLight, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

const MAX_BOUNCE_WALLS = 32;
const LIGHT_TRANSITION_MS = 1_100;
const WALL_BITS = { up: 1, right: 2, down: 4, left: 8 } as const;

function cubicBezierCoordinate(t: number, control1: number, control2: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * control1 + 3 * inverse * t * t * control2 + t * t * t;
}

function walkerTransitionEasing(progress: number) {
  // Match the Walker marker's cubic-bezier(.22, 1, .36, 1) without adding a
  // motion dependency. Binary subdivision is stable and runs only while the
  // one-second light transition is active.
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

function makeCellWallData(maze: Maze) {
  const size = maze.cells.length;
  // Keep storage data as floats and cast in WGSL. This avoids integer-storage
  // layout differences across WebGPU implementations while preserving the
  // compact wall bitmask used by the DDA traversal.
  const data = new Float32Array(size * size);

  for (const row of maze.cells) {
    for (const cell of row) {
      let mask = 0;
      if (cell.walls.up) mask |= WALL_BITS.up;
      if (cell.walls.right) mask |= WALL_BITS.right;
      if (cell.walls.down) mask |= WALL_BITS.down;
      if (cell.walls.left) mask |= WALL_BITS.left;
      data[cell.r * size + cell.c] = mask;
    }
  }
  return data;
}

function cross2(a: readonly [number, number], b: readonly [number, number]) {
  return a[0] * b[1] - a[1] * b[0];
}

function rayHitsWall(origin: readonly [number, number], destination: readonly [number, number], wall: WallSegment) {
  const ray: [number, number] = [destination[0] - origin[0], destination[1] - origin[1]];
  const wallVector: [number, number] = [wall.x2 - wall.x1, wall.y2 - wall.y1];
  const denominator = cross2(ray, wallVector);
  if (Math.abs(denominator) < 0.0001) return false;

  const offset: [number, number] = [wall.x1 - origin[0], wall.y1 - origin[1]];
  const rayDistance = cross2(offset, wallVector) / denominator;
  const wallDistance = cross2(offset, ray) / denominator;
  return rayDistance > 0.002 && rayDistance < 0.998 && wallDistance > -0.002 && wallDistance < 1.002;
}

function makeBounceWallData(maze: Maze, position: Point) {
  const walkerPosition: [number, number] = [position.c + 0.5, position.r + 0.5];
  const walls = wallSegments(maze);
  const data = new Float32Array(MAX_BOUNCE_WALLS * 4);

  // Reflections only need the nearest visible surfaces. Sorting before the
  // occlusion test avoids the old all-walls-by-all-walls pass on every move.
  const nearestVisibleWalls: WallSegment[] = [];
  const nearestFirst = walls
    .map((wall, wallIndex) => ({ wall, wallIndex }))
    .sort((a, b) => {
      const aWall = a.wall;
      const bWall = b.wall;
      const aX = (aWall.x1 + aWall.x2) * 0.5 - walkerPosition[0];
      const aY = (aWall.y1 + aWall.y2) * 0.5 - walkerPosition[1];
      const bX = (bWall.x1 + bWall.x2) * 0.5 - walkerPosition[0];
      const bY = (bWall.y1 + bWall.y2) * 0.5 - walkerPosition[1];
      return aX * aX + aY * aY - (bX * bX + bY * bY);
    });

  for (const { wall, wallIndex } of nearestFirst) {
    const midpoint: [number, number] = [(wall.x1 + wall.x2) * 0.5, (wall.y1 + wall.y2) * 0.5];
    const isOccluded = walls.some(
      (candidate, candidateIndex) => candidateIndex !== wallIndex && rayHitsWall(walkerPosition, midpoint, candidate),
    );
    if (!isOccluded) nearestVisibleWalls.push(wall);
    if (nearestVisibleWalls.length === MAX_BOUNCE_WALLS) break;
  }

  nearestVisibleWalls.forEach((wall, index) => {
    data.set([wall.x1, wall.y1, wall.x2, wall.y2], index * 4);
  });
  return data;
}

function makeSightParams(maze: Maze, position: Point): SightParams {
  return {
    gridSize: maze.cells.length,
    intensity: 1,
    walkerCell: [position.c, position.r],
  };
}

export function MazeSightLayer({ maze, position }: { maze: Maze; position: Point }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cellWallData = useMemo(() => makeCellWallData(maze), [maze]);
  const sightParams = useMemo(() => makeSightParams(maze, position), [maze, position]);
  const bounceWallData = useMemo(() => makeBounceWallData(maze, position), [maze, position]);
  const paramsRef = useRef(sightParams);
  const bounceWallDataRef = useRef(bounceWallData);

  useEffect(() => {
    paramsRef.current = sightParams;
    bounceWallDataRef.current = bounceWallData;
  }, [bounceWallData, sightParams]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let gpu: import("vgpu").Gpu | undefined;
    let sightSurface: import("vgpu").Surface | undefined;
    let sightEffect: import("vgpu").Effect | undefined;
    let cellWallStorage: import("vgpu").StorageBuffer | undefined;
    let bounceWallStorage: import("vgpu").StorageBuffer | undefined;
    let loop: import("vgpu").FrameLoopHandle | undefined;
    let removeErrorListener: (() => void) | undefined;

    const setStatus = (status: "pending" | "ready" | "fallback") => {
      canvas.dataset.vgpuStatus = status;
    };

    const setFallback = (error: unknown) => {
      if (error instanceof Error) {
        const gpuError = error as Error & {
          code?: string;
          fix?: string;
          where?: string;
          cause?: unknown;
          detail?: unknown;
        };
        canvas.dataset.vgpuError = JSON.stringify({
          name: gpuError.name,
          message: gpuError.message,
          code: gpuError.code,
          fix: gpuError.fix,
          where: gpuError.where,
          cause:
            gpuError.cause && typeof gpuError.cause === "object"
              ? {
                  name: "name" in gpuError.cause ? String(gpuError.cause.name) : undefined,
                  message: "message" in gpuError.cause ? String(gpuError.cause.message) : undefined,
                  text: String(gpuError.cause),
                }
              : gpuError.cause,
          detail: gpuError.detail,
        });
      } else {
        canvas.dataset.vgpuError = String(error);
      }
      setStatus("fallback");
    };

    const dispose = () => {
      loop?.stop();
      sightSurface?.dispose();
      cellWallStorage?.destroy();
      bounceWallStorage?.destroy();
      removeErrorListener?.();
      gpu?.dispose();
    };

    setStatus("pending");

    if (!("gpu" in navigator)) {
      setStatus("fallback");
      return () => undefined;
    }

    void (async () => {
      try {
        const { effect, frameLoop, init, storage, surface } = await import("vgpu");
        if (cancelled) return;

        gpu = await init({ label: "echo-maze.walker-sight" });
        if (cancelled) {
          gpu.dispose();
          gpu = undefined;
          return;
        }

        sightSurface = surface(gpu, canvas, {
          alphaMode: "opaque",
          clearColor: [0, 0, 0, 1],
          dpr: [1, 1.5],
          label: "echo-maze.walker-sight-surface",
        });
        cellWallStorage = storage(gpu, Math.max(16, cellWallData.byteLength), "read");
        cellWallStorage.write(cellWallData);
        bounceWallStorage = storage(gpu, bounceWallDataRef.current.byteLength, "read");
        bounceWallStorage.write(bounceWallDataRef.current);
        sightEffect = effect(gpu, SIGHT_SHADER, {
          label: "echo-maze.walker-sight-effect",
          set: { params: paramsRef.current, cellWalls: cellWallStorage, bounceWalls: bounceWallStorage },
        });
        let lastParams = paramsRef.current;
        let lastBounceWallData = bounceWallDataRef.current;
        let lastCanvasWidth = -1;
        let lastCanvasHeight = -1;
        let needsRender = true;
        let displayedWalkerCell: [number, number] = [...lastParams.walkerCell];
        let transitionFrom: [number, number] = [...displayedWalkerCell];
        let transitionTo: [number, number] = [...displayedWalkerCell];
        let transitionStartedAt = 0;
        let isTransitioning = false;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        canvas.dataset.vgpuTransition = "idle";
        removeErrorListener = gpu.onError((error) => {
          if (!cancelled) setFallback(error);
        });
        loop = frameLoop(gpu, (frame) => {
          if (!sightEffect || !sightSurface || !cellWallStorage || !bounceWallStorage) return;
          let frameChanged = false;
          let paramsChanged = false;
          if (bounceWallDataRef.current !== lastBounceWallData) {
            bounceWallStorage.write(bounceWallDataRef.current);
            lastBounceWallData = bounceWallDataRef.current;
            frameChanged = true;
          }
          if (paramsRef.current !== lastParams) {
            const nextParams = paramsRef.current;
            const nextWalkerCell = nextParams.walkerCell;
            const moveDistance =
              Math.abs(nextWalkerCell[0] - transitionTo[0]) + Math.abs(nextWalkerCell[1] - transitionTo[1]);
            lastParams = nextParams;
            if (!reduceMotion && moveDistance === 1) {
              transitionFrom = [...displayedWalkerCell];
              transitionTo = [...nextWalkerCell];
              transitionStartedAt = performance.now();
              isTransitioning = true;
              canvas.dataset.vgpuTransition = "active";
            } else {
              displayedWalkerCell = [...nextWalkerCell];
              transitionFrom = [...nextWalkerCell];
              transitionTo = [...nextWalkerCell];
              isTransitioning = false;
              canvas.dataset.vgpuTransition = "idle";
            }
            paramsChanged = true;
            frameChanged = true;
          }

          let paramsForFrame = lastParams;
          if (isTransitioning) {
            const progress = Math.min((performance.now() - transitionStartedAt) / LIGHT_TRANSITION_MS, 1);
            const easedProgress = walkerTransitionEasing(progress);
            displayedWalkerCell = [
              transitionFrom[0] + (transitionTo[0] - transitionFrom[0]) * easedProgress,
              transitionFrom[1] + (transitionTo[1] - transitionFrom[1]) * easedProgress,
            ];
            paramsForFrame = { ...lastParams, walkerCell: displayedWalkerCell };
            paramsChanged = true;
            frameChanged = true;
            needsRender = true;
            if (progress === 1) {
              isTransitioning = false;
              canvas.dataset.vgpuTransition = "idle";
            }
          }
          if (paramsChanged) sightEffect.set({ params: paramsForFrame });

          const resized = canvas.width !== lastCanvasWidth || canvas.height !== lastCanvasHeight;
          if (!needsRender && !frameChanged && !resized) return;
          frame.pass(sightSurface, sightEffect);
          lastCanvasWidth = canvas.width;
          lastCanvasHeight = canvas.height;
          needsRender = false;
        }, { fps: 30 });
        setStatus("ready");
      } catch (error) {
        if (!cancelled) setFallback(error);
        dispose();
      }
    })();

    return () => {
      cancelled = true;
      dispose();
    };
  }, [cellWallData, maze]);

  return (
    <canvas
      ref={canvasRef}
      className="maze-sight-canvas"
      aria-hidden="true"
      data-vgpu-status="pending"
      data-vgpu-transition="idle"
    />
  );
}
