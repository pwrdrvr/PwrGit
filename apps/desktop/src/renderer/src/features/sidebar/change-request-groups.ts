import type {
  ChangeRequestEntry,
  OpenChangeRequest
} from "@pwrgit/shared";

/**
 * The sidebar's Pull requests section in two groups: what this machine holds
 * (a worktree or a local branch is the head) and what is only on the forge.
 *
 * "Local" means a branch in `refs/heads`. A head that is merely fetched
 * (`refs/remotes/origin/…`) is still Remote only: nothing here is yours to
 * work on until a branch exists, and that is the step + Worktree takes.
 */
export type ChangeRequestGroups = {
  local: ChangeRequestEntry[];
  remoteOnly: ChangeRequestEntry[];
  /** Open ones whose checks fail or that conflict, across both groups — what
   *  the header's chip counts, filter or not. */
  failing: number;
};

export function isLocalChangeRequest(entry: ChangeRequestEntry): boolean {
  return entry.location.kind === "worktree" || entry.location.kind === "local";
}

/** Needs someone: failing checks, or a merge that cannot go in as it stands. */
export function isFailingChangeRequest(pr: OpenChangeRequest): boolean {
  return (
    pr.state === "open" &&
    (pr.checkState === "failing" || pr.mergeState === "conflicting")
  );
}

/**
 * Split the list, keeping main's order (newest update first) inside each
 * group. `failingOnly` is the header chip's filter; it narrows the rows and
 * leaves the count it is labelled with alone.
 */
export function groupChangeRequests(
  entries: readonly ChangeRequestEntry[],
  { failingOnly = false }: { failingOnly?: boolean } = {}
): ChangeRequestGroups {
  const local: ChangeRequestEntry[] = [];
  const remoteOnly: ChangeRequestEntry[] = [];
  let failing = 0;
  for (const entry of entries) {
    const fails = isFailingChangeRequest(entry.pr);
    if (fails) failing += 1;
    if (failingOnly && !fails) continue;
    (isLocalChangeRequest(entry) ? local : remoteOnly).push(entry);
  }
  return { local, remoteOnly, failing };
}

/**
 * The base, only when it says something: a PR into the default branch is the
 * ordinary case and `→ main` on every row spends the width the head name
 * needs. A stacked PR's base is worth the room.
 */
export function shownBase(
  pr: OpenChangeRequest,
  defaultBranch: string | undefined
): string | null {
  const base = pr.baseRefName;
  if (base === undefined || base === "") return null;
  return base === defaultBranch ? null : base;
}

/** `owner/repo` → `owner`: the fork tag names whose fork it is. */
export function forkOwner(headRepoPath: string): string {
  const slash = headRepoPath.indexOf("/");
  return slash <= 0 ? headRepoPath : headRepoPath.slice(0, slash);
}
