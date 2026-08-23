/**
 * Tolerant JSON object extraction (policy v0.2+).
 *
 * This is a parsing-layer convention, not model repair: the answer content is
 * never altered. We only decide which span of the response counts as the
 * model's formal answer:
 *
 * 1. The whole response parses as JSON directly, OR
 * 2. A markdown code fence is stripped and the inner text parses, OR
 * 3. The first complete, string-aware, brace-balanced `{...}` object is
 *    extracted and parsed.
 *
 * Truncated or genuinely malformed JSON still fails — nothing is ever
 * re-asked, rewritten, or fixed.
 */

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 * @throws {SyntaxError} when no parseable JSON object exists
 */
export function extractJsonObject(text) {
  const raw = String(text ?? "");
  // 1. Direct parse.
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }
  // 2. Markdown-fenced content.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  // 3. Try each complete brace-balanced object (string/escape aware) in
  // order of appearance until one parses.
  for (const candidate of balancedObjectSpans(raw)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate span
    }
  }
  throw new SyntaxError("No parseable JSON object found in response.");
}

/**
 * @param {string} text
 * @yields {string}
 */
function* balancedObjectSpans(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
      if (depth < 0) break; // unbalanced input; give up on scanning
    }
  }
}
