/**
 * Decision field normalization (policy v0.4).
 *
 * Like tolerant JSON extraction, this is an envelope convention, not content
 * repair: when a model answers with a well-formed decision under a different
 * but unambiguous field name, the value is re-keyed to the canonical schema
 * field. Values are never invented — canonical fields always win, and an
 * alias is only used when the canonical field is absent.
 */

/** @type {Record<string, string[]>} canonical field -> accepted aliases */
const FIELD_ALIASES = {
  observation_summary: ["observationSummary", "observation_summary", "observation"],
  reasoning_summary: ["reasoningSummary", "reasoning", "thoughts", "thinking"],
  coordinate_note: ["coordinateNote", "coordinate_notes", "note", "notes"],
  believed_position: ["believedPosition", "position", "relative_position"],
  direction: ["move_direction", "chosen_direction", "move"],
};

/**
 * Re-key aliased fields onto the canonical schema. Returns the same object
 * when nothing needs changing.
 *
 * @param {Record<string, unknown>} parsed
 * @returns {Record<string, unknown>}
 */
export function normalizeDecisionFields(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  /** @type {Record<string, unknown>} */
  const out = { ...parsed };
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const hasCanonical = out[canonical] !== undefined;
    if (hasCanonical) continue;
    for (const alias of aliases) {
      if (out[alias] !== undefined) {
        out[canonical] = out[alias];
        delete out[alias];
        break;
      }
    }
  }
  // Drop any remaining unknown keys so strict validation sees only what we
  // recognized; unrecognized extra fields would otherwise fail validation
  // even when every canonical field is present and valid.
  for (const key of Object.keys(out)) {
    if (!(key in FIELD_ALIASES)) delete out[key];
  }
  return out;
}
