import type { RepoSearchHit } from "@pwrgit/shared";

/**
 * Final ordering for ⌘F results, applied over the bm25 order the index
 * returns.
 *
 * bm25 ranks by where a match landed and how rare its terms are, per column.
 * That is the right instrument for "which of these mentions the words you
 * typed", and the wrong one for "which of these IS the thing you named" — a
 * branch name is indexed as a name, but a checkout's directory name reaches
 * the index only inside its path, at path weight. So typing the folder you are
 * standing in ranked the checkout below any branch that merely began with the
 * same word, including branches that exist nowhere on disk.
 */

/** Case- and diacritic-insensitive, for literal name comparison. */
export const normalizeSearchName = (value: string): string =>
  value
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

/** Final segment of a path, with either platform's separators. */
const pathLeaf = (path: string): string =>
  path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";

/**
 * The names a hit answers to.
 *
 * A checkout answers to its directory as well as its branch: the directory is
 * named once, at creation, and a later branch rename leaves it as the only
 * name that still matches what the user's shell and editor show them.
 *
 * Branch hits get no such treatment even though they carry a `path` — theirs
 * is their REPO's directory, not their own. Counting it would make every
 * worktree-less branch in a repo an exact match for that repo's folder name.
 */
const answersTo = (hit: RepoSearchHit): string[] =>
  hit.kind === "repo" || hit.kind === "worktree"
    ? [hit.name, pathLeaf(hit.path)]
    : [hit.name];

/** 0 = the query names this hit, 1 = it begins one of its names, 2 = the
 *  match is somewhere else entirely (mid-name, deep in a path, a PR title). */
export type SearchMatchTier = 0 | 1 | 2;

export function searchMatchTier(
  hit: RepoSearchHit,
  query: string
): SearchMatchTier {
  const wanted = normalizeSearchName(query);
  if (wanted === "") return 2;
  let tier: SearchMatchTier = 2;
  for (const name of answersTo(hit)) {
    const candidate = normalizeSearchName(name);
    if (candidate === wanted) return 0;
    if (candidate.startsWith(wanted)) tier = 1;
  }
  return tier;
}

/**
 * A checkout on disk (0) outranks a branch that is checked out nowhere (1).
 *
 * Only consulted between hits that answer to the typed name equally directly
 * — see the tiers above. Among two things the query names, the one you can
 * open, `cd` into and already have work in is the stronger answer; the bare
 * ref is a branch you would have to create a worktree for. Repos and their
 * checkouts share rank 0, so an exactly-named repo and an exactly-named
 * worktree keep whatever order bm25 gave them.
 */
export const searchKindRank = (hit: RepoSearchHit): 0 | 1 =>
  hit.kind === "repo" || hit.kind === "worktree" ? 0 : 1;

/**
 * Re-rank hits in place of their bm25 order, most directly-named first.
 *
 * Stable, and deliberately coarse: within a tier the index's own ranking is
 * left alone. Tier 2 — everything that matched somewhere other than the head
 * of a name — keeps bm25's ordering outright, kind included. A branch matched
 * by its name should stay above a worktree matched only by some ancestor
 * directory, and nothing here is a strong enough signal to say otherwise.
 */
export function rankSearchHits(
  hits: RepoSearchHit[],
  query: string
): RepoSearchHit[] {
  const tiers = new Map<RepoSearchHit, SearchMatchTier>(
    hits.map((hit) => [hit, searchMatchTier(hit, query)])
  );
  const tierOf = (hit: RepoSearchHit): SearchMatchTier => tiers.get(hit) ?? 2;
  return [...hits].sort((left, right) => {
    const byTier = tierOf(left) - tierOf(right);
    if (byTier !== 0) return byTier;
    if (tierOf(left) === 2) return 0;
    return searchKindRank(left) - searchKindRank(right);
  });
}

// `\` escapes itself and the two wildcards; the SQL below pairs these with
// ESCAPE '\'. Without it a branch named `wip_1` would match `wip1` — `_` is
// LIKE's single-character wildcard and is entirely ordinary in a branch name.
const likeLiteral = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * LIKE patterns for "a path whose final segment is exactly this query", in
 * POSIX and Windows form. The index cannot express it — FTS5 tokenizes a path
 * into words, so it cannot tell the leaf from any other segment — and this is
 * what keeps a folder the user named verbatim inside the query's row cap.
 */
export function pathLeafLikePatterns(query: string): [string, string] {
  const leaf = likeLiteral(query.trim());
  return [`%/${leaf}`, `%\\\\${leaf}`];
}
