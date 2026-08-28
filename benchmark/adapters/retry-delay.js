/**
 * Shared transport retry backoff.
 *
 * Retry-After may be either a number of seconds or an HTTP date. When it is
 * absent, use bounded exponential backoff. The delay starts after the failed
 * response is received; request latency is intentionally not subtracted from
 * it because Retry-After is a response-relative wait instruction.
 */

/**
 * @param {string | null} retryAfterHeader
 * @param {number} attempt
 * @param {number} [baseMs]
 * @param {number} [nowMs]
 */
export function computeRetryDelayMs(retryAfterHeader, attempt, baseMs = 2000, nowMs = Date.now()) {
  const seconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const retryAt = retryAfterHeader ? Date.parse(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAt)) return Math.max(0, retryAt - nowMs);

  // OpenAI reset headers may use compact durations such as "1s", "1m30s",
  // or "2m3.5s" instead of Retry-After's seconds/date formats.
  const durationMs = parseDurationMs(retryAfterHeader);
  if (durationMs !== null) return durationMs;

  return Math.min(120_000, baseMs * 2 ** (attempt - 1));
}

/** @param {string | null} value */
export function parseDurationMs(value) {
  if (!value) return null;
  const match = value.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i);
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  return Math.ceil(
    Number(hours ?? 0) * 3_600_000
    + Number(minutes ?? 0) * 60_000
    + Number(seconds ?? 0) * 1_000
    + Number(milliseconds ?? 0),
  );
}

/**
 * @param {string | null} retryAfterHeader
 * @param {number} attempt
 * @param {number} [baseMs]
 * @param {(waitMs: number) => Promise<void>} [sleepImpl]
 */
export async function retryDelay(
  retryAfterHeader,
  attempt,
  baseMs = 2000,
  sleepImpl = (waitMs) => new Promise((resolve) => setTimeout(resolve, waitMs)),
) {
  const waitMs = computeRetryDelayMs(retryAfterHeader, attempt, baseMs);
  await sleepImpl(waitMs);
}
