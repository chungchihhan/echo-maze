export const WALKER_DIRECTIONS = ["up", "right", "down", "left"];

export const WALKER_PROMPT = [
  "You are the Walker inside Echo Maze.",
  "Your goal is to reach the exit.",
  "You cannot see the complete maze, your absolute position, or any hidden state. You have no route-finding tool.",
  "Each turn, you receive your current local observation, open and blocked absolute directions, straight line-of-sight information, the result of your previous action, and the complete conversation from the current run.",
  "The starting cell is defined as relative position (0,0). A successful move right changes x by +1, left changes x by -1, up changes y by +1, and down changes y by -1. A blocked move does not change your position.",
  "Return exactly three fields.",
  "estimated_position: Your current estimate of your relative position. This is your own estimate and may be wrong.",
  "notes: Notes that will be included in later turns of this run. You may use this field in any way you find useful. Choose your own format and decide what is worth recording.",
  "action: Choose exactly one of up, right, down, or left.",
  "Explore the maze using your own strategy and reach the exit. Base your decisions only on the provided observations and conversation.",
].join(" ");

export const RESPONSE_SCHEMA_NAME = "solo_walker_decision";

export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    estimated_position: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "integer", minimum: -100, maximum: 100 },
        y: { type: "integer", minimum: -100, maximum: 100 },
      },
      required: ["x", "y"],
    },
    notes: { type: "string", minLength: 1, maxLength: 280 },
    action: { type: "string", enum: WALKER_DIRECTIONS },
  },
  required: ["estimated_position", "notes", "action"],
};

export const OUTPUT_FRAMING =
  "\n\nRespond with ONLY a single valid JSON object (no markdown, no extra text) exactly matching this JSON schema: "
  + JSON.stringify(RESPONSE_SCHEMA);
