/**
 * A list of strings kept in one TEXT column, as JSON.
 *
 * One decoder because two readers exist for the same column —
 * `IdentityService.read` and `RepoIndexer`'s `repo:list` join — and the rule
 * they have to agree on is not "parse JSON" but what NULL means: the column
 * was never written for this row, which a caller must render as "not known"
 * rather than as an empty list. Two copies of that is two chances to answer
 * one of them as a confident zero.
 *
 * Anything that is not an array of strings is treated as NULL for the same
 * reason. The value went in as JSON and comes back out of SQLite, which
 * validates neither, and a throw here would escape a background refresh.
 */
export function parseJsonStringList(raw: string | null): string[] | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

/** The other half, so writers cannot disagree with the decoder about how
 *  "not known" is spelled. */
export function serializeJsonStringList(
  values: readonly string[] | undefined
): string | null {
  return values === undefined ? null : JSON.stringify(values);
}
