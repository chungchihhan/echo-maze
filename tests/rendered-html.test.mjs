import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Echo Maze observation homepage", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Echo Maze — Observable AI Navigation Benchmark<\/title>/i);
  assert.match(html, /ECHO MAZE/);
  assert.match(text, /ONGOING AGENT OBSERVATION/);
  assert.match(text, /continuously replays recorded benchmark runs/i);
  assert.doesNotMatch(text, /AGENT 01 · NAVIGATOR|AGENT 02 · WALKER|Shared conversation|Navigator locates/);
  assert.match(text, /conversation-only memory/i);
  assert.match(text, /optimal routes 16\s*[–-]\s*39 moves/i);
  assert.match(text, /Observe Replays GitHub/);
  assert.doesNotMatch(text, /Export replay|New maze|Ask Walker|Auto-run/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("server-renders the Replay Library as a separate destination", async () => {
  const response = await render("/replays");
  assert.equal(response.status, 200);
  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Replay Library — Echo Maze<\/title>/i);
  assert.match(text, /Every run leaves a trail of decisions\./i);
  assert.match(text, /Choose a recorded run/i);
});

test("published benchmark index is valid and any published runs are replayable", async () => {
  const index = JSON.parse(await readFile(new URL("../public/replay-data/index.json", import.meta.url), "utf8"));
  assert.equal(index.version, 1);
  assert.ok(Array.isArray(index.runs));
  assert.ok(index.runs.every((run) => run.max_turn > 0));
  assert.ok(index.runs.every((run) => run.playback_duration_ms > 0));

  const runId = index.runs[0]?.id;
  if (!runId) return;
  const detail = JSON.parse(await readFile(new URL(`../public/replay-data/runs/${runId}.json`, import.meta.url), "utf8"));
  assert.equal(detail.source, "benchmark");
  assert.equal(detail.run.id, runId);
  assert.equal(detail.run.maze.cells.length, 9);
  assert.ok(detail.events.some((event) => event.type === "agent_request"));
  assert.ok(detail.events.some((event) => event.type === "solo_walker_response"));
  assert.ok(detail.events.some((event) => event.type === "solo_walker_move"));
  assert.doesNotMatch(JSON.stringify(detail), /requestId|responseId|input_tokens|conversation/);
});

test("the Solo Walker shell shares one pure maze core with the benchmark", async () => {
  const [page, replayUi, route, replayRoute, schema, hosting, layout, packageJson, mazeCore] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/replay-ui.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/replays/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/maze/index.js", import.meta.url), "utf8"),
  ]);

  // UI consumes the shared pure core instead of private maze logic.
  assert.match(replayUi, /from "\.\.\/lib\/maze\/index\.js"/);
  assert.match(replayUi, /visibleWalkerPoints\(/);
  assert.match(replayUi, /buildReplayFrames/);
  assert.match(replayUi, /HomeReplayChannel/);
  assert.match(replayUi, /ReplayLibrary/);
  assert.match(replayUi, /ReplayDetailViewer/);
  assert.match(page, /MIN_ROUTE_LENGTH/);
  assert.match(page, /MAX_ROUTE_LENGTH/);
  assert.doesNotMatch(page + replayUi, /requestAgent|recordReplay|Export replay|Auto-run/);
  assert.doesNotMatch(page + replayUi, /navigatorCandidates|localization_evaluation|route_acquired|relocalization|walker_check/);

  // The agent route is Solo-Walker-only against the Responses API.
  assert.equal(mazeCore.includes("react"), false);
  assert.equal(mazeCore.includes("cloudflare"), false);
  assert.equal(mazeCore.includes("openai"), false);
  assert.match(route, /const MODEL = "gpt-5\.6-luna"/);
  assert.match(route, /You are the Walker inside Echo Maze\./);
  assert.match(route, /role !== "solo_walker"/);
  assert.doesNotMatch(route, /role: "navigator"|role: "walker"|routeBetween|deterministic route tool/);
  assert.match(route, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(route, /const timeoutMs = 90_000/);
  assert.match(route, /incomplete_details/);
  assert.match(route, /maxOutputTokens \* attempt/);
  assert.match(route, /invalid_structured_json/);

  // Persistence and runtime boundaries unchanged.
  assert.match(replayRoute, /CREATE TABLE IF NOT EXISTS replay_runs/);
  assert.match(replayRoute, /CREATE TABLE IF NOT EXISTS replay_events/);
  assert.match(schema, /replayRuns/);
  assert.match(schema, /replayEvents/);
  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(layout, /Echo Maze/);
  assert.match(packageJson, /"benchmark:run"/);
  assert.match(packageJson, /"benchmark:verify"/);
  assert.match(packageJson, /"replay:publish"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
