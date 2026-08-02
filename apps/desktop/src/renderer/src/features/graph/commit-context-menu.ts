import type { LaneBranchInfo, PrSummary } from "@pwrgit/shared";

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
