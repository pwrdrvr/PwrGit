import type {
  ChangeRequestEntry,
  ChangeRequestList,
  LocalBranchSummary,
  Repo,
  RepoRefs,
  TagSummary,
  Worktree
} from "@pwrgit/shared";

/**
 * Three invented repositories for the section-heading harness, after
 * `design/Sidebar Section Headings - UX Review.dc.html` (`REPOS`): a busy one
 * with every count, one whose Branches heading says "on main", and a quiet
 * one. Every name and number is contrived.
 */
export type HarnessRepo = {
  repo: Repo;
  refs: RepoRefs;
  changeRequests: ChangeRequestList;
  /** Selected worktree, which is what makes Branches say "on main". */
  selectedWorktreeId: string | null;
};

const NOW = Date.parse("2026-10-20T12:00:00Z");

function worktrees(repoId: string, name: string, linked: number): Worktree[] {
  const base = {
    repoId,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    pinned: false
  };
  return [
    {
      ...base,
      id: `${repoId}-primary`,
      path: `/work/${name}`,
      branch: "main",
      isDefaultBranch: true,
      isPrimary: true
    },
    ...Array.from({ length: linked }, (_, i) => ({
      ...base,
      id: `${repoId}-wt-${i}`,
      path: `/work/${name}-wt-${i}`,
      branch: `feat/task-${i}`,
      isDefaultBranch: false,
      isPrimary: false,
      lastActivityAt: new Date(NOW - i * 60_000).toISOString()
    }))
  ];
}

function branches(counts: {
  total: number;
  ahead?: number;
  behind?: number;
  gone?: number;
}): LocalBranchSummary[] {
  const out: LocalBranchSummary[] = [];
  const push = (
    n: number,
    tracking: LocalBranchSummary["tracking"],
    ahead: number,
    behind: number
  ): void => {
    for (let i = 0; i < n; i++) {
      const name = out.length === 0 ? "main" : `topic/${tracking}-${i}`;
      out.push({
        name,
        fullName: `refs/heads/${name}`,
        head: (out.length + 1).toString(16).padStart(40, "0"),
        upstream: `origin/${name}`,
        ahead,
        behind,
        tracking,
        checkedOutWorktreeIds: [],
        lastCommitAt: new Date(NOW - out.length * 3_600_000).toISOString()
      });
    }
  };
  const ahead = counts.ahead ?? 0;
  const behind = counts.behind ?? 0;
  const gone = counts.gone ?? 0;
  push(counts.total - ahead - behind - gone, "up_to_date", 0, 0);
  push(ahead, "ahead", 2, 0);
  push(behind, "behind", 0, 3);
  push(gone, "upstream_missing", 0, 0);
  return out;
}

function tags(count: number): { previewTags: TagSummary[]; tagCount: number } {
  return {
    previewTags: Array.from({ length: Math.min(count, 4) }, (_, i) => ({
      name: `v2.${count - i}.0`,
      fullName: `refs/tags/v2.${count - i}.0`,
      kind: "lightweight",
      objectId: "a".repeat(40),
      objectType: "commit",
      targetId: "a".repeat(40),
      targetType: "commit"
    })),
    tagCount: count
  };
}

function changeRequests(
  owner: string,
  name: string,
  open: number,
  failing: number
): ChangeRequestList {
  const forgeRepo = `${owner}/${name}`;
  const entries: ChangeRequestEntry[] = Array.from({ length: open }, (_, i) => ({
    pr: {
      number: 100 + i,
      url: `https://github.com/${forgeRepo}/pull/${100 + i}`,
      title: `Contrived change ${i}`,
      state: "open",
      isDraft: false,
      checkState: i < failing ? "failing" : "passing",
      forge: "github",
      headRefName: `feat/task-${i}`,
      baseRefName: "main"
    },
    location: { kind: "unfetched", branch: `feat/task-${i}`, remote: "origin" },
    remote: "origin",
    forgeRepo
  }));
  return {
    forge: "github",
    fetchedAt: NOW,
    truncated: false,
    entries,
    remotes: [
      {
        name: "origin",
        forge: "github",
        forgeRepo,
        path: forgeRepo,
        fetchedAt: NOW,
        truncated: false
      }
    ]
  };
}

function repository(spec: {
  id: string;
  name: string;
  linked: number;
  branches: Parameters<typeof branches>[0];
  tags: number;
  open: number;
  failing: number;
  onMain: boolean;
}): HarnessRepo {
  const owner = "contrived";
  const list = worktrees(spec.id, spec.name, spec.linked);
  return {
    repo: {
      id: spec.id,
      name: spec.name,
      path: `/work/${spec.name}`,
      profileId: "profile-harness",
      pinned: true,
      worktrees: list,
      identity: {
        host: "github",
        hostname: "github.com",
        owner,
        name: spec.name,
        nameWithOwner: `${owner}/${spec.name}`,
        visibility: "public",
        viewerCanPush: true,
        remoteHostnames: ["github.com"]
      }
    },
    refs: {
      branches: branches(spec.branches),
      ...tags(spec.tags),
      remotes: [
        {
          name: "origin",
          fetchUrl: `git@github.com:${owner}/${spec.name}.git`,
          pushUrl: `git@github.com:${owner}/${spec.name}.git`,
          defaultBranch: "main",
          skipFetchAll: false,
          previewBranches: [],
          branchCount: spec.branches.total
        }
      ]
    },
    changeRequests: changeRequests(owner, spec.name, spec.open, spec.failing),
    selectedWorktreeId: spec.onMain ? `${spec.id}-primary` : null
  };
}

export const HARNESS_REPOS: Record<"atlas" | "beacon" | "cinder", HarnessRepo> = {
  atlas: repository({
    id: "atlas",
    name: "atlas-api-gateway",
    linked: 279,
    branches: { total: 533, ahead: 29, behind: 32, gone: 322 },
    tags: 102,
    open: 21,
    failing: 5,
    onMain: false
  }),
  beacon: repository({
    id: "beacon",
    name: "beacon-web",
    linked: 36,
    branches: { total: 133, behind: 15, gone: 43 },
    tags: 80,
    open: 14,
    failing: 3,
    onMain: true
  }),
  cinder: repository({
    id: "cinder",
    name: "cinder",
    linked: 2,
    branches: { total: 6 },
    tags: 4,
    open: 0,
    failing: 0,
    onMain: false
  })
};

export const HARNESS_NOW = NOW;
