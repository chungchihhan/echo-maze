import { MAX_ROUTE_LENGTH, MIN_ROUTE_LENGTH } from "../lib/maze/types.js";
import { HomeReplayChannel } from "./replay-ui";
import { SiteHeader } from "./site-header";

export default function HomePage() {
  return (
    <main className="echo-app public-shell">
      <SiteHeader active="home" />

      <section className="watch-intro">
        <div>
          <p className="eyebrow">ONGOING AGENT OBSERVATION</p>
          <h1>Can one agent remember<br /><em>the maze it cannot see?</em></h1>
        </div>
        <p className="watch-intro-copy">
          Echo Maze continuously replays recorded benchmark runs. The Walker sees only open corridors and
          remembers the maze through its own conversation history.
        </p>
      </section>

      <HomeReplayChannel />

      <section className="benchmark-note" aria-label="Benchmark rules">
        <span>CONVERSATION-ONLY MEMORY</span>
        <p>No map · no route tool · no notebook · optimal routes {MIN_ROUTE_LENGTH}–{MAX_ROUTE_LENGTH} moves</p>
      </section>
    </main>
  );
}
