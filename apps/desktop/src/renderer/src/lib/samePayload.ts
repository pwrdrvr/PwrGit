/**
 * Structural equality for structured-cloned IPC payloads. Preserves array and
 * record key order because some renderer consumers (graph refs, ordered repo
 * lists) iterate in payload order.
 */
export function samePayload(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => samePayload(item, b[i]))
    );
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const rightKeys = Object.keys(right);
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, i) => key === rightKeys[i] && samePayload(left[key], right[key])
    )
  );
}
