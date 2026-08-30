import Link from "next/link";

type SiteHeaderProps = { active?: "home" | "replays" };

export function SiteHeader({ active }: SiteHeaderProps) {
  return (
    <header className="topbar public-topbar">
      <Link className="brand-lockup brand-link" href="/" aria-label="Echo Maze home">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div>
          <div className="brand-name">ECHO MAZE</div>
          <div className="brand-subtitle">observable AI navigation benchmark</div>
        </div>
      </Link>
      <nav className="site-nav" aria-label="Primary navigation">
        <Link className={active === "home" ? "is-active" : ""} href="/">Observe</Link>
        <Link className={active === "replays" ? "is-active" : ""} href="/replays">Replays</Link>
        <a href="https://github.com/chungchihhan/echo-maze">GitHub</a>
      </nav>
    </header>
  );
}
