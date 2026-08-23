import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
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

test("server-renders the Echo Maze Solo Walker shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Echo Maze — Observable Agent Cooperation<\/title>/i);
  assert.match(html, /ECHO MAZE/);
  // Current product framing: one Solo Walker, no Navigator/Walker pair.
  assert.match(text, /SOLO WALKER · GPT-5\.6 LUNA/);
  assert.doesNotMatch(text, /AGENT 01 · NAVIGATOR|AGENT 02 · WALKER|Shared conversation|Navigator locates/);
  assert.match(text, /conversation-only memory/i);
  const routeLength = Number(text.match(/optimal (\d+) steps/)?.[1]);
  assert.ok(routeLength >= 24, `expected route length >= 24, received ${routeLength}`);
  assert.match(text, /Walls block sight; Walker has no absolute coordinates or complete map\./);
  assert.match(text, /Export replay/);
  assert.match(text, /REPLAY LIBRARY/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("the Solo Walker shell shares one pure maze core with the benchmark", async () => {
  const [page, route, replayRoute, schema, hosting, layout, packageJson, mazeCore] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/replays/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/maze/index.js", import.meta.url), "utf8"),
  ]);

  // UI consumes the shared pure core instead of private maze logic.
  assert.match(page, /from "\.\.\/lib\/maze\/index\.js"/);
  assert.match(page, /generateMaze/);
  assert.match(page, /observeWalkerCell\(/);
  assert.match(page, /visibleWalkerPoints\(/);
  assert.match(page, /canMove\(/);
  assert.match(page, /requestAgent<SoloWalkerResponse>/);
  assert.match(page, /MIN_ROUTE_LENGTH/);
  assert.match(page, /type GamePhase = "walker_think" \| "walker_move"/);
  assert.match(page, /recordReplay/);
  assert.match(page, /Export replay/);
  assert.doesNotMatch(page, /navigatorCandidates|localization_evaluation|route_acquired|relocalization|walker_check/);

  // The agent route is Solo-Walker-only against the Responses API.
  assert.equal(mazeCore.includes("react"), false);
  assert.equal(mazeCore.includes("cloudflare"), false);
  assert.equal(mazeCore.includes("openai"), false);
  assert.match(route, /const MODEL = "gpt-5\.6-luna"/);
  assert.match(route, /You are the only agent inside Echo Maze\./);
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
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
