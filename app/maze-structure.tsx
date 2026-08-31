import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { Maze, Point } from "../lib/maze/types.js";

export type WallSegment = {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type MazeStructureProps = {
  maze: Maze;
  ariaLabel: string;
  className?: string;
  showStart?: boolean;
  showExit?: boolean;
  showWallLight?: boolean;
  position?: Point;
  children?: ReactNode;
};

type Vector = { x: number; y: number };

const WALL_LIGHT_SAMPLE_POSITIONS = [0.08, 0.26, 0.5, 0.74, 0.92];

export function wallSegments(maze: Maze): WallSegment[] {
  const size = maze.cells.length;
  const segments: WallSegment[] = [];

  for (const row of maze.cells) {
    for (const cell of row) {
      if (cell.walls.up) {
        segments.push({ key: `${cell.r}-${cell.c}-up`, x1: cell.c, y1: cell.r, x2: cell.c + 1, y2: cell.r });
      }
      if (cell.walls.left) {
        segments.push({ key: `${cell.r}-${cell.c}-left`, x1: cell.c, y1: cell.r, x2: cell.c, y2: cell.r + 1 });
      }
      if (cell.r === size - 1 && cell.walls.down) {
        segments.push({ key: `${cell.r}-${cell.c}-down`, x1: cell.c, y1: cell.r + 1, x2: cell.c + 1, y2: cell.r + 1 });
      }
      if (cell.c === size - 1 && cell.walls.right) {
        segments.push({ key: `${cell.r}-${cell.c}-right`, x1: cell.c + 1, y1: cell.r, x2: cell.c + 1, y2: cell.r + 1 });
      }
    }
  }

  return segments;
}

function rayIntersectsWall(origin: Vector, target: Vector, wall: WallSegment) {
  const rayX = target.x - origin.x;
  const rayY = target.y - origin.y;
  const wallX = wall.x2 - wall.x1;
  const wallY = wall.y2 - wall.y1;
  const denominator = rayX * wallY - rayY * wallX;

  if (Math.abs(denominator) < 0.000001) return false;

  const offsetX = wall.x1 - origin.x;
  const offsetY = wall.y1 - origin.y;
  const rayDistance = (offsetX * wallY - offsetY * wallX) / denominator;
  const wallDistance = (offsetX * rayY - offsetY * rayX) / denominator;

  return rayDistance > 0.001 && rayDistance < 0.999 && wallDistance > -0.001 && wallDistance < 1.001;
}

function wallLightOpacity(wall: WallSegment, walls: WallSegment[], origin: Vector) {
  let visibleSamples = 0;

  for (const samplePosition of WALL_LIGHT_SAMPLE_POSITIONS) {
    const target = {
      x: wall.x1 + (wall.x2 - wall.x1) * samplePosition,
      y: wall.y1 + (wall.y2 - wall.y1) * samplePosition,
    };
    const blocked = walls.some((candidate) => candidate.key !== wall.key && rayIntersectsWall(origin, target, candidate));
    if (!blocked) visibleSamples += 1;
  }

  const visibility = visibleSamples / WALL_LIGHT_SAMPLE_POSITIONS.length;
  if (visibility === 0) return 0;

  const midpoint = { x: (wall.x1 + wall.x2) / 2, y: (wall.y1 + wall.y2) / 2 };
  const distance = Math.hypot(midpoint.x - origin.x, midpoint.y - origin.y);
  const distanceFalloff = 1 / (1 + distance * 0.14 + distance * distance * 0.035);

  return Math.min(1, visibility * distanceFalloff * 1.8);
}

function makeWallLightValues(maze: Maze, position: Point) {
  const walls = wallSegments(maze);
  const origin = { x: position.c + 0.5, y: position.r + 0.5 };

  return new Map(walls.map((wall) => [wall.key, wallLightOpacity(wall, walls, origin)]));
}

function MazeStructureMarker({ point, size, className, children }: { point: Point; size: number; className: string; children: ReactNode }) {
  return (
    <span
      className={`maze-structure-marker ${className}`}
      style={{ left: `${(point.c + 0.5) * 100 / size}%`, top: `${(point.r + 0.5) * 100 / size}%` }}
    >
      {children}
    </span>
  );
}

export function MazeStructure({ maze, ariaLabel, className = "", showStart = false, showExit = false, showWallLight = false, position, children }: MazeStructureProps) {
  const size = maze.cells.length;
  const segments = useMemo(() => wallSegments(maze), [maze]);
  const wallLightValues = useMemo(
    () => (showWallLight && position ? makeWallLightValues(maze, position) : null),
    [maze, position, showWallLight],
  );
  const wallLightStyle = (segment: WallSegment) => ({
    "--wall-light": (wallLightValues?.get(segment.key) ?? 0).toFixed(3),
  } as CSSProperties);

  return (
    <div className={`maze-structure-stage ${className}`.trim()} aria-label={ariaLabel} data-maze-structure>
      <svg className="maze-structure" viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <g className="maze-structure-walls maze-structure-walls-base">
          {segments.map((segment) => (
            <line key={segment.key} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
          ))}
        </g>
        {showWallLight ? (
          <g className="maze-structure-walls maze-structure-walls-lit">
            {segments.map((segment) => (
              <line
                key={`${segment.key}-lit`}
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
                style={wallLightStyle(segment)}
              />
            ))}
          </g>
        ) : null}
      </svg>
      {showStart ? (
        <MazeStructureMarker point={maze.start} size={size} className="maze-structure-start-mark">
          START
        </MazeStructureMarker>
      ) : null}
      {showExit ? (
        <MazeStructureMarker point={maze.exit} size={size} className="maze-structure-exit-mark">
          EXIT
        </MazeStructureMarker>
      ) : null}
      {children}
    </div>
  );
}
