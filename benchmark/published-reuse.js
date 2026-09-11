/**
 * Strict reuse of completed episodes that were intentionally published.
 *
 * Suite size and fixture order are deliberately excluded: expanding a suite
 * from 3 to 6 mazes per tier must allow 001-003 to be reused. Every input that
 * can change one episode's behavior or score is included instead.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { sha256, stableStringify } from "./contract.js";

const IDENTITY_VERSION = 1;
const EPISODE_CONTRACT_FIELDS = [
  "benchmarkId",
  "benchmarkVersion",
  "policyRevision",
  "generatorVersion",
  "observationVersion",
  "routeLengthTiers",
  "maxTurns",
  "timeoutMs",
  "maxAttemptsPerTurn",
  "interRequestPacingMs",
  "interEpisodeCooldownMs",
  "rateLimitRetryBaseMs",
  "retryPolicy",
  "maxOutputTokensBase",
  "reasoningEffort",
  "aiTransport",
  "coordinateSystem",
  "hiddenStatePolicy",
  "promptHash",
  "schemaHash",
  "rulesHash",
  "mode",
  "resultClass",
  "provider",
  "apiEndpoint",
  "modelRequested",
];

const REUSABLE_TERMINAL_STATUSES = new Set([
  "solved",
  "unsolved_max_turns",
  "invalid_output",
  "api_failure",
]);

export function publishedEpisodeIdentity(manifest, fixture) {
  const identity = { version: IDENTITY_VERSION };
  for (const field of EPISODE_CONTRACT_FIELDS) identity[field] = manifest[field] ?? null;
  return {
    ...identity,
    suiteSeed: manifest.suiteSeed,
    fixtureId: fixture.fixtureId,
    fixtureHash: fixture.fixtureHash,
  };
}

export function publishedEpisodeIdentityHash(manifest, fixture) {
  return sha256(publishedEpisodeIdentity(manifest, fixture));
}

/** Remove provider request identifiers and error payloads before publishing. */
export function reusableTranscript(events) {
  return events.map((event) => {
    if (event.type !== "model_result") return event;
    return {
      ...event,
      attempts: (event.attempts ?? []).map((attempt) => ({
        attempt: attempt.attempt,
        latencyMs: attempt.latencyMs,
        modelRequested: attempt.modelRequested ?? null,
        modelReturned: attempt.modelReturned ?? null,
        status: attempt.status ?? null,
        usage: attempt.usage ?? null,
        errorCategory: attempt.errorCategory ?? null,
      })),
    };
  });
}

export function encodeReusableTranscript(events) {
  return reusableTranscript(events).map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** Load valid published artifacts once, preferring the newest duplicate. */
export function loadPublishedEpisodeCache(publicReplayDir) {
  const runsDir = path.join(publicReplayDir, "runs");
  if (!existsSync(runsDir)) return new Map();

  const candidates = [];
  for (const name of readdirSync(runsDir).filter((entry) => entry.endsWith(".json"))) {
    try {
      const detail = JSON.parse(readFileSync(path.join(runsDir, name), "utf8"));
      const reuse = detail.benchmark?.reuse;
      if (!reuse?.identity || typeof reuse.identityHash !== "string"
        || typeof reuse.transcript !== "string" || typeof reuse.transcriptHash !== "string") continue;
      if (sha256(reuse.identity) !== reuse.identityHash) continue;
      if (sha256(reuse.transcript) !== reuse.transcriptHash) continue;
      const events = reuse.transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const start = events.find((event) => event.type === "episode_start");
      const end = events.find((event) => event.type === "episode_end");
      if (reuse.identity.version !== IDENTITY_VERSION) continue;
      if (start?.fixtureId !== reuse.identity.fixtureId) continue;
      if (!REUSABLE_TERMINAL_STATUSES.has(end?.status)) continue;
      candidates.push({
        identity: reuse.identity,
        identityHash: reuse.identityHash,
        transcript: reuse.transcript,
        events,
        status: end.status,
        sourceRunId: detail.run?.id ?? name.replace(/\.json$/, ""),
        updatedAt: detail.run?.updatedAt ?? 0,
      });
    } catch {
      // A malformed or legacy public replay is never eligible for reuse.
    }
  }

  candidates.sort((a, b) => a.updatedAt - b.updatedAt);
  return new Map(candidates.map((candidate) => [candidate.identityHash, candidate]));
}

export function findPublishedEpisode(cache, manifest, fixture) {
  const identity = publishedEpisodeIdentity(manifest, fixture);
  const candidate = cache.get(sha256(identity));
  return candidate && stableStringify(candidate.identity) === stableStringify(identity)
    ? candidate
    : null;
}
