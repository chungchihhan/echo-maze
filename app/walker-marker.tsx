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

export function GridWalkerMarker({
  position,
  size,
  transitionMs = 1_100,
}: {
  position: Point;
  size: number;
  transitionMs?: number;
}) {
  const cellSize = `${100 / size}%`;
  return (
    <span
      className="walker-grid-position"
      style={{
        transform: `translate3d(${position.c * 100}%, ${position.r * 100}%, 0)`,
        width: cellSize,
        height: cellSize,
        "--walker-move-duration": `${transitionMs}ms`,
      } as CSSProperties}
      aria-hidden="true"
    >
      <WalkerMarker />
    </span>
  );
}
