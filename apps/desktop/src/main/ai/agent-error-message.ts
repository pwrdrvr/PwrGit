// A readable sentence out of whatever an agent CLI or its transport threw.
// Ported from PwrSnap: ACP and Codex failures arrive as Errors, JSON-RPC error
// envelopes, or nested `cause`/`data` records, and the Settings row that
// reports one has room for a sentence, not an object dump.

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

/** The message, one line and bounded — or null when it says nothing, so a
 *  blank one falls through to a `cause` or the fallback instead of rendering
 *  as an empty row. */
function cleanMessage(message: string): string | null {
  const cleaned = message.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractMessage(value: unknown, seen: Set<unknown>): string | null {
  if (typeof value === "string") return cleanMessage(value);
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  // An Error with nothing to say still has its `cause`, read below.
  if (value instanceof Error) {
    const own = cleanMessage(value.message);
    if (own !== null) return own;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["message", "reasonMessage", "error", "detail", "stderr"]) {
    const direct = readStringField(record, key);
    if (direct !== null) return cleanMessage(direct);
  }

  for (const key of ["error", "cause", "data", "response", "body"]) {
    const nested = extractMessage(record[key], seen);
    if (nested !== null) return nested;
  }

  return null;
}

export function agentErrorMessage(error: unknown, fallback = "Agent request failed"): string {
  return extractMessage(error, new Set()) ?? fallback;
}
