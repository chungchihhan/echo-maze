import Link from "next/link";

type SiteHeaderProps = { active?: "benchmark" | "replays" };

export function SiteHeader({ active }: SiteHeaderProps) {
  return (
    <header className="topbar public-topbar">
      <Link className="brand-lockup brand-link" href="/" aria-label="Echo Maze home">
        <span className="brand-mark brand-mark-inverse" aria-hidden="true" />
        <span className="brand-name">ECHO MAZE</span>
      </Link>
      <nav className="site-nav" aria-label="Primary navigation">
        <Link className={active === "benchmark" ? "is-active" : ""} href="/benchmark">Benchmark</Link>
        <Link className={active === "replays" ? "is-active" : ""} href="/replay">Replays</Link>
        <a href="https://github.com/chungchihhan/echo-maze">GitHub</a>
      </nav>
    </header>
  );
}
