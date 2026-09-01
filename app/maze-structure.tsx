import { useMemo, type ReactNode } from "react";
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
  children?: ReactNode;
};

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

export function MazeStructure({ maze, ariaLabel, className = "", showStart = false, showExit = false, children }: MazeStructureProps) {
  const size = maze.cells.length;
  const segments = useMemo(() => wallSegments(maze), [maze]);

  return (
    <div className={`maze-structure-stage ${className}`.trim()} aria-label={ariaLabel} data-maze-structure>
      <svg className="maze-structure" viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <g className="maze-structure-walls maze-structure-walls-base">
          {segments.map((segment) => (
            <line key={segment.key} x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
          ))}
        </g>
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
