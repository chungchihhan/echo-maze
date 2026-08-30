export function WalkerMarker({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`walker-token walker-token-current ${compact ? "walker-token-compact" : ""}`}
      aria-hidden="true"
    />
  );
}
