// Ported from PwrSnap. An ACP surface offers two thinking states — "Fast" and
// "Thinking" — but the stored `reasoning` is the SHARED effort string Codex
// uses ("low" | "medium" | "high" | …). The agent-acp kit maps the effort hint
// onto the agent's `thought_level` at turn start: "low" → thinking OFF, "high"
// → thinking ON. It has NO mapping for "medium", so a "medium" silently falls
// through to the agent's own default.
//
// "medium" still reaches an ACP backend: a job can carry a Codex effort left
// over from before its provider was switched to an agent. Collapse any effort
// to the two states the kit honors, at every ACP boundary, so an agent is never
// handed a value it drops on the floor.

/** Efforts at or below "low" — Codex also advertises "minimal" and "none" —
 *  all ask for as little thinking as there is, so all of them are Fast. */
const FAST_EFFORTS: ReadonlySet<string> = new Set(["none", "minimal", "low"]);

/** Collapse a Codex-style reasoning effort to the two thinking states an ACP
 *  agent exposes: `"none"`, `"minimal"` and `"low"` → `"low"` (Fast / thinking
 *  off); any other value (including `"medium"`) → `"high"` (Thinking / on). */
export function acpReasoningEffort(effort: string): "low" | "high" {
  return FAST_EFFORTS.has(effort) ? "low" : "high";
}
