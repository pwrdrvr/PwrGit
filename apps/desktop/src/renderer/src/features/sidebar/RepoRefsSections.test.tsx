// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type Repo, type RepoRefs, type Worktree } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => toastMocks);

import { RepoRefsSections } from "./RepoRefsSections";
import { requestSidebarReveal, settleSidebarReveal } from "./sidebar-reveal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const UPSTREAM_URL = "git@example.test:someone/diskhound.git";

const primary: Worktree = {
  id: "wt-1",
  repoId: "repo-1",
  branch: "main",
  path: "/repos/diskhound",
  dirty: 0,
  ahead: 0,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  pinned: false,
  isPrimary: true
};
const repo: Repo = {
  id: "repo-1",
  name: "diskhound",
  path: "/repos/diskhound",
  profileId: "profile-1",
  pinned: false,
  worktrees: [primary]
};
const remote = (name: string, fetchUrl: string) => ({
  name,
  fetchUrl,
  pushUrl: fetchUrl,
  skipFetchAll: false,
  previewBranches: [],
  branchCount: 0
});
const refs: RepoRefs = {
  branches: [],
  previewTags: [],
  tagCount: 0,
  remotes: [
    remote("origin", "git@example.test:me/diskhound.git"),
    remote("upstream", UPSTREAM_URL)
  ]
};

let container: HTMLDivElement;
let root: Root;
let fetchResult: ReturnType<typeof ok> | ReturnType<typeof err>;

beforeEach(() => {
  fetchResult = ok(undefined);
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:refs") return Promise.resolve(ok(refs));
    if (channel === "forge:hosts") {
      return Promise.resolve(ok({ hosts: [], overrides: {} }));
    }
    if (channel === "remote:fetchRepo") return Promise.resolve(fetchResult);
    return Promise.resolve(ok(undefined));
  });
  // jsdom lays nothing out, so it never grew scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.resetAllMocks();
});

async function render(focusedWorktree: Worktree | null): Promise<void> {
  await act(async () => {
    root.render(
      <RepoRefsSections
        repo={repo}
        now={0}
        focusedWorktree={focusedWorktree}
        onRevealWorktree={() => undefined}
        onCreateWorktree={() => undefined}
        onFork={() => undefined}
      />
    );
  });
}

const button = (label: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const remotesHead = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>(".ref-section__head")].find(
    (head) => head.textContent?.includes("Remotes")
  );
const remoteMain = (name: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(
    `.ref-remote[data-remote="${name}"] .ref-remote__main`
  );

describe("RepoRefsSections fetch toasts", () => {
  it("names the repository and the remote that was fetched", async () => {
    await render(primary);
    await act(async () => remotesHead()?.click());
    await act(async () => button("Fetch upstream")?.click());

    expect(toastMocks.showInfoToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Fetched upstream",
        subject: {
          repoId: "repo-1",
          remote: { name: "upstream", url: UPSTREAM_URL }
        }
      })
    );
  });

  it("names only the repository for a fetch of every remote", async () => {
    await render(primary);
    await act(async () => button("Fetch all remotes for diskhound")?.click());

    expect(toastMocks.showInfoToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Fetched all remotes",
        subject: { repoId: "repo-1" }
      })
    );
  });

  it("names them on a failure too", async () => {
    fetchResult = err({ kind: "git", code: "GIT_FAILED", message: "Could not resolve host" });
    await render(primary);
    await act(async () => remotesHead()?.click());
    await act(async () => button("Fetch upstream")?.click());

    expect(toastMocks.showErrorToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Fetch failed",
        subject: {
          repoId: "repo-1",
          remote: { name: "upstream", url: UPSTREAM_URL }
        }
      })
    );
  });
});

