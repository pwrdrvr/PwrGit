import {
  changeRequestNumberQuery,
  searchNameKey,
  searchNamesBegin,
  searchOwnNames,
  type OpenChangeRequest,
  type RepoSearchHit
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";

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

/**
 * Whether a row's own names ARE the query: -1 for a repository the query
 * names, 0 for anything else it names, null otherwise. `wanted` is the
 * query's `searchNameKey`.
 *
 * Main's `searchMatchTier` and the search SQL (`pwrgit_search_exact_tier`, in
 * `SEARCH_EXACT_TIER_SQL`) both call this, so the row SQL keeps inside the cap
 * is the row main would lead with.
 *
 * A checkout answers to its directory as well as its branch: the directory is
 * named once, at creation, and a later branch rename leaves it as the only
 * name that still matches what the user's shell and editor show them.
 *
 * Branch hits get no such treatment even though they carry a `path` — theirs
 * is their REPO's directory (or, in the index, their ref), not their own.
 * Counting it would make every worktree-less branch in a repo an exact match
 * for that repo's folder name.
 */
export function exactNameTier(
  kind: string,
  name: string,
  path: string,
  wanted: string
): -1 | 0 | null {
  const [own, folder] = searchOwnNames(kind, name, path);
  if (searchNameKey(own ?? "") === wanted) return kind === "repo" ? -1 : 0;
  return folder !== undefined && searchNameKey(folder) === wanted ? 0 : null;
}

/** -1 = an exact repo name; 0 = the query names this hit (or its change
 *  request's number), 1 = it begins one of its names, 2 = somewhere else
 *  (mid-name, deep in a path, a PR title). */
export type SearchMatchTier = -1 | 0 | 1 | 2;

export function searchMatchTier(
  hit: RepoSearchHit,
  query: string
): SearchMatchTier {
  const wanted = searchNameKey(query);
  if (wanted === "") return 2;
  const exact = exactNameTier(hit.kind, hit.name, hit.path, wanted);
  if (exact !== null) return exact;
  // `106` names change request #106 as surely as a branch's name names the
  // branch — and the index only knows it as a prefix, so #1060 matched too.
  const number = changeRequestNumberQuery(query);
  if (number !== null && hit.pr?.number === number) return 0;
  return searchNamesBegin(hit.kind, hit.name, hit.path, wanted) ? 1 : 2;
}

/**
 * A repository (0) outranks a checkout on disk (1), which outranks a branch
 * that is checked out nowhere (2).
 *
 * Only consulted between hits that answer to the typed name equally directly
 * — see the tiers above. A repository's name is what ⌘K is for: typing its
 * first letters must not list its own checkouts first, and bm25 scored those
 * higher, on the branch name and again on the repository's name in their
 * path. Among the rest, the one you can open, `cd` into and already have work
 * in is the stronger answer; the bare ref is a branch you would have to
 * create a worktree for. An exact repo name has its own leading tier.
 */
const searchKindRank = (hit: RepoSearchHit): 0 | 1 | 2 =>
  hit.kind === "repo" ? 0 : hit.kind === "worktree" ? 1 : 2;

/** unicode61's view of a string: letter/digit runs, folded. */
const searchTokens = (value: string): string[] =>
  searchNameKey(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

/**
 * Whether an open change request's index row matched `query` for a reason of
 * its own, rather than only through the repository name every row carries.
 *
 * Without this, typing a repository's name returns every open PR in it, and a
 * busy repository's list fills the result cap before its own worktrees are
 * reached. A number query is stricter still: `106` asks for #106, and the
 * index's prefix match would also have offered #1060.
 */
export function changeRequestAnswersQuery(
  pr: Pick<OpenChangeRequest, "number" | "title" | "headRefName">,
  repoName: string,
  query: string
): boolean {
  const number = changeRequestNumberQuery(query);
  if (number !== null) return pr.number === number;
  const own = searchTokens(`${pr.number} ${pr.title} ${pr.headRefName ?? ""}`);
  const repo = searchTokens(repoName);
  const hits = (words: string[], token: string): boolean =>
    words.some((word) => word.startsWith(token));
  const tokens = searchTokens(query);
  return (
    tokens.some((token) => hits(own, token)) &&
    tokens.every((token) => hits(own, token) || hits(repo, token))
  );
}

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

/**
 * The search SQL's exact tiers, decided before the result cap: -1 for a
 * repository the query names, 0 for anything else it names (by name, by a
 * checkout's folder, or by change-request number), 1 for the rest, which
 * bm25 orders.
 *
 * The names are judged by `exactNameTier`, the function `searchMatchTier`
 * uses, registered on the connection by `registerSearchSqlFunctions`. SQLite's
 * `COLLATE NOCASE` folds only ASCII: a repository named `Übersicht` was no
 * exact match for `übersicht` there, and 60 checkouts on a branch of that
 * name took every slot before main could rank it first.
 *
 * Reads `kind`, `name`, `path` and `pr` of a `search_fts` row; bind
 * `searchExactTierParams(query)` in order. One call into JS per row.
 */
export const SEARCH_EXACT_TIER_SQL = `MIN(
  pwrgit_search_exact_tier(kind, name, path, ?),
  CASE WHEN pr LIKE ? THEN 0 ELSE 1 END)`;

/**
 * The search SQL's next key after the exact tiers: 0 for a repository whose
 * name or folder the query begins, 1 for everything else. Main ranks those
 * repositories first within their tier (`searchKindRank`), so they must
 * survive the cap ahead of the many checkouts and branches that begin the
 * same way. Bind `searchNameKey(query)`.
 */
export const SEARCH_REPO_BEGUN_SQL = `CASE WHEN kind = 'repo'
  AND pwrgit_search_names_begin(kind, name, path, ?) THEN 0 ELSE 1 END`;

export function searchExactTierParams(query: string): [string, string | null] {
  // A bare number names a change request exactly; its `pr` text begins with
  // that number and a space. Without this the index's prefix match lets
  // #1060 and every branch spelled `issue-10604` crowd #106 past the cap.
  const prNumber = changeRequestNumberQuery(query);
  return [searchNameKey(query), prNumber === null ? null : `${prNumber} %`];
}

/** Make the search SQL's functions callable on this connection. */
export function registerSearchSqlFunctions(db: DB): void {
  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  db.function(
    "pwrgit_search_exact_tier",
    { deterministic: true },
    (kind, name, path, wanted) =>
      exactNameTier(text(kind), text(name), text(path), text(wanted)) ?? 1
  );
  db.function(
    "pwrgit_search_names_begin",
    { deterministic: true },
    (kind, name, path, wanted) =>
      searchNamesBegin(text(kind), text(name), text(path), text(wanted)) ? 1 : 0
  );
}
