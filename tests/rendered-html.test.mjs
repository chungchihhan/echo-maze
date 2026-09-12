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

test("server-renders a landing page with the featured Walker replay", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Echo Maze — Memory in Motion<\/title>/i);
  assert.match(html, /echo-maze-icon\.png/);
  assert.match(text, /ECHO MAZE/);
  assert.match(text, /Maze exploration without a map/);
  assert.match(text, /The EMZ Benchmark for memory-driven AI agents/);
  assert.doesNotMatch(text, /Watch one agent remember what it saw/);
  assert.match(text, /RECORDED WALKER RUN/);
  assert.match(text, /One turn at a time/);
  assert.match(text, /EMZ-V0-02/);
  assert.match(text, /AGENT OUTPUT/);
  assert.match(text, /TURN/);
  assert.match(text, /LAST ACTION/);
  assert.match(text, /MODEL ESTIMATE/);
  assert.match(text, /MOVES/);
  assert.match(text, /WALL HITS/);
  assert.match(text, /Exploring the maze/);
  assert.match(text, /shortest path 26 moves/i);
  assert.match(text, /ACTION/);
  assert.doesNotMatch(text, /WALKER OUTPUT|ENVIRONMENT RESULT|COORDINATE STATUS/);
  assert.doesNotMatch(text, /OUTCOME/);
  assert.match(text, /EMZ BENCHMARK/);
  assert.match(text, /Memory in Motion/);
  assert.match(text, /The exit is only half the story/);
  assert.match(text, /Partial observability/);
  assert.match(text, /Explore benchmark results/);
  assert.match(html, /href="\/benchmark"/);
  assert.match(html, /class="landing-footer"/);
  assert.match(html, /aria-label="Footer navigation"/);
  assert.match(text, /Where AI memory finds its way/);
  assert.match(html, /app-navigation/);
  assert.match(html, /aria-label="Open navigation"/);
  assert.match(html, /Drag to reposition/);
  assert.match(html, /href="https:\/\/github\.com\/chungchihhan\/echo-maze"/);
  assert.match(html, /landing-agent-output/);
  assert.match(html, /landing-model-action/);
  assert.match(await readFile(new URL("../app/globals.css", import.meta.url), "utf8"), /\.landing-model-action\.is-active strong \{ color: var\(--cobalt\); \}/);
  assert.match(html, /href="\/replay"/);
  assert.doesNotMatch(text, /REPLAY LIBRARY|Review any recorded run/);
  assert.doesNotMatch(html, /class="footer-note"/);
  assert.doesNotMatch(text, /minimum optimal route/);
  assert.doesNotMatch(text, /\bLab\b|LIVE LAB/);
  assert.doesNotMatch(html, /href="\/lab"/);
  assert.doesNotMatch(text, /AGENT 01 · NAVIGATOR|AGENT 02 · WALKER|Shared conversation|Navigator locates/);
  assert.doesNotMatch(text, /New maze|Ask Walker|Auto-run|Walker's reasoning log/);
  assert.doesNotMatch(text, /3D memory field|auto orbit|RECORDED WALKER RUNS/);
  assert.doesNotMatch(text, /Walls block sight; Walker has no absolute coordinates or complete map/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("server-renders the complete replay workspace", async () => {
  const response = await render("/replay");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /REPLAY LIBRARY/);
  assert.match(text, /recorded runs/);
  assert.doesNotMatch(text, /NOW PLAYING/);
  assert.match(text, /gpt-5\.6-luna/);
  assert.match(text, /AGENT OUTPUT/);
  assert.match(text, /ENVIRONMENT INPUT/);
  assert.match(text, /MODEL ESTIMATE/);
  assert.match(text, /EMZ-V0-02/);
  assert.match(text, /WALL HITS/);
  assert.match(text, /shortest path 26 moves/);
  assert.doesNotMatch(text, /OUTCOME/);
  assert.match(html, /app-navigation/);
  assert.match(html, /href="https:\/\/github\.com\/chungchihhan\/echo-maze"/);
  assert.match(text, /Spectator View/);
  assert.match(html, /aria-label="Replay views"/);
  assert.match(text, /Library Maze Output/);
  assert.match(html, /replay-transport-play/);
  assert.match(html, /replay-speed-picker/);
  assert.match(html, /aria-keyshortcuts="Space"/);
  assert.match(html, /aria-keyshortcuts="Shift\+ArrowLeft"/);
  assert.match(html, /aria-keyshortcuts="Shift\+Comma Shift\+Period"/);
  assert.doesNotMatch(text, /Watch one agent remember what it saw/);
  assert.doesNotMatch(html, /class="footer-note"/);
});

test("does not expose a live Lab route", async () => {
  const response = await render("/lab");
  assert.equal(response.status, 404);
});

test("server-renders the published Replay Library destination", async () => {
  const response = await render("/replays");
  assert.equal(response.status, 200);
  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Replay Library — Echo Maze<\/title>/i);
  assert.match(text, /Every run leaves a trail of decisions\./i);
  assert.match(text, /Choose a recorded run/i);
});

