import type { Metadata } from "next";
import Link from "next/link";
import { ReplayDetailViewer } from "../../replay-ui";
import { SiteHeader } from "../../site-header";

type ReplayPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: ReplayPageProps): Promise<Metadata> {
  const { id } = await params;
  const shortId = id.slice(0, 8);
  const title = `Replay ${shortId} — Echo Maze`;
  const description = `Inspect recorded Echo Maze run ${shortId}, turn by turn.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [] },
    twitter: { title, description, images: [] },
  };
}

export default async function ReplayPage({ params }: ReplayPageProps) {
  const { id } = await params;
  return (
    <main className="echo-app public-shell detail-shell">
      <SiteHeader active="replays" />
      <div className="detail-back"><Link href="/replays">← Replay Library</Link><span>Detailed replay</span></div>
      <ReplayDetailViewer runId={id} />
    </main>
  );
}
