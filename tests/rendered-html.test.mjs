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
  assert.match(html, /<title>Echo Maze — Observable Agent Cooperation<\/title>/i);
  assert.match(html, /ECHO MAZE/);
  assert.match(html, /AGENT 01 · NAVIGATOR/);
  assert.match(html, /AGENT 02 · WALKER/);
  assert.match(html, /完整迷宮地圖/);
  assert.match(html, /Walker 的 3×3 局部視野/);
  assert.match(html, /Event stream/);
  assert.match(html, /Step round/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/);
});

test("the product shell no longer depends on starter preview files", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /generateMaze/);
  assert.match(page, /describeWalker/);
  assert.match(page, /chooseInstruction/);
  assert.match(layout, /Echo Maze/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
