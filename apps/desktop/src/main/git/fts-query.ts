/**
 * Turn raw user input into a safe FTS5 MATCH expression. Lifted from
 * PwrSnap's buildFts5Query:
 *
 *  1. Split on anything that's NOT a Unicode letter/digit — this mirrors
 *     SQLite's `unicode61` tokenizer, so query tokenization stays in
 *     lockstep with content tokenization ("claude/side-by-side" produces
 *     [claude, side, by, side], the same shape the indexed branch name
 *     was tokenized into; naive whitespace-splitting would produce a
 *     token that matches nothing).
 *  2. Wrap each surviving token as a quoted phrase — anything that could
 *     read as an FTS5 operator (AND/OR/NOT, punctuation that slipped
 *     through) is treated as literal text.
 *  3. Append `*` for prefix matching ("exp" matches "experiment").
 *  4. Join with FTS5's implicit AND, so multi-token queries match in any
 *     order ("8013 side exp" finds side-by-side-experiment-…-8013ec).
 *
 * Returns null when nothing usable survives (empty / pure punctuation) —
 * callers treat that as "browse, don't search".
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}
