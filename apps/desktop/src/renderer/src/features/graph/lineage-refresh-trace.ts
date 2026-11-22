export type LineageRefreshSource = "view" | "branch-pr" | "repo-change";

// Ordinals are local to this renderer. A trace can compare two repositories
// without carrying a path, ref, repository name or persistent ID.
const repoNumbers = new Map<string, number>();
let visibleRepo = 0;

function repoNumber(repoId: string): number {
  const number = repoNumbers.get(repoId) ?? repoNumbers.size + 1;
  repoNumbers.set(repoId, number);
  return number;
}

export function setVisibleLineageRepo(repoId: string | null): void {
  visibleRepo = repoId === null ? 0 : repoNumber(repoId);
}

export function markLineageRefresh(
  repoId: string,
  source: LineageRefreshSource,
  phase: "request" | "publish"
): void {
  if (typeof performance.mark !== "function") return;
  const name = `PwrGit Lineage ${phase} ${source} view=${visibleRepo} target=${repoNumber(repoId)}`;
  performance.mark(name);
  // Chromium's rolling trace has the mark. The page need not retain it.
  performance.clearMarks(name);
}
