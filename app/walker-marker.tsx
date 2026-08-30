import type { CSSProperties } from "react";
import type { Point } from "../lib/maze/types.js";

export function WalkerMarker({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`walker-token walker-token-current ${compact ? "walker-token-compact" : ""}`}
      aria-hidden="true"
    />
  );
}

export function GridWalkerMarker({ position, size }: { position: Point; size: number }) {
  const cellSize = `${100 / size}%`;
  return (
    <span
      className="walker-grid-position"
      style={{
        left: `${position.c * 100 / size}%`,
        top: `${position.r * 100 / size}%`,
        width: cellSize,
        height: cellSize,
      } as CSSProperties}
      aria-hidden="true"
    >
      <WalkerMarker />
    </span>
  );
}
