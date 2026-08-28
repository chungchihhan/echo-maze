/**
 * Decision field normalization (policy v0.4).
 *
 * Like tolerant JSON extraction, this is an envelope convention, not content
 * repair: when a model answers with a well-formed decision under a different
 * but unambiguous field name, the value is re-keyed to the canonical schema
 * field. Values are never invented — canonical fields always win, and an
 * alias is only used when the canonical field is absent. Unknown keys are
 * preserved for the strict schema validator to reject; normalization must not
 * silently weaken additionalProperties:false.
 */

/** @type {Record<string, string[]>} canonical field -> accepted aliases */
const FIELD_ALIASES = {
  observation_summary: ["observationSummary", "observation"],
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
    if (!Object.hasOwn(out, canonical)) {
      for (const alias of aliases) {
        if (Object.hasOwn(out, alias)) {
          out[canonical] = out[alias];
          break;
        }
      }
    }

    // Aliases are envelope conventions. Remove only recognized aliases and
    // leave unrelated keys for schema validation to reject.
    for (const alias of aliases) {
      if (alias !== canonical) delete out[alias];
    }
  }
  return out;
}
