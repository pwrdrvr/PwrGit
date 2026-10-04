import { describe, expect, it } from "vitest";
import type {
  ChangeRequestEntry,
  ChangeRequestLocation,
  OpenChangeRequest
} from "@pwrgit/shared";
import {
  forkOwner,
  groupChangeRequests,
  isFailingChangeRequest,
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
const entry = (
  number: number,
  location: ChangeRequestLocation,
  extra: Partial<OpenChangeRequest> = {}
): ChangeRequestEntry => ({ pr: pr(number, extra), location });

const list: ChangeRequestEntry[] = [
  entry(381, { kind: "unfetched", branch: "fix/audit" }),
  entry(376, { kind: "worktree", branch: "feat/plan", worktreeId: "wt-9" }),
  entry(342, { kind: "remote", branch: "fix/links", fullName: "refs/remotes/origin/fix/links" }, { checkState: "failing" }),
  entry(320, { kind: "local", branch: "build/electron-44" }, { mergeState: "conflicting" }),
  entry(121, {
    kind: "fork",
    branch: "typo",
    headRepoPath: "octo-contrib/orbit",
    localBranch: "pr/121",
    fetchable: true
  }),
  entry(98, { kind: "missing", branch: null })
];

describe("groupChangeRequests", () => {
  it("puts worktree and local-branch heads in Local, everything else in Remote only, in order", () => {
    const groups = groupChangeRequests(list);
    expect(groups.local.map((e) => e.pr.number)).toEqual([376, 320]);
    // A fetched head (342) is still remote only: no branch is yours yet.
    expect(groups.remoteOnly.map((e) => e.pr.number)).toEqual([381, 342, 121, 98]);
    expect(groups.failing).toBe(2);
  });

  it("narrows both groups to failing ones without changing the failing count", () => {
    const groups = groupChangeRequests(list, { failingOnly: true });
    expect(groups.local.map((e) => e.pr.number)).toEqual([320]);
    expect(groups.remoteOnly.map((e) => e.pr.number)).toEqual([342]);
    expect(groups.failing).toBe(2);
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
