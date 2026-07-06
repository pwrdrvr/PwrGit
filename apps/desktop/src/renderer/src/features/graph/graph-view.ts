import type { Commit } from "@pwrgit/shared";

export type CommitRowVM = Commit & {
  /** Authored by the active profile's email. */
  isMine: boolean;
  /** This commit is the branch's divergence point (merge-base with default). */
  isBase: boolean;
};

export function decorateCommits(
  commits: Commit[],
  activeEmail: string,
  branchRoot: string | null
): CommitRowVM[] {
  const email = activeEmail.toLowerCase();
  return commits.map((c) => ({
    ...c,
    isMine: c.authorEmail.toLowerCase() === email,
    isBase: branchRoot !== null && c.hash === branchRoot
  }));
}

/** "Only me" keeps your commits plus the branch root (for orientation). */
export function filterOnlyMe(
  rows: CommitRowVM[],
  onlyMe: boolean
): CommitRowVM[] {
  if (!onlyMe) return rows;
  return rows.filter((r) => r.isMine || r.isBase);
}

/** Short "time since" label for a commit timestamp. */
export function shortWhen(iso: string, now: number = Date.now()): string {
  const secs = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
