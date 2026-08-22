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

test("server-renders the Echo Maze prototype", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Echo Maze — Observable Agent Cooperation<\/title>/i);
  assert.match(html, /ECHO MAZE/);
  assert.match(html, /AGENT 01 · NAVIGATOR/);
  assert.match(html, /AGENT 02 · WALKER/);
  assert.match(html, /完整迷宮地圖/);
  assert.match(html, /Walker 沿通道延伸的直線視野/);
  assert.match(html, /EVENT STREAM/);
  assert.match(html, /Shared conversation/);
  assert.match(html, /Walker report/);
  assert.match(html, /Navigator locates/);
  assert.match(text, /LIVE · GPT-5.6 LUNA/);
  const routeLength = Number(text.match(/optimal (\d+) steps/)?.[1]);
  assert.ok(routeLength >= 24, `expected route length >= 24, received ${routeLength}`);
  assert.doesNotMatch(text, /18% NOISE|ORACLE BASELINE/);
  assert.doesNotMatch(text, /ACTUAL WALKER|Walker 真實位置|observer overlay/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("the product shell uses isolated live agents and durable replays", async () => {
  const [page, route, replayRoute, schema, hosting, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/replays/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /generateMaze/);
  assert.match(page, /requestAgent<WalkerAgentResponse>/);
  assert.match(page, /requestAgent<NavigatorAgentResponse>/);
  assert.match(page, /const MIN_ROUTE_LENGTH = 24/);
  assert.match(page, /navigatorCandidates/);
  assert.match(page, /conversation: ConversationEntry\[\]/);
  assert.match(page, /conversation: snapshot\.conversation/);
  assert.match(page, /localization_evaluation/);
  assert.match(page, /route_acquired/);
  assert.match(page, /relocalization/);
  assert.match(page, /navigatorRoute/);
  assert.match(page, /route-line/);
  assert.match(page, /walkerSightlines/);
  assert.match(page, /visibleWalkerPoints/);
  assert.match(page, /local-hidden/);
  assert.match(page, /recordReplay/);
  assert.match(page, /Export replay/);
  assert.match(page, /type GamePhase = "walker_report" \| "navigator_reply" \| "walker_check" \| "walker_move"/);
  assert.match(page, /requestAgent<WalkerCheckResponse>/);
  assert.doesNotMatch(page, /describeWalker|chooseInstruction|locateCandidates/);
  assert.match(route, /const MODEL = "gpt-5\.6-luna"/);
  assert.match(route, /You do not know your absolute row or column/);
  assert.match(route, /must verify Navigator's instruction before moving/);
  assert.match(route, /blockedDirections\.includes/);
  assert.match(route, /function routeBetween/);
  assert.match(route, /deterministic route tool/);
  assert.match(route, /navigationMode/);
  assert.match(route, /you never receive Walker's true start or live position/);
  assert.match(route, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(route, /const timeoutMs = 90_000/);
  assert.match(route, /incomplete_details/);
  assert.match(route, /maxOutputTokens \* attempt/);
  assert.match(route, /invalid_structured_json/);
  assert.match(replayRoute, /CREATE TABLE IF NOT EXISTS replay_runs/);
  assert.match(replayRoute, /CREATE TABLE IF NOT EXISTS replay_events/);
  assert.match(schema, /replayRuns/);
  assert.match(schema, /replayEvents/);
  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(layout, /Echo Maze/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
