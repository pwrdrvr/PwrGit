// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type ChangeRequestEntry,
  type ChangeRequestList,
  type ChangeRequestRemote,
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
import { ChangeRequestTable } from "./RepoChangeRequests";

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

const ORIGIN = "github.com/acme/orbit";
const UPSTREAM = "github.com/orbit-hq/orbit";
const entry = (
  number: number,
  title: string,
  location: ChangeRequestEntry["location"],
  baseRefName = "main",
  remote = "origin"
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
  location,
  remote,
  forgeRepo: remote === "origin" ? ORIGIN : UPSTREAM
});

const remote = (name: string, forgeRepo: string, path: string): ChangeRequestRemote => ({
  name,
  forge: "github",
  forgeRepo,
  path,
  fetchedAt: 1,
  truncated: false
});

const list: ChangeRequestList = {
  forge: "github",
  fetchedAt: 1,
  truncated: false,
  entries: [
    entry(381, "Audit log export", { kind: "unfetched", branch: "fix/audit", remote: "origin" }),
    entry(376, "Plan view", { kind: "worktree", branch: "feat/plan", worktreeId: "wt-9" }),
    entry(342, "Fix links", {
      kind: "remote",
      branch: "fix/links",
      fullName: "refs/remotes/origin/fix/links"
    }, "feat/plan"),
    entry(320, "Electron 44", { kind: "local", branch: "build/electron-44" })
  ],
  remotes: [remote("origin", ORIGIN, "acme/orbit")]
};

let container: HTMLDivElement;
let root: Root;
let answer: ChangeRequestList;

