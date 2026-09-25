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
