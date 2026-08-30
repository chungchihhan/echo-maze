import type { Metadata } from "next";
import { ReplayLibrary } from "../replay-ui";
import { SiteHeader } from "../site-header";

export const metadata: Metadata = {
  title: "Replay Library — Echo Maze",
  description: "Choose a recorded Echo Maze agent run to inspect and replay.",
};

export default function ReplaysPage() {
  return (
    <main className="echo-app public-shell">
      <SiteHeader active="replays" />
      <section className="library-intro">
        <p className="eyebrow">REPLAY LIBRARY</p>
        <h1>Every run leaves<br /><em>a trail of decisions.</em></h1>
        <p>Choose a recorded run to inspect the Walker&apos;s observations, memory, movement, and mistakes.</p>
      </section>
      <ReplayLibrary />
    </main>
  );
}
