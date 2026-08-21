import { env } from "cloudflare:workers";

const MODEL = "gpt-5.6-luna";
const DIRECTIONS = ["up", "right", "down", "left"] as const;

type Direction = (typeof DIRECTIONS)[number];
type Point = { r: number; c: number };
type AgentRequest =
  | {
      role: "walker";
      turn: number;
      observation: {
        openDirections: Direction[];
        blockedDirections: Direction[];
        exitVisible: boolean;
        lastAction: Direction | null;
        lastResult: "moved" | "blocked" | null;
        navigatorInstruction: string;
      };
    }
  | {
      role: "navigator";
      turn: number;
      maze: {
        size: number;
        exit: Point;
        cells: Array<{ r: number; c: number; open: Direction[] }>;
      };
      previousCandidates: Point[];
      conversation: Array<{ actor: "walker" | "navigator"; turn: number; text: string }>;
    };

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function getOutputText(response: OpenAIResponse) {
  if (response.output_text) return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("The model returned no text output.");
}

async function createStructuredResponse(
  apiKey: string,
  instructions: string,
  input: unknown,
  schemaName: string,
  schema: Record<string, unknown>,
  maxOutputTokens: number,
  reasoningEffort: "none" | "low",
) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input: JSON.stringify(input),
      reasoning: { effort: reasoningEffort },
      max_output_tokens: maxOutputTokens,
      store: false,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const body = (await response.json()) as OpenAIResponse & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI request failed with status ${response.status}.`);
  }

  return JSON.parse(getOutputText(body)) as Record<string, unknown>;
}

function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && DIRECTIONS.includes(value as Direction);
}

function normalizeCandidates(value: unknown, size: number) {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, Point>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const { r, c } = candidate as Partial<Point>;
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    if ((r as number) < 0 || (r as number) >= size || (c as number) < 0 || (c as number) >= size) continue;
    unique.set(`${r},${c}`, { r: r as number, c: c as number });
  }
  return [...unique.values()].slice(0, size * size);
}

export async function POST(request: Request) {
  const apiKey = (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured on the server." }, 503);

  let payload: AgentRequest;
  try {
    payload = (await request.json()) as AgentRequest;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  try {
    if (payload.role === "walker") {
      const result = await createStructuredResponse(
        apiKey,
        [
          "You are Walker in Echo Maze.",
          "You do not know your absolute row or column and must never invent coordinates.",
          "You only know the supplied local observation and the Navigator's latest instruction.",
          "Give Navigator one concise Traditional Chinese sentence describing the previous move outcome and which absolute directions are open or blocked.",
          "Do not add facts that are absent from the observation.",
        ].join(" "),
        { turn: payload.turn, ...payload.observation },
        "walker_report",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            report: { type: "string", minLength: 1, maxLength: 180 },
          },
          required: ["report"],
        },
        220,
        "none",
      );
      const report = typeof result.report === "string" ? result.report.trim() : "";
      if (!report) throw new Error("Walker returned an empty report.");
      return json({ role: "walker", model: MODEL, report });
    }

    if (payload.role !== "navigator" || !payload.maze) {
      return json({ error: "Unknown agent role." }, 400);
    }

    const result = await createStructuredResponse(
      apiKey,
      [
        "You are Navigator in Echo Maze.",
        "You see the complete maze and exit, but you never receive Walker's true start or live position.",
        "Infer Walker's possible zero-based coordinates only from the maze, Walker reports, and your prior instructions.",
        "Keep every still-plausible candidate in candidate_positions; do not pretend localization is certain.",
        "Choose exactly one absolute movement direction that either distinguishes candidates or advances a localized Walker toward the exit.",
        "The message must be one concise Traditional Chinese sentence and must match direction.",
      ].join(" "),
      {
        turn: payload.turn,
        coordinateSystem: "zero-based rows increase downward; columns increase rightward",
        maze: payload.maze,
        previousCandidates: payload.previousCandidates,
        conversation: payload.conversation,
      },
      "navigator_instruction",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1, maxLength: 120 },
          direction: { type: "string", enum: DIRECTIONS },
          candidate_positions: {
            type: "array",
            maxItems: 81,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                r: { type: "integer", minimum: 0, maximum: 8 },
                c: { type: "integer", minimum: 0, maximum: 8 },
              },
              required: ["r", "c"],
            },
          },
        },
        required: ["message", "direction", "candidate_positions"],
      },
      700,
      "low",
    );

    const message = typeof result.message === "string" ? result.message.trim() : "";
    if (!message || !isDirection(result.direction)) {
      throw new Error("Navigator returned an invalid instruction.");
    }

    return json({
      role: "navigator",
      model: MODEL,
      message,
      direction: result.direction,
      candidates: normalizeCandidates(result.candidate_positions, payload.maze.size),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent request failed.";
    console.error("Echo Maze agent error:", message);
    return json({ error: message }, 502);
  }
}
