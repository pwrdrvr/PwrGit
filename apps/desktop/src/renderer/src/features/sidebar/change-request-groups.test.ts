import { describe, expect, it } from "vitest";
import type {
  ChangeRequestEntry,
  ChangeRequestList,
  ChangeRequestLocation,
  ChangeRequestRemote,
  OpenChangeRequest
} from "@pwrgit/shared";
import {
  forkOwner,
  groupChangeRequests,
  isFailingChangeRequest,
  lensRemotes,
  shownBase
} from "./change-request-groups";

const pr = (number: number, extra: Partial<OpenChangeRequest> = {}): OpenChangeRequest => ({
  number,
  url: `https://example.test/pull/${number}`,
  title: `PR ${number}`,
  state: "open",
  isDraft: false,
  forge: "github",
  ...extra
});
const ORIGIN = "github.com/octo/orbit";
const UPSTREAM = "github.com/orbit-hq/orbit";
const entry = (
  number: number,
  location: ChangeRequestLocation,
  extra: Partial<OpenChangeRequest> = {},
  remote = "origin"
): ChangeRequestEntry => ({
  pr: pr(number, extra),
  location,
  remote,
  forgeRepo: remote === "origin" ? ORIGIN : UPSTREAM
});
const numbers = (rows: { entry: ChangeRequestEntry }[]): number[] =>
  rows.map((row) => row.entry.pr.number);

const list: ChangeRequestEntry[] = [
  entry(381, { kind: "unfetched", branch: "fix/audit", remote: "origin" }),
  entry(376, { kind: "worktree", branch: "feat/plan", worktreeId: "wt-9" }),
  entry(342, { kind: "remote", branch: "fix/links", fullName: "refs/remotes/origin/fix/links" }, { checkState: "failing" }),
  entry(320, { kind: "local", branch: "build/electron-44" }, { mergeState: "conflicting" }),
  entry(121, {
    kind: "fork",
    branch: "typo",
    headRepoPath: "octo-contrib/orbit",
    localBranch: "pr/121",
    remote: "origin",
    fetchable: true
  }),
  entry(98, { kind: "missing", branch: null })
];

describe("groupChangeRequests", () => {
  it("puts worktree and local-branch heads in Local, everything else in Remote only, in order", () => {
    const groups = groupChangeRequests(list);
    expect(numbers(groups.local)).toEqual([376, 320]);
    // A fetched head (342) is still remote only: no branch is yours yet.
    expect(numbers(groups.remoteOnly)).toEqual([381, 342, 121, 98]);
    expect(groups.failing).toBe(2);
  });

  it("narrows both groups to failing ones without changing the failing count", () => {
    const groups = groupChangeRequests(list, { failingOnly: true });
    expect(numbers(groups.local)).toEqual([320]);
    expect(numbers(groups.remoteOnly)).toEqual([342]);
    expect(groups.failing).toBe(2);
  });
});

describe("groupChangeRequests across remotes", () => {
  it("draws a branch once, led by the PR that leaves your repository", () => {
    const branch = { kind: "local", branch: "tenant-deploy" } as const;
    const groups = groupChangeRequests([
      // Your fork's CI PR is newer, so main lists it first.
      entry(14, branch),
      entry(412, branch, {}, "upstream"),
      entry(405, { kind: "unfetched", branch: "fix/x", remote: "upstream" }, {}, "upstream"),
      entry(13, { kind: "unfetched", branch: "fix/x", remote: "origin" })
    ]);
    expect(groups.local).toHaveLength(1);
    expect(groups.local[0]?.entry.pr.number).toBe(412);
    expect(groups.local[0]?.paired.map((paired) => paired.pr.number)).toEqual([14]);
    // Remote only is one row per PR, even on a shared head name.
    expect(numbers(groups.remoteOnly)).toEqual([405, 13]);
  });
});

describe("lensRemotes", () => {
  const remote = (name: string, forgeRepo: string, path: string): ChangeRequestRemote => ({
    name,
    forge: "github",
    forgeRepo,
    path,
    fetchedAt: 1,
    truncated: false
  });
  const of = (entries: ChangeRequestEntry[]): ChangeRequestList => ({
    forge: "github",
    fetchedAt: 1,
    truncated: false,
    entries,
    remotes: [
      remote("origin", ORIGIN, "octo/orbit"),
      remote("upstream", UPSTREAM, "orbit-hq/Orbit")
    ]
  });

  it("offers each remote with something open, the original first", () => {
    const lens = lensRemotes(
      of([
        entry(1, { kind: "local", branch: "a" }),
        entry(2, { kind: "local", branch: "b" }),
        entry(3, { kind: "local", branch: "c" }, {}, "upstream")
      ]),
      "orbit-hq/orbit"
    );
    expect(lens.map((item) => [item.remote.name, item.count])).toEqual([
      ["upstream", 1],
      ["origin", 2]
    ]);
  });

  it("leaves out a remote with nothing open", () => {
    expect(
      lensRemotes(of([entry(1, { kind: "local", branch: "a" })]), undefined).map(
        (item) => item.remote.name
      )
    ).toEqual(["origin"]);
  });
});

describe("isFailingChangeRequest", () => {
  it("counts failing checks and conflicts, only while open", () => {
    expect(isFailingChangeRequest(pr(1, { checkState: "failing" }))).toBe(true);
    expect(isFailingChangeRequest(pr(1, { mergeState: "conflicting" }))).toBe(true);
    expect(isFailingChangeRequest(pr(1, { checkState: "pending" }))).toBe(false);
    expect(isFailingChangeRequest(pr(1, { state: "merged", checkState: "failing" }))).toBe(false);
  });
});

describe("shownBase", () => {
  it("draws the base only when it is not the default branch", () => {
    expect(shownBase(pr(1, { baseRefName: "main" }), "main")).toBeNull();
    expect(shownBase(pr(1, { baseRefName: "feat/plan" }), "main")).toBe("feat/plan");
    expect(shownBase(pr(1), "main")).toBeNull();
    // Unknown default: say what the forge said.
    expect(shownBase(pr(1, { baseRefName: "main" }), undefined)).toBe("main");
  });
});

describe("forkOwner", () => {
  it("names the owner of the fork", () => {
    expect(forkOwner("octo-contrib/orbit")).toBe("octo-contrib");
    expect(forkOwner("group/sub/project")).toBe("group");
    expect(forkOwner("loner")).toBe("loner");
  });
});
