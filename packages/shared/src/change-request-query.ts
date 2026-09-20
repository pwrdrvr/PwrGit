/**
 * How a typed query finds a change request — one rule for the refs browser and
 * the command palette, so `106` means the same thing in both.
 *
 * A query that is only a number, with or without the forge's sigil (`106`,
 * `#106`, `!106`), asks for that change request and nothing near it: `106`
 * must not answer with #1060. Anything else is a case-insensitive substring
 * over the number, title, head branch and author.
 */

/** The number a query names, or null when it is not a bare change-request reference. */
export function changeRequestNumberQuery(query: string): number | null {
  const match = /^\s*[#!]?(\d{1,9})\s*$/.exec(query);
  if (match === null) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

export type ChangeRequestMatchFields = {
  number: number;
  title: string;
  headRefName?: string;
  author?: string;
};

/**
 * Whether `pr` answers `query`, and how.
 *
 * `"number"` is the strong answer — the reader typed its number — and callers
 * rank it above everything else. `"text"` is an ordinary filter hit. An empty
 * query matches nothing here: an unfiltered list is the caller's decision.
 */
export function changeRequestMatch(
  pr: ChangeRequestMatchFields,
  query: string
): "number" | "text" | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const number = changeRequestNumberQuery(needle);
  if (number !== null) return pr.number === number ? "number" : null;
  const haystack = [
    `#${pr.number}`,
    pr.title,
    pr.headRefName ?? "",
    pr.author ?? ""
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle) ? "text" : null;
}