describe("RepoRefsSections remote reveal", () => {
  it("opens Remotes and the remote, and moves focus to it", async () => {
    await render(primary);
    expect(remotesHead()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => requestSidebarReveal("repo-1", "upstream"));

    expect(remotesHead()?.getAttribute("aria-expanded")).toBe("true");
    expect(remoteMain("upstream")?.getAttribute("aria-expanded")).toBe("true");
    // Only the remote asked for — origin stays as it was.
    expect(remoteMain("origin")?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(remoteMain("upstream"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("waits for the selection to reach this repo before it scrolls", async () => {
    await render(null);
    await act(async () => requestSidebarReveal("repo-1", "upstream"));
    // The sidebar is about to scroll to the newly selected worktree; going
    // first would be undone by it.
    expect(remotesHead()?.getAttribute("aria-expanded")).toBe("false");

    await render(primary);
    expect(remoteMain("upstream")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(remoteMain("upstream"));
  });

  it("acts on a request once, not again on a later render", async () => {
    await render(primary);
    await act(async () => requestSidebarReveal("repo-1", "upstream"));
    // The user closes it again; the next render must not reopen it.
    await act(async () => remoteMain("upstream")?.click());
    await render({ ...primary });
    expect(remoteMain("upstream")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves another repository's request alone", async () => {
    await render(primary);
    const seq = await act(async () => requestSidebarReveal("repo-2", "upstream"));
    expect(remotesHead()?.getAttribute("aria-expanded")).toBe("false");
    // The store is module-wide; leave nothing armed for whatever runs next.
    await act(async () => settleSidebarReveal(seq));
  });
});

describe("RepoRefsSections branch counts", () => {
  const branch = (
    name: string,
    over: Partial<RepoRefs["branches"][number]> = {}
  ): RepoRefs["branches"][number] => ({
    name,
    fullName: `refs/heads/${name}`,
    head: "a".repeat(40),
    upstream: `origin/${name}`,
    ahead: 0,
    behind: 0,
    tracking: "up_to_date",
    checkedOutWorktreeIds: [],
    ...over
  });
  const counted: RepoRefs = {
    ...refs,
    branches: [
      branch("main", { checkedOutWorktreeIds: ["wt-1"] }),
      branch("feat/range", { ahead: 3, tracking: "ahead" }),
      branch("fix/legend", { ahead: 1, behind: 4, tracking: "diverged" }),
      branch("fix/tooltip", {
        tracking: "upstream_missing",
        pr: {
          number: 412,
          url: "https://example.test/pull/412",
          title: "Tooltip",
          state: "merged",
          isDraft: false
        }
      }),
      branch("spike/lazy", { tracking: "upstream_missing" })
    ]
  };

  async function renderCounted(onCleanUpBranches?: () => void): Promise<void> {
    dispatchMock.mockImplementation((channel: string) => {
      if (channel === "repo:refs") return Promise.resolve(ok(counted));
      if (channel === "forge:hosts")
        return Promise.resolve(ok({ hosts: [], overrides: {} }));
      if (channel === "repo:remoteBranches")
        return Promise.resolve(ok({ rows: [], total: 0 }));
      // No forge: the browser draws no change-request tab.
      if (channel === "pr:openList") return Promise.resolve(ok(null));
      return Promise.resolve(ok(undefined));
    });
    await act(async () => {
      root.render(
        <RepoRefsSections
          repo={repo}
          now={0}
          focusedWorktree={primary}
          onRevealWorktree={() => undefined}
          onCreateWorktree={() => undefined}
          onFork={() => undefined}
          onCleanUpBranches={onCleanUpBranches}
        />
      );
    });
  }
  const rowNames = (): string[] =>
    [
      ...document.querySelectorAll<HTMLElement>(
        ".refs-table__row .refs-table__identity strong"
      )
    ].map((node) => node.textContent?.split("#")[0]?.trim() ?? "");

  it("draws each count as its own control beside the disclosure", async () => {
    await renderCounted();
    const head = [
      ...container.querySelectorAll<HTMLButtonElement>(".ref-section__head")
    ].find((node) => node.textContent?.includes("Branches"))!;
    // The counts left the disclosure: clicking them no longer folds it.
    expect(head.textContent).not.toContain("↑");
    // Words, not arrows: these count branches, and the arrows are commits.
    expect(button("Show 2 branches with commits to push")?.textContent).toBe(
      "2 ahead"
    );
    expect(button("Show 1 branch behind their upstream")?.textContent).toBe(
      "1 behind"
    );
    expect(
      button("Show 2 branches whose remote branch was deleted")?.textContent
    ).toBe("2 gone");
  });

  it("opens the refs browser on the branches the ↑ count means", async () => {
    await renderCounted();
    await act(async () =>
      button("Show 2 branches with commits to push")?.click()
    );
    const active = document.querySelector(".refs-status-chip.is-active");
    expect(active?.textContent).toBe("To push 2");
    expect(active?.getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["feat/range", "fix/legend"]);
  });

  it("leads the Gone view with its way out, and hands off to the clean-up", async () => {
    const onCleanUp = vi.fn();
    await renderCounted(onCleanUp);
    await act(async () =>
      button("Show 2 branches whose remote branch was deleted")?.click()
    );
    expect(rowNames()).toEqual(["fix/tooltip", "spike/lazy"]);
    const banner = document.querySelector(".refs-gone-banner");
    expect(banner?.textContent).toContain(
      "1 of these has a merged pull request."
    );
    const cleanUp = [...banner!.querySelectorAll("button")].find(
      (node) => node.textContent === "Clean up finished branches…"
    )!;
    await act(async () => cleanUp.click());
    expect(onCleanUp).toHaveBeenCalledOnce();
    // The dialog replaces the browser rather than stacking on it.
    expect(document.querySelector(".refs-browser")).toBeNull();
  });
});

describe("RepoRefsSections forge links", () => {
  it("keeps browser links separate from the remote disclosure", async () => {
    const original = dispatchMock.getMockImplementation()!;
    dispatchMock.mockImplementation((channel: string) => channel === "repo:refs"
      ? Promise.resolve(ok({ ...refs, remotes: [{
          ...remote("origin", "git@github.com:example/demo.git"),
          pushUrl: "git@gitlab.com:example/demo.git"
        }] }))
      : original(channel));
    await render(primary);
    await act(async () => remotesHead()?.click());
    const disclosure = remoteMain("origin")!;
    const links = [...disclosure.parentElement!.querySelectorAll<HTMLAnchorElement>("a.forge-chip")];
    expect(links).toHaveLength(2);
    expect(disclosure.querySelector("a, button, [role=link]")).toBeNull();
    expect(disclosure.textContent).not.toContain("Open repository");
    for (const link of links) {
      expect(link.parentElement).toBe(disclosure.parentElement);
      expect(link.getAttribute("aria-label")).toContain(link.href);
      await act(async () => link.click());
      expect(dispatchMock).toHaveBeenCalledWith("shell:openExternal", { url: link.href });
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    }
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });
});
