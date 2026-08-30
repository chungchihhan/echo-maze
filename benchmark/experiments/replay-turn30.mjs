/**
 * One-off diagnostic: rebuild the exact turn-30 request from a transcript and
 * replay it against GLM to capture FULL raw outputs. Not part of the contract.
 */
import { readFileSync } from "node:fs";
import { WALKER_PROMPT, OUTPUT_FRAMING, RESPONSE_SCHEMA, RESPONSE_SCHEMA_NAME, REASONING_EFFORT, MAX_OUTPUT_TOKENS_BASE } from "../contract.js";

const fid = process.argv[2] ?? "echo-maze-bench-v0-01";
const replayTurn = Number(process.argv[3] ?? 30);
const samples = Number(process.argv[4] ?? 3);

const events = readFileSync(`results/live-glm53-flash-r1/episodes/${fid}/transcript.jsonl`, "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const observations = new Map();
const results = new Map();
for (const e of events) {
  if (e.type === "turn_start") observations.set(e.turn, e.observation);
  if (e.type === "move") results.set(e.turn, e.result);
}

// Rebuild conversation exactly like episode.js
const conversation = [];
for (const e of events) {
  if (e.type !== "model_result" || !e.parsed) continue;
  if (e.turn >= replayTurn) break;
  conversation.push({
    turn: e.turn,
    observation: observations.get(e.turn),
    observationSummary: e.parsed.observation_summary,
    reasoning: e.parsed.reasoning_summary,
    believedPosition: e.parsed.believed_position,
    coordinateNote: e.parsed.coordinate_note,
    direction: e.parsed.direction,
    result: results.get(e.turn) ?? null,
  });
}

const userContent = JSON.stringify({
  turn: replayTurn,
  currentObservation: observations.get(replayTurn),
  conversation,
}) + OUTPUT_FRAMING;

console.error(`replaying ${fid} turn ${replayTurn}; conversation entries=${conversation.length}; user content chars=${userContent.length}`);

for (let i = 1; i <= samples; i += 1) {
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Echo Maze Replay Diagnostic",
    },
    body: JSON.stringify({
      model: "z-ai/glm-5.3-flash",
      messages: [
        { role: "system", content: WALKER_PROMPT },
        { role: "user", content: userContent },
      ],
      reasoning: { effort: REASONING_EFFORT },
      max_tokens: MAX_OUTPUT_TOKENS_BASE,
      response_format: {
        type: "json_schema",
        json_schema: { name: RESPONSE_SCHEMA_NAME, strict: true, schema: RESPONSE_SCHEMA },
      },
    }),
  });
  const body = await res.json();
  console.log(`\n===== sample ${i} (${Date.now() - started}ms) =====`);
  if (body.error) { console.log("API ERROR:", JSON.stringify(body.error)); continue; }
  const ch = body.choices?.[0];
  console.log("finish_reason:", ch?.finish_reason);
  console.log("native_finish_reason:", ch?.native_finish_reason);
  console.log("usage:", JSON.stringify(body.usage && {
    prompt: body.usage.prompt_tokens, completion: body.usage.completion_tokens,
    reasoning: body.usage.completion_tokens_details?.reasoning_tokens,
  }));
  const content = ch?.message?.content ?? "";
  console.log("--- FULL RAW CONTENT (len=" + content.length + ") ---");
  console.log(content);
}