test("server-renders the published benchmark leaderboard", async () => {
  const response = await render("/benchmark");
  assert.equal(response.status, 200);
  const html = await response.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(html, /<title>Benchmark Results — Echo Maze<\/title>/i);
  assert.match(text, /Memory, measured\./i);
  assert.doesNotMatch(text, /observable AI navigation benchmark/i);
  assert.doesNotMatch(html, />Observe<\/a>/i);
  assert.match(text, /Same maze\. Different memory\./i);
  assert.match(text, /emz-public-v0/i);
  assert.match(text, /grok-4\.6/i);
  assert.match(text, /gpt-5\.6-luna/i);
  assert.match(text, /deepseek-v4\.1-flash/i);
  assert.match(text, /Run evidence/i);
  assert.match(text, /Open Replay workspace/i);
  assert.match(html, /href="\/replay\?run=emz-public-v0/i);
  assert.match(html, />Replays<\/a>/i);
  assert.doesNotMatch(html, /href="\/replays">Replays<\/a>/i);
});

test("published benchmark index is valid and its runs are replayable", async () => {
  const index = JSON.parse(await readFile(new URL("../public/replay-data/index.json", import.meta.url), "utf8"));
  assert.equal(index.version, 1);
  assert.ok(Array.isArray(index.runs));
  assert.ok(index.runs.every((run) => run.max_turn > 0));
  assert.ok(index.runs.every((run) => run.playback_duration_ms > 0));
  assert.ok(index.runs.every((run) => typeof run.featured === "boolean"));
  assert.ok(index.runs.every((run) => run.reasoning_effort === "low"));
  assert.ok(index.runs.every((run) => /^emz-v0-(easy|medium|hard)-\d{3}$/.test(run.maze_seed)));
  assert.ok(index.runs.every((run) => run.id.endsWith(`--${run.maze_seed}`)));
  assert.deepEqual(index.runs.map((run) => run.homepage_order), index.runs.map((_run, index) => index + 1));

  const runId = index.runs[0]?.id;
  if (!runId) return;
  const detail = JSON.parse(await readFile(new URL(`../public/replay-data/runs/${runId}.json`, import.meta.url), "utf8"));
  assert.equal(detail.source, "benchmark");
  assert.equal(detail.benchmark.benchmarkName, "Echo Maze Benchmark");
  assert.equal(detail.benchmark.benchmarkShortName, "EMZ Benchmark");
  assert.equal(detail.benchmark.benchmarkTheme, "Memory in Motion");
  assert.equal(detail.benchmark.reasoningEffort, "low");
  assert.equal(detail.run.id, runId);
  assert.equal(detail.run.maze.cells.length, 9);
  assert.ok(detail.events.some((event) => event.type === "agent_request"));
  assert.ok(detail.events.some((event) => event.type === "solo_walker_response"));
  assert.ok(detail.events.some((event) => event.type === "solo_walker_move"));
  assert.doesNotMatch(JSON.stringify(detail), /"(?:requestId|responseId|conversation)"\s*:/);
});

test("the Solo Walker shell shares one pure maze core with the benchmark", async () => {
  const [page, shared, replayPage, replayUi, mazeSight, mazeStructure, heroMaze, styles, demoSource, demoDataSource, route, replayRoute, schema, wranglerSource, layout, packageJson, mazeCore, aiClient, decisionContract] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/echo-maze.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/replay/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/replay-ui.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/maze-sight.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/maze-structure.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hero-maze.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/demo-replay.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/demo-replay.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/replays/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/maze/index.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai/vercel-client.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai/walker-decision.js", import.meta.url), "utf8"),
  ]);

  // The public home mounts the featured replay; the full replay presentation has its own route.
  assert.match(page, /LandingPage/);
  assert.match(replayPage, /ReplayHome/);
  assert.match(demoSource, /live-luna-r3/);
  assert.match(demoSource, /echo-maze-bench-v0-02/);
  assert.match(demoSource, /status: "solved"/);
  assert.match(demoSource, /turns: 68/);
  const demoData = JSON.parse(demoDataSource);
  const demoResponses = demoData.events.filter((event) => event.type === "solo_walker_response");
  const demoMoves = demoData.events.filter((event) => event.type === "solo_walker_move");
  assert.equal(demoData.run.status, "won");
  assert.equal(demoResponses.length, 68);
  assert.equal(demoMoves.length, 68);
  assert.equal(demoMoves.at(-1).payload.won, true);
  assert.deepEqual(demoMoves.at(-1).payload.to, { r: 2, c: 8 });
  assert.match(shared, /from "\.\.\/lib\/maze\/index\.js"/);
  assert.match(shared, /generateMaze/);
  assert.match(shared, /observeWalkerCell\(/);
  assert.match(shared, /MazeSightLayer/);
  assert.match(shared, /MazeStructure/);
  assert.match(shared, /canMove\(/);
  assert.match(shared, /requestAgent<SoloWalkerResponse>/);
  assert.match(shared, /MIN_ROUTE_LENGTH/);
  assert.match(shared, /type GamePhase = "walker_think" \| "walker_move"/);
  assert.match(shared, /recordReplay/);
  assert.match(shared, /Export replay/);
  assert.match(shared, /Spectator View/);
  assert.match(shared, /Walker View/);
  assert.match(shared, /animationKey=\{thought\.turn\}/);
  // Reduced-motion CSS removes transitions, but the recorded content must
  // continue advancing because the landing replay has no playback controls.
  assert.doesNotMatch(shared, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\) return undefined/);
  assert.doesNotMatch(shared, /navigatorCandidates|localization_evaluation|route_acquired|relocalization|walker_check/);

  // The published replay UI is observation-only and also uses the shared maze core.
  assert.match(replayUi, /from "\.\.\/lib\/maze\/index\.js"/);
  assert.match(replayUi, /MazeSightLayer/);
  assert.match(replayUi, /MazeStructure/);
  assert.match(replayUi, /buildReplayFrames/);
  assert.match(replayUi, /HomeReplayChannel/);
  assert.match(replayUi, /ReplayLibrary/);
  assert.match(replayUi, /ReplayDetailViewer/);
  assert.match(replayUi, /Spectator View/);
  assert.match(replayUi, /Walker View/);
  assert.match(mazeSight, /maze-sight-walls/);
  assert.match(mazeSight, /walker-wall-gradient/);
  assert.match(mazeSight, /mergeCollinearWalls/);
  assert.match(mazeSight, /visibleWallIntervals/);
  assert.match(mazeSight, /pointIsOccluded/);
  assert.doesNotMatch(mazeSight, /clipPath/);
  assert.doesNotMatch(mazeStructure, /showWallLight|wallLightOpacity|maze-structure-walls-lit/);
  assert.match(heroMaze, /transformedPosition = instanceMatrix \* transformedPosition/);
  assert.match(heroMaze, /transformedNormal = mat3\(instanceMatrix\) \* transformedNormal/);
  assert.match(styles, /maze-structure-walls-base/);
  assert.match(mazeSight, /visibilityPolygon/);
  assert.match(mazeSight, /raySegmentIntersection/);
  assert.match(mazeSight, /wallSegments/);
  assert.match(mazeSight, /feGaussianBlur/);
  assert.match(mazeSight, /radialGradient/);
  assert.match(mazeSight, /data-sight-renderer="visibility-polygon"/);
  assert.doesNotMatch(mazeSight, /rayVisibility|import\("vgpu"\)|bounceRadiance/);
  assert.doesNotMatch(replayUi, /requestAgent|recordReplay|Export replay|Auto-run/);

  // The agent route is Solo-Walker-only through the shared SDK boundary.
  assert.equal(mazeCore.includes("react"), false);
  assert.equal(mazeCore.includes("cloudflare"), false);
  assert.equal(mazeCore.includes("openai"), false);
  assert.match(route, /const MODEL = "gpt-5\.6-luna"/);
  assert.match(decisionContract, /You are the Walker inside Echo Maze\./);
  assert.match(route, /role !== "solo_walker"/);
  assert.doesNotMatch(route, /role: "navigator"|role: "walker"|routeBetween|deterministic route tool/);
  assert.match(route, /const timeoutMs = 90_000/);
  assert.match(route, /createEchoMazeAIClient/);
  assert.match(route, /maxOutputTokens: 900 \* attempt/);
  assert.match(route, /invalid_structured_json/);
  assert.match(aiClient, /createOpenAI/);
  assert.match(aiClient, /createOpenRouter/);
  assert.match(aiClient, /\.responses\(config\.model\)/);
  assert.match(aiClient, /\.chat\(config\.model\)/);
  assert.match(aiClient, /maxRetries: 0/);

  // Persistence, hosting, and runtime boundaries remain compatible.
  assert.match(replayRoute, /CREATE TABLE IF NOT EXISTS replay_runs/);
  assert.match(replayRoute, /CREATE TABLE IF NOT EXISTS replay_events/);
  assert.match(route, /ENABLE_LIVE_API !== "true"/);
  assert.match(replayRoute, /ENABLE_LIVE_API.*=== "true"/s);
  assert.match(schema, /replayRuns/);
  assert.match(schema, /replayEvents/);
  const wrangler = JSON.parse(wranglerSource);
  assert.equal(wrangler.name, "echo-maze");
  assert.equal(wrangler.vars.ENABLE_LIVE_API, "false");
  assert.equal("d1_databases" in wrangler, false);
  assert.equal("images" in wrangler, false);
  assert.match(layout, /Echo Maze/);
  assert.match(packageJson, /"preview"/);
  assert.match(packageJson, /"deploy"/);
  assert.match(packageJson, /"benchmark:run"/);
  assert.match(packageJson, /"benchmark:verify"/);
  assert.match(packageJson, /"replay:publish"/);
  assert.match(packageJson, /"ai"/);
  assert.match(packageJson, /"@ai-sdk\/openai"/);
  assert.match(packageJson, /"@openrouter\/ai-sdk-provider"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
