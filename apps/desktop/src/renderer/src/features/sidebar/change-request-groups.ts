import type {
  ChangeRequestEntry,
  ChangeRequestList,
  ChangeRequestRemote,
  OpenChangeRequest
} from "@pwrgit/shared";

/**
 * One row of the section: a change request, and — in the Local group — any
 * others whose head is the same branch of yours. A fork checkout's branch
 * usually has two: the CI PR on your fork (`origin`) and the PR you sent to
 * the original. The row is the branch, so it appears once, led by the PR that
 * leaves your repository; the rest ride along as `paired`.
 */
export type ChangeRequestRow = {
  entry: ChangeRequestEntry;
  paired: ChangeRequestEntry[];
};

/**
 * The sidebar's Pull requests section in two groups: what this machine holds
 * (a worktree or a local branch is the head) and what is only on the forge.
 *
 * "Local" means a branch in `refs/heads`. A head that is merely fetched
 * (`refs/remotes/origin/…`) is still Remote only: nothing here is yours to
 * work on until a branch exists, and that is the step + Worktree takes.
 */
export type ChangeRequestGroups = {
  local: ChangeRequestRow[];
  remoteOnly: ChangeRequestRow[];
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

/** One entry's identity across remotes: the fork's #14 is not the original's. */
export function changeRequestKey(entry: ChangeRequestEntry): string {
  return `${entry.forgeRepo}#${entry.pr.number}`;
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
  const local: ChangeRequestRow[] = [];
  const byBranch = new Map<string, ChangeRequestRow>();
  const remoteOnly: ChangeRequestRow[] = [];
  let failing = 0;
  for (const entry of entries) {
    const fails = isFailingChangeRequest(entry.pr);
    if (fails) failing += 1;
    if (failingOnly && !fails) continue;
    const { location } = entry;
    if (location.kind !== "worktree" && location.kind !== "local") {
      remoteOnly.push({ entry, paired: [] });
      continue;
    }
    const row = byBranch.get(location.branch);
    if (row === undefined) {
      const fresh = { entry, paired: [] };
      byBranch.set(location.branch, fresh);
      local.push(fresh);
    } else if (row.entry.remote === "origin" && entry.remote !== "origin") {
      // The PR that leaves your repository leads; your fork's rides along.
      row.paired.unshift(row.entry);
      row.entry = entry;
    } else {
      row.paired.push(entry);
    }
  }
  return { local, remoteOnly, failing };
}

/** The lens: every remote, or one forge repository's (`forgeRepo`). */
export type ChangeRequestLens = "all" | string;

/**
 * The remotes a lens offers, each with how many it lists: only those with
 * something open, the original first (the parent of `origin`'s repository,
 * which `RepoIdentity` knows), then `origin`, then the rest in main's order.
 * Fewer than two means there is nothing to choose, and no lens is drawn.
 */
export function lensRemotes(
  list: ChangeRequestList,
  parentPath: string | undefined
): { remote: ChangeRequestRemote; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of list.entries) {
    counts.set(entry.forgeRepo, (counts.get(entry.forgeRepo) ?? 0) + 1);
  }
  const parent = parentPath?.toLowerCase();
  const rank = (remote: ChangeRequestRemote): number =>
    remote.path.toLowerCase() === parent ? 0 : remote.name === "origin" ? 1 : 2;
  return list.remotes
    .map((remote, index) => ({ remote, count: counts.get(remote.forgeRepo) ?? 0, index }))
    .filter((item) => item.count > 0)
    .sort((a, b) => rank(a.remote) - rank(b.remote) || a.index - b.index)
    .map(({ remote, count }) => ({ remote, count }));
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

/**
 * The remote a fetched head's tracking ref is under: `refs/remotes/upstream/
 * feat/x` with branch `feat/x` is `upstream`. Read from the ref rather than
 * split on `/`, because both the remote's name and the branch may hold one.
 */
export function trackingRemote(location: { fullName: string; branch: string }): string {
  const tracked = location.fullName.replace(/^refs\/remotes\//, "");
  return tracked.endsWith(`/${location.branch}`)
    ? tracked.slice(0, tracked.length - location.branch.length - 1)
    : "origin";
}
