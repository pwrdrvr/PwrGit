import type { LaneBranchInfo, PrSummary, PwrGitError } from "@pwrgit/shared";

/** Resolve PRs only from refs that point at this exact commit. Remote refs use
 * their local branch suffix (origin/feature/x → feature/x), never a fuzzy
 * commit-message or author match. */
export function pullRequestsAtCommit(
  refs: readonly string[],
  remoteRefs: readonly string[],
  branchInfo: Record<string, LaneBranchInfo>
): PrSummary[] {
  const names = new Set([
    ...refs,
    ...remoteRefs.map((ref) => {
      const slash = ref.indexOf("/");
      return slash === -1 ? ref : ref.slice(slash + 1);
    })
  ]);
  const seenUrls = new Set<string>();
  const pullRequests: PrSummary[] = [];

  for (const name of names) {
    const pr = branchInfo[name]?.pr;
    if (pr === undefined || pr.url === "" || seenUrls.has(pr.url)) continue;
    seenUrls.add(pr.url);
    pullRequests.push(pr);
  }

  return pullRequests;
}

/** Build a commit permalink from a known pull-request URL. Both GitHub-style
 * /pull/N and GitLab-style /-/merge_requests/N paths are accepted so the menu
 * stays useful for cached PR URLs from either provider. */
export function commitUrlForPullRequest(
  pr: PrSummary,
  hash: string
): string | null {
  if (hash === "") return null;

  try {
    const source = new URL(pr.url);
    const segments = source.pathname.split("/").filter(Boolean);
    const markerIndex = segments.findIndex(
      (segment, index) =>
        (segment === "pull" || segment === "merge_requests")
        && segments[index + 1] === String(pr.number)
    );
    if (markerIndex < 1) return null;

    const marker = segments[markerIndex];
    const repositoryEnd =
      segments[markerIndex - 1] === "-" ? markerIndex - 1 : markerIndex;
    const repositoryPath = segments.slice(0, repositoryEnd).join("/");
    if (repositoryPath === "") return null;

    const target = new URL(source.origin);
    target.pathname =
      marker === "merge_requests"
        ? `/${repositoryPath}/-/commit/${hash}`
        : `/${repositoryPath}/commit/${hash}`;
    return target.toString();
  } catch {
    return null;
  }
}

/** A branch drawn at a commit that the viewed worktree could move to. */
export type CommitSwitchTarget = {
  /** The name to hand `git switch` — a remote-only tip resolves to the local
   *  branch git's DWIM creates for it (origin/feature/x → feature/x). */
  branch: string;
  /** The ref as drawn on the row, so the menu names what was right-clicked. */
  ref: string;
  /** True when only the remote-tracking ref is here, so switching creates or
   *  reuses the local branch rather than moving to a ref already drawn. */
  isRemoteOnly: boolean;
  /** Worktree already holding this branch — git refuses a second checkout, so
   *  the menu offers that worktree instead of a switch that cannot work. */
  checkedOutIn?: string;
};

/** The local branch a drawn ref stands for: a remote-tracking ref drops its
 *  remote so `git switch` DWIMs into the local branch tracking it. */
export function localBranchForRef(ref: string, isRemote: boolean): string {
  if (!isRemote) return ref;
  const slash = ref.indexOf("/");
  return slash === -1 ? "" : ref.slice(slash + 1);
}

/**
 * What switching to one drawn ref would mean for the viewed worktree, or null
 * when there is nothing to move — the branch is already checked out here, or
 * the ref names a remote alone (a collapsed "origin" chip, whose branch is the
 * local ref drawn beside it).
 */
export function switchTargetForRef(
  ref: string,
  isRemote: boolean,
  branchInfo: Record<string, LaneBranchInfo>,
  currentBranch: string,
  worktreeId: string
): CommitSwitchTarget | null {
  const branch = localBranchForRef(ref, isRemote);
  if (branch === "" || branch === currentBranch) return null;
  // The worktree holding a branch is the one a switch would collide with; our
  // own never can, since that branch is the current one.
  const holder = branchInfo[branch]?.worktreeId;
  return {
    branch,
    ref,
    isRemoteOnly: isRemote,
    ...(holder === undefined || holder === worktreeId
      ? {}
      : { checkedOutIn: holder })
  };
}

/** Enough for the branches a commit realistically tips; the header switcher
 *  remains the way through a commit carrying dozens of stale refs. */
export const MAX_COMMIT_BRANCH_ITEMS = 4;

/**
 * Branches this commit tips that the viewed worktree can act on, local refs
 * first. The branch already checked out here is left out (switching to it is a
 * no-op), and a remote ref whose local branch is already listed is skipped as
 * a duplicate.
 */
export function switchTargetsAtCommit(
  refs: readonly string[],
  remoteRefs: readonly string[],
  branchInfo: Record<string, LaneBranchInfo>,
  currentBranch: string,
  worktreeId: string
): CommitSwitchTarget[] {
  const targets: CommitSwitchTarget[] = [];
  const seen = new Set<string>();

  for (const [ref, isRemote] of [
    ...refs.map((ref) => [ref, false] as const),
    ...remoteRefs.map((ref) => [ref, true] as const)
  ]) {
    const target = switchTargetForRef(
      ref,
      isRemote,
      branchInfo,
      currentBranch,
      worktreeId
    );
    if (target === null || seen.has(target.branch)) continue;
    seen.add(target.branch);
    targets.push(target);
  }

  return targets.slice(0, MAX_COMMIT_BRANCH_ITEMS);
}

/**
 * The refs drawn on a commit row, as written on their chips, so the menu can
 * offer to copy what is on screen — including the ones the chip cap hid. A
 * collapsed remote chip names the remote alone ("origin"), which is not a
 * branch name worth copying, so only full remote refs are listed.
 */
export function branchRefsAtCommit(
  refs: readonly string[],
  remoteRefs: readonly string[]
): string[] {
  return [
    ...new Set([
      ...refs.filter((ref) => ref !== ""),
      ...remoteRefs.filter((ref) => ref.includes("/"))
    ])
  ].slice(0, MAX_COMMIT_BRANCH_ITEMS);
}

/**
 * Say what git refused in the app's terms. `switchBranch` classifies the two
 * failures a graph click can walk into; anything else keeps git's own words.
 */
export function switchFailureMessage(
  error: PwrGitError,
  branch: string
): string {
  if (error.code === "dirty") {
    return `This worktree has uncommitted changes that switching to ${branch} would overwrite. Commit or stash them first.`;
  }
  if (error.code === "checked_out_elsewhere") {
    return `${branch} is already checked out in another worktree.`;
  }
  return error.message.split("\n")[0] ?? `Could not switch to ${branch}.`;
}
