import type { Commit } from "@pwrgit/shared";

/**
 * What "Edit history from here" means at one commit of the lineage.
 *
 * The rebase assistant accepts exactly one shape (`validateSelection` in
 * main's `rebase-assistant.ts`): the N most recent commits of HEAD, contiguous,
 * at least two, no merge among them, not reaching the repository's first
 * commit. So the graph does
 * not ask for a set of commits; it asks where the run starts, and the run is
 * every commit from HEAD down to that one.
 *
 * - `range`: the run, newest (HEAD) first, ready to hand to the rebase tool.
 *   `pushed` counts the commits in it that a remote already has (not in
 *   `unpushed`): publishing a rewrite of those needs a force push. Without an
 *   `unpushed` answer nothing is claimed either way.
 * - `blocked`: the commit is on HEAD's line, but the run cannot be edited.
 *   The menu shows the entry disabled with the reason.
 * - `null`: nothing to offer here — HEAD itself (a run of one), a commit HEAD
 *   does not reach along its first parents, or one past the loaded window.
 */
export type HistoryRange =
  | { kind: "range"; hashes: string[]; pushed: number }
  | { kind: "blocked"; reason: "merge" | "root"; count: number };

export function historyRangeFrom(
  commits: readonly Commit[],
  head: string,
  start: string,
  /** HEAD's commits no remote-tracking ref reaches (`headUnpushedCommits`). */
  unpushed?: ReadonlySet<string>
): HistoryRange | null {
  if (head === "" || start === head) return null;
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const hashes: string[] = [];
  let merge = false;
  let cursor: string | undefined = head;
  while (cursor !== undefined) {
    const commit = byHash.get(cursor);
    // Past the loaded window, or a parent the graph never drew: the run
    // cannot be counted, so nothing is offered rather than a wrong count.
    if (commit === undefined) return null;
    hashes.push(commit.hash);
    // A merge anywhere in the run interleaves its other parents into Git's
    // "most recent N", which is not the run drawn here.
    if (commit.parents.length > 1) merge = true;
    if (commit.hash === start) {
      if (merge) return { kind: "blocked", reason: "merge", count: hashes.length };
      if (commit.parents.length === 0) {
        return { kind: "blocked", reason: "root", count: hashes.length };
      }
      const pushed =
        unpushed === undefined
          ? 0
          : hashes.filter((hash) => !unpushed.has(hash)).length;
      return { kind: "range", hashes, pushed };
    }
    cursor = commit.parents[0];
  }
  return null;
}
