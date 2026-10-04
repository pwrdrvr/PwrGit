// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type ChangeRequestEntry,
  type ChangeRequestList,
  type Repo,
  type Worktree
} from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => ({ showErrorToast: vi.fn(), showInfoToast: vi.fn() }));

import { RepoChangeRequestSection } from "./RepoChangeRequestSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const worktree = (id: string, branch: string, isPrimary = false): Worktree => ({
  id,
  repoId: "repo-1",
  branch,
  path: `/repos/orbit${isPrimary ? "" : `-${branch.replace(/\//g, "-")}`}`,
  dirty: 0,
  ahead: 0,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: isPrimary,
  pinned: false,
  isPrimary
});
const repo: Repo = {
  id: "repo-1",
  name: "orbit",
  path: "/repos/orbit",
  profileId: "profile-1",
  pinned: false,
  worktrees: [worktree("wt-1", "main", true), worktree("wt-9", "feat/plan")]
};

const entry = (
  number: number,
  title: string,
  location: ChangeRequestEntry["location"],
  baseRefName = "main"
): ChangeRequestEntry => ({
  pr: {
    number,
    url: `https://example.test/acme/orbit/pull/${number}`,
    title,
    state: "open",
    isDraft: false,
    forge: "github",
    baseRefName,
    ...(location.kind === "fork" || location.branch === null
      ? {}
      : { headRefName: location.branch })
  },
  location
});

const list: ChangeRequestList = {
  forge: "github",
  fetchedAt: 1,
  truncated: false,
  entries: [
    entry(381, "Audit log export", { kind: "unfetched", branch: "fix/audit" }),
    entry(376, "Plan view", { kind: "worktree", branch: "feat/plan", worktreeId: "wt-9" }),
    entry(342, "Fix links", {
      kind: "remote",
      branch: "fix/links",
      fullName: "refs/remotes/origin/fix/links"
    }, "feat/plan"),
    entry(320, "Electron 44", { kind: "local", branch: "build/electron-44" })
  ]
};

let container: HTMLDivElement;
let root: Root;
let answer: ChangeRequestList;

beforeEach(() => {
  answer = list;
  window.localStorage.clear();
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "pr:openList") return Promise.resolve(ok(answer));
    if (channel === "pr:fetchHead") {
      return Promise.resolve(
        ok({ kind: "remote", branch: "fix/audit", fullName: "refs/remotes/origin/fix/audit" })
      );
    }
    return Promise.resolve(ok(undefined));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

const onCreateWorktree = vi.fn();
const onRevealWorktree = vi.fn();

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <RepoChangeRequestSection
        repo={repo}
        now={0}
        onRevealWorktree={onRevealWorktree}
        onCreateWorktree={onCreateWorktree}
        onOpenBrowser={() => undefined}
      />
    );
  });
}

const head = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(".ref-section__head");
const remoteToggle = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(".ref-cr-subhead--toggle");
const rowNumbers = (): string[] =>
  [...container.querySelectorAll(".ref-cr-row")].map(
    (row) => row.getAttribute("aria-label")?.split(" ")[0] ?? ""
  );
const button = (label: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

describe("RepoChangeRequestSection", () => {
  it("reads the cache without asking the forge, and draws nothing without a forge", async () => {
    await render();
    expect(dispatchMock).toHaveBeenCalledWith("pr:openList", { repoId: "repo-1", refresh: false });
    expect(head()?.textContent).toContain("Pull requests");
    expect(head()?.textContent).toContain("4");

    await act(async () => root.unmount());
    root = createRoot(container);
    answer = { ...list, forge: null };
    await render();
    expect(container.querySelector(".ref-cr-section")).toBeNull();
  });

  it("starts collapsed, then shows Local with Remote only closed until asked", async () => {
    await render();
    expect(head()?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".ref-cr-row")).toBeNull();

    await act(async () => head()?.click());
    expect(rowNumbers()).toEqual(["#376", "#320"]);
    expect(remoteToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(remoteToggle()?.textContent).toContain("2");

    await act(async () => remoteToggle()?.click());
    expect(rowNumbers()).toEqual(["#376", "#320", "#381", "#342"]);
    expect(window.localStorage.getItem("pwrgit.changeRequestsRemoteOpen.repo-1")).toBe("1");
    expect(window.localStorage.getItem("pwrgit.changeRequestsOpen.repo-1")).toBe("1");
  });

  it("goes to the worktree holding a head instead of offering another", async () => {
    await render();
    await act(async () => head()?.click());
    await act(async () => button("Show the worktree with #376 checked out")?.click());
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-9");
    expect(onCreateWorktree).not.toHaveBeenCalled();
  });

  it("fetches an unfetched head, then opens New worktree on it with the PR", async () => {
    window.localStorage.setItem("pwrgit.changeRequestsOpen.repo-1", "1");
    window.localStorage.setItem("pwrgit.changeRequestsRemoteOpen.repo-1", "1");
    await render();
    await act(async () => button("New worktree for #381")?.click());
    expect(dispatchMock).toHaveBeenCalledWith("pr:fetchHead", { repoId: "repo-1", number: 381 });
    expect(onCreateWorktree).toHaveBeenCalledWith(
      "fix/audit",
      true,
      "refs/remotes/origin/fix/audit",
      expect.objectContaining({ number: 381 })
    );

    // A local branch is checked out as itself, no fetch.
    dispatchMock.mockClear();
    await act(async () => button("New worktree for #320")?.click());
    expect(dispatchMock).not.toHaveBeenCalledWith("pr:fetchHead", expect.anything());
    expect(onCreateWorktree).toHaveBeenLastCalledWith(
      "build/electron-44",
      false,
      undefined,
      expect.objectContaining({ number: 320 })
    );
  });

  it("shows the base only when it is not the default branch", async () => {
    window.localStorage.setItem("pwrgit.changeRequestsOpen.repo-1", "1");
    window.localStorage.setItem("pwrgit.changeRequestsRemoteOpen.repo-1", "1");
    await render();
    const bases = [...container.querySelectorAll(".ref-cr-row__base")].map((b) => b.textContent);
    expect(bases).toEqual(["→ feat/plan"]);
  });

  it("waits on ⟳ and marks itself busy until the list is back", async () => {
    let finish: () => void = () => undefined;
    await render();
    dispatchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok(list));
        })
    );
    const refresh = button("Refresh open pull requests for orbit");
    await act(async () => refresh?.click());
    expect(dispatchMock).toHaveBeenCalledWith("pr:openList", {
      repoId: "repo-1",
      refresh: true,
      wait: true
    });
    expect(refresh?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    expect(refresh?.getAttribute("aria-busy")).toBe("false");
  });
});