beforeEach(() => {
  answer = list;
  window.localStorage.clear();
  dispatchMock.mockImplementation((channel: string, req: { number?: number }) => {
    if (channel === "pr:openList") return Promise.resolve(ok(answer));
    if (channel === "pr:fetchHead") {
      // Main re-locates against git: a fetched head, or a local branch as-is.
      return Promise.resolve(
        req.number === 320
          ? ok({ kind: "local", branch: "build/electron-44" })
          : ok({ kind: "remote", branch: "fix/audit", fullName: "refs/remotes/origin/fix/audit" })
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

async function render(shownRepo: Repo = repo): Promise<void> {
  await act(async () => {
    root.render(
      <RepoChangeRequestSection
        repo={shownRepo}
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
    expect(dispatchMock).toHaveBeenCalledWith("pr:fetchHead", {
      repoId: "repo-1",
      number: 381,
      forgeRepo: ORIGIN
    });
    expect(onCreateWorktree).toHaveBeenCalledWith(
      "fix/audit",
      true,
      "refs/remotes/origin/fix/audit",
      expect.objectContaining({ number: 381 })
    );

    // A local branch is checked out as itself — after main confirms git still
    // has it, since the list located it from the index.
    dispatchMock.mockClear();
    await act(async () => button("New worktree for #320")?.click());
    expect(dispatchMock).toHaveBeenCalledWith("pr:fetchHead", {
      repoId: "repo-1",
      number: 320,
      forgeRepo: ORIGIN
    });
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

  it("shows failing ones wherever they are, and keeps the way back to all of them", async () => {
    answer = {
      ...list,
      entries: list.entries.map((e) =>
        e.pr.number === 342 ? { ...e, pr: { ...e.pr, checkState: "failing" as const } } : e
      )
    };
    await render();
    const chip = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>(".ref-section__chip.is-failing");
    expect(chip()?.textContent).toBe("1 failing");

    // #342 is only on the forge: the filter opens Remote only to show it.
    await act(async () => chip()?.click());
    expect(head()?.getAttribute("aria-expanded")).toBe("true");
    expect(rowNumbers()).toEqual(["#342"]);

    // A refresh fixes it; the chip stays, pressed, so the filter can be undone.
    answer = list;
    await act(async () => {
      await button("Refresh open pull requests for orbit")?.click();
    });
    expect(rowNumbers()).toEqual([]);
    expect(chip()?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => chip()?.click());
    expect(rowNumbers()).toEqual(["#376", "#320", "#381", "#342"]);
    expect(chip()).toBeNull();
  });

  it("offers no copy for a head nobody can name", async () => {
    answer = {
      ...list,
      entries: [entry(98, "Gone", { kind: "missing", branch: null })]
    };
    window.localStorage.setItem("pwrgit.changeRequestsOpen.repo-1", "1");
    window.localStorage.setItem("pwrgit.changeRequestsRemoteOpen.repo-1", "1");
    await render();
    expect(container.querySelector(".ref-cr-row .copyable")).toBeNull();
    expect(container.querySelector(".ref-cr-row__head")?.textContent).toBe("—");
    expect(button("New worktree for #98 — unavailable")?.disabled).toBe(true);
  });

  it("holds its place before the first answer when origin's identity names a forge", async () => {
    const identified: Repo = {
      ...repo,
      id: "repo-identified",
      identity: {
        host: "github",
        hostname: "github.com",
        owner: "acme",
        name: "orbit",
        nameWithOwner: "acme/orbit",
        visibility: "public"
      }
    };
    let answerNow: () => void = () => undefined;
    dispatchMock.mockImplementation(
      () => new Promise((resolve) => { answerNow = () => resolve(ok(list)); })
    );
    await render(identified);
    // The heading is there already, counting nothing yet.
    expect(head()?.textContent).toContain("Pull requests");
    expect(head()?.textContent).toContain("…");
    await act(async () => answerNow());
    expect(head()?.textContent).toContain("4");

    // Without an identity there is nothing to predict from: no heading yet.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ ...repo, id: "repo-unknown" });
    expect(container.querySelector(".ref-cr-section")).toBeNull();
  });

  it("paints the last answer at once when it mounts again", async () => {
    const seen: Repo = { ...repo, id: "repo-seen" };
    await render(seen);
    await act(async () => root.unmount());
    root = createRoot(container);
    dispatchMock.mockImplementation(() => new Promise(() => undefined));
    await render(seen);
    expect(head()?.textContent).toContain("4");
  });

  it("re-reads when a worktree comes or goes", async () => {
    await render();
    const reads = (): number =>
      dispatchMock.mock.calls.filter(([channel]) => channel === "pr:openList").length;
    expect(reads()).toBe(1);
    await render({
      ...repo,
      worktrees: [...repo.worktrees, worktree("wt-10", "fix/audit")]
    });
    expect(reads()).toBe(2);
  });

  it("says when the last refresh failed, and that the list is older", async () => {
    answer = { ...list, failure: { at: 1, message: "API rate limit exceeded" } };
    window.localStorage.setItem("pwrgit.changeRequestsOpen.repo-1", "1");
    await render();
    expect(container.querySelector(".ref-cr-stale")?.textContent).toContain(
      "Couldn't refresh: API rate limit exceeded"
    );
    const refresh = button("Refresh open pull requests for orbit, last refresh failed");
    expect(refresh?.classList.contains("is-warn")).toBe(true);
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

  describe("with more than one remote", () => {
    // A fork checkout: origin is yours, upstream the original. Your branch
    // carries the CI PR on your fork (#14) and the one you sent up (#412).
    const fork: ChangeRequestList = {
      forge: "github",
      fetchedAt: 1,
      truncated: false,
      entries: [
        entry(14, "Deploy on Windows (CI)", { kind: "local", branch: "tenant-deploy" }),
        entry(412, "Deploy on Windows", { kind: "local", branch: "tenant-deploy" }, "main", "upstream"),
        entry(405, "Fix quartz", { kind: "unfetched", branch: "fix/quartz", remote: "upstream" }, "main", "upstream"),
        entry(13, "CI only", { kind: "unfetched", branch: "ci/only", remote: "origin" })
      ],
      remotes: [remote("origin", ORIGIN, "acme/orbit"), remote("upstream", UPSTREAM, "orbit-hq/orbit")]
    };
    const segments = (): string[] =>
      [...container.querySelectorAll(".ref-cr-lens__seg")].map(
        (segment) => segment.textContent ?? ""
      );
    const segment = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll<HTMLButtonElement>(".ref-cr-lens__seg")].find(
        (candidate) => candidate.querySelector(".ref-cr-lens__label")?.textContent === label
      );

    beforeEach(() => {
      answer = fork;
      window.localStorage.setItem("pwrgit.changeRequestsOpen.repo-1", "1");
      window.localStorage.setItem("pwrgit.changeRequestsRemoteOpen.repo-1", "1");
    });

    it("draws a branch once, with its other PR and each row's remote", async () => {
      await render();
      expect(segments()).toEqual(["All4", "origin2", "upstream2"]);
      expect(rowNumbers()).toEqual(["#412", "#405", "#13"]);
      const local = container.querySelector(".ref-cr-row");
      expect(local?.querySelector(".ref-cr-paired")?.textContent).toContain("#14");
      expect(local?.querySelector(".ref-cr-paired__remote")?.textContent).toBe("origin");
      expect(
        [...container.querySelectorAll(".ref-cr-remote__name")].map((chip) => chip.textContent)
      ).toEqual(["upstream", "upstream", "origin"]);
    });

    it("narrows to one remote, drops the chips it no longer needs, and remembers", async () => {
      await render();
      await act(async () => segment("upstream")?.click());
      expect(head()?.textContent).toContain("2");
      expect(rowNumbers()).toEqual(["#412", "#405"]);
      expect(container.querySelector(".ref-cr-remote")).toBeNull();
      expect(container.querySelector(".ref-cr-paired")).toBeNull();
      expect(window.localStorage.getItem("pwrgit.changeRequestsLens.repo-1")).toBe(UPSTREAM);

      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(segment("upstream")?.getAttribute("aria-pressed")).toBe("true");
      expect(rowNumbers()).toEqual(["#412", "#405"]);
    });

    it("fetches a row's head from the forge repository that listed it", async () => {
      await render();
      await act(async () => button("New worktree for #405")?.click());
      expect(dispatchMock).toHaveBeenCalledWith("pr:fetchHead", {
        repoId: "repo-1",
        number: 405,
        forgeRepo: UPSTREAM
      });
    });

    it("draws no lens when only one remote lists anything", async () => {
      answer = { ...fork, entries: fork.entries.filter((item) => item.remote === "origin") };
      await render();
      expect(container.querySelector(".ref-cr-lens")).toBeNull();
      expect(container.querySelector(".ref-cr-remote")).toBeNull();
    });

    it("names both kinds, and marks each segment, when the forges differ", async () => {
      const mirror = "gitlab.com/acme/orbit";
      answer = {
        ...fork,
        entries: [
          entry(1, "On GitHub", { kind: "unfetched", branch: "a", remote: "origin" }),
          { ...entry(2, "On GitLab", { kind: "unfetched", branch: "b", remote: "gitlab" }), remote: "gitlab", forgeRepo: mirror }
        ],
        remotes: [remote("origin", ORIGIN, "acme/orbit"), { ...remote("gitlab", mirror, "acme/orbit"), forge: "gitlab" }]
      };
      await render();
      expect(head()?.textContent).toContain("Pull & merge requests");
      expect(segment("gitlab")?.querySelector("img")).not.toBeNull();
    });

    it("becomes a menu past three remotes", async () => {
      const names = ["origin", "upstream", "mirror", "backup"];
      answer = {
        ...fork,
        entries: names.map((name, index) => ({
          ...entry(index + 1, `PR ${index + 1}`, { kind: "unfetched", branch: `b${index}`, remote: name }),
          remote: name,
          forgeRepo: `github.com/${name}/orbit`
        })),
        remotes: names.map((name) => remote(name, `github.com/${name}/orbit`, `${name}/orbit`))
      };
      await render();
      expect(container.querySelector(".ref-cr-lens__seg")).toBeNull();
      const menu = container.querySelector<HTMLSelectElement>(".ref-cr-lens--menu select");
      expect([...(menu?.options ?? [])].map((option) => option.textContent)).toEqual([
        "All (4)",
        "origin (1)",
        "upstream (1)",
        "mirror (1)",
        "backup (1)"
      ]);
    });
  });
});

// The refs browser's Pull requests tab is where the rows past this section's
// reach are, so a verb here must do the same thing there.
describe("parity with the refs browser's Pull requests tab", () => {
  const onClose = vi.fn();
  async function renderTable(): Promise<void> {
    await act(async () => {
      root.render(
        <ChangeRequestTable
          repoId="repo-1"
          repoName={repo.name}
          worktrees={repo.worktrees}
          forge="github"
          list={list}
          matches={list.entries}
          error={null}
          query=""
          lookup={{ state: "idle" }}
          now={0}
          focusedWorktree={null}
          switching={null}
          onSwitch={() => Promise.resolve()}
          onRevealWorktree={onRevealWorktree}
          onCreateWorktree={onCreateWorktree}
          onClose={onClose}
        />
      );
    });
  }

  beforeEach(() => {
    window.localStorage.setItem("pwrgit.changeRequestsOpen.repo-1", "1");
    window.localStorage.setItem("pwrgit.changeRequestsRemoteOpen.repo-1", "1");
  });

  it("opens New worktree with the same arguments, the PR included", async () => {
    await render();
    await act(async () => button("New worktree for #381")?.click());
    const fromSidebar = onCreateWorktree.mock.lastCall;
    expect(fromSidebar?.[3]).toMatchObject({ number: 381 });

    onCreateWorktree.mockClear();
    await renderTable();
    await act(async () => button("New worktree for #381")?.click());
    expect(onCreateWorktree.mock.lastCall).toEqual(fromSidebar);
  });

  it("names the same folder for a head a worktree holds, and goes there", async () => {
    const folder = (): string | null | undefined =>
      container.querySelector(".ref-checkout-chip .ref-checkout-chip__name")?.textContent;
    await render();
    expect(folder()).toBe("orbit-feat-plan");

    await renderTable();
    expect(folder()).toBe("orbit-feat-plan");
    await act(async () => container.querySelector<HTMLElement>(".ref-checkout-chip")?.click());
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-9");
    expect(onClose).toHaveBeenCalled();
  });
});
