// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type RepoRefs, type Repo } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
const confirmDialogMock = vi.hoisted(() => vi.fn());
const copyTextMock = vi.hoisted(() => vi.fn());
vi.mock("../shell/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shell/dialogs")>()),
  confirmDialog: confirmDialogMock
}));
vi.mock("../../lib/copyText", () => ({ copyText: copyTextMock }));

import { RepoRefsModal, upstreamShorthand } from "./RepoRefsModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const repo: Repo = {
  id: "repo-1",
  name: "widget",
  path: "/repos/widget",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};
const refs: RepoRefs = { branches: [], previewTags: [], tagCount: 0, remotes: [] };

let container: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;

beforeEach(() => {
  dispatchMock.mockImplementation((channel: string, request?: { name?: string }) => {
    if (channel === "remote:addForkParent") return Promise.resolve(ok({ name: request?.name ?? "upstream" }));
    if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
    if (channel === "pr:openList") {
      return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [] }));
    }
    return Promise.resolve(ok({ rows: [], total: 0 }));
  });
  // The sidebar control that opened the browser, behind the backdrop.
  opener = document.createElement("button");
  opener.textContent = "Branches";
  document.body.append(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
  vi.resetAllMocks();
});

async function open(currentRepo = repo, currentRefs = refs, initialTab: "branches" | "remotes" = "branches"): Promise<void> {
  await act(async () => {
    root.render(
      <RepoRefsModal
        repo={currentRepo}
        refs={currentRefs}
        focusedWorktree={null}
        now={0}
        initialTab={initialTab}
        onRefresh={() => undefined}
        onRevealWorktree={() => undefined}
        onCreateWorktree={() => undefined}
        onClose={() => undefined}
      />
    );
  });
}

function press(target: Element, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
    );
  });
}

const dialog = (): HTMLElement =>
  container.querySelector<HTMLElement>('[role="dialog"]')!;
const controls = (): HTMLElement[] =>
  [...dialog().querySelectorAll<HTMLElement>("button, input")].filter(
    (el) => !(el as HTMLButtonElement).disabled
  );
const close = (): HTMLElement => dialog().querySelector<HTMLElement>('[aria-label="Close"]')!;

// The browser said role="dialog" but trapped nothing: Tab walked off its last
// control into the sidebar behind the backdrop (SC 2.4.3).
describe("RepoRefsModal as a modal", () => {
  it("says it is modal, and still lands focus in the search field", async () => {
    await open();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog().querySelector(".refs-search input"));
  });

  it("wraps Tab from its last control to Close, and back", async () => {
    await open();
    expect(controls()[0]).toBe(close());
    const last = controls().at(-1)!;
    last.focus();
    press(last, "Tab");
    expect(document.activeElement).toBe(close());
    press(close(), "Tab", true);
    expect(document.activeElement).toBe(last);
  });

  it("pulls focus that reached the sidebar back inside", async () => {
    await open();
    opener.focus();
    press(opener, "Tab");
    expect(document.activeElement).toBe(close());
  });

  it("returns focus to whatever opened it", async () => {
    await open();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});

describe("fork parent remote offer", () => {
  const fork: Repo = {
    ...repo,
    identity: {
      host: "github",
      hostname: "github.com",
      owner: "me",
      name: "widget",
      nameWithOwner: "me/widget",
      visibility: "public",
      parent: { nameWithOwner: "source/widget", url: "https://github.com/source/widget" }
    }
  };
  const origin = {
    name: "origin",
    fetchUrl: "git@github.com:me/widget.git",
    pushUrl: "git@github.com:me/widget.git",
    skipFetchAll: false,
    previewBranches: [],
    branchCount: 0
  };

  it("offers one click to add and fetch the discovered parent", async () => {
    await open(fork, { ...refs, remotes: [origin] }, "remotes");
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add upstream"));
    expect(add).toBeDefined();
    await act(async () => add?.click());
    expect(dispatchMock).toHaveBeenCalledWith("remote:addForkParent", {
      repoId: "repo-1",
      name: "upstream"
    });
    expect(dispatchMock).toHaveBeenCalledWith("remote:fetchRepo", {
      repoId: "repo-1",
      remote: "upstream"
    });
  });

  it("offers a custom name or moving an occupied upstream", async () => {
    const occupied = { ...origin, name: "upstream", fetchUrl: "git@github.com:other/widget.git" };
    await open(fork, { ...refs, remotes: [origin, occupied] }, "remotes");
    const configure = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Set up parent remote"));
    expect(configure).toBeDefined();
    await act(async () => configure?.click());
    expect(container.textContent).toContain("Use another name");
    expect(container.textContent).toContain("Move current upstream");
    const name = [...container.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Parent remote name")
    )?.querySelector("input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "parent-source");
      name?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add parent remote");
    await act(async () => add?.click());
    expect(dispatchMock).toHaveBeenCalledWith("remote:addForkParent", {
      repoId: "repo-1",
      name: "parent-source"
    });
  });

  it("moves an occupied upstream only after the user chooses that option", async () => {
    const occupied = { ...origin, name: "upstream", fetchUrl: "git@github.com:other/widget.git" };
    await open(fork, { ...refs, remotes: [origin, occupied] }, "remotes");
    const configure = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Set up parent remote"));
    await act(async () => configure?.click());
    const move = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Move current upstream"));
    await act(async () => move?.querySelector("input")?.click());
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add parent remote");
    await act(async () => add?.click());
    expect(dispatchMock).toHaveBeenCalledWith("remote:addForkParent", {
      repoId: "repo-1",
      name: "upstream",
      renameExistingTo: "upstream-2"
    });
  });

  it("does not offer a duplicate when a remote already points to the parent", async () => {
    const parentRemote = { ...origin, name: "source", fetchUrl: "git@github.com:source/widget.git" };
    await open(fork, { ...refs, remotes: [origin, parentRemote] }, "remotes");
    expect(container.textContent).not.toContain("This fork has no remote for its parent");
  });

  it("offers the parent when a same-path mirror is on GitLab", async () => {
    const mirror = { ...origin, name: "mirror", fetchUrl: "git@gitlab.com:source/widget.git" };
    await open(fork, { ...refs, remotes: [origin, mirror] }, "remotes");
    expect(container.textContent).toContain("This fork has no remote for its parent");
  });

  it("does not offer a duplicate for an SSH host alias", async () => {
    const alias = { ...origin, name: "source", fetchUrl: "git@github-work:source/widget.git" };
    await open(fork, { ...refs, remotes: [origin, alias] }, "remotes");
    expect(container.textContent).not.toContain("This fork has no remote for its parent");
  });

  it("keeps the one-click offer focused and prevents another add while fetching", async () => {
    const original = dispatchMock.getMockImplementation()!;
    let finishFetch!: (value: ReturnType<typeof ok>) => void;
    const fetching = new Promise<ReturnType<typeof ok>>((resolve) => { finishFetch = resolve; });
    dispatchMock.mockImplementation((channel: string, request: unknown) =>
      channel === "remote:fetchRepo" ? fetching : original(channel, request)
    );
    await open(fork, { ...refs, remotes: [origin] }, "remotes");
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add upstream"))!;
    add.focus();
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(add.disabled).toBe(false);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(add);
    await act(async () => add.click());
    expect(dispatchMock.mock.calls.filter(([channel]) => channel === "remote:addForkParent")).toHaveLength(1);
    await act(async () => finishFetch(ok(undefined)));
  });

  it("keeps the dialog add button focused during fetch", async () => {
    const original = dispatchMock.getMockImplementation()!;
    let finishFetch!: (value: ReturnType<typeof ok>) => void;
    const fetching = new Promise<ReturnType<typeof ok>>((resolve) => { finishFetch = resolve; });
    dispatchMock.mockImplementation((channel: string, request: unknown) =>
      channel === "remote:fetchRepo" ? fetching : original(channel, request)
    );
    const occupied = { ...origin, name: "upstream", fetchUrl: "git@github.com:other/widget.git" };
    await open(fork, { ...refs, remotes: [origin, occupied] }, "remotes");
    const configure = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Set up parent remote"))!;
    await act(async () => configure.click());
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent === "Add parent remote")!;
    add.focus();
    await act(async () => { add.click(); await Promise.resolve(); });
    expect(add.disabled).toBe(false);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(add);
    await act(async () => add.click());
    expect(dispatchMock.mock.calls.filter(([channel]) => channel === "remote:addForkParent")).toHaveLength(1);
    await act(async () => finishFetch(ok(undefined)));
  });
});

describe("branch pins and the row keyboard", () => {
  const branch = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    fullName: `refs/heads/${name}`,
    head: "a".repeat(40),
    ahead: 0,
    behind: 0,
    tracking: "unpublished" as const,
    checkedOutWorktreeIds: [],
    ...extra
  });
  const withBranches: RepoRefs = {
    ...refs,
    branches: [branch("main", { pinned: true }), branch("dev")]
  };
  const rows = (): HTMLElement[] => [
    ...dialog().querySelectorAll<HTMLElement>("[data-refs-row]")
  ];
  const filter = (): HTMLInputElement =>
    dialog().querySelector<HTMLInputElement>(".refs-search input")!;

  it("stars a pinned branch and leaves the other unstarred", async () => {
    await open(repo, withBranches);
    const pins = [...dialog().querySelectorAll<HTMLElement>("[data-refs-pin]")];
    expect(pins.map((pin) => pin.getAttribute("aria-label"))).toEqual([
      "Unpin branch main",
      "Pin branch dev"
    ]);
    expect(pins.map((pin) => pin.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false"
    ]);
  });

  // Post-ship 3b: pinned rows were hard to find among hundreds.
  it("marks a pinned row so its name can take the accent", async () => {
    await open(repo, withBranches);
    expect(rows().map((row) => row.classList.contains("is-pinned"))).toEqual([
      true,
      false
    ]);
  });

  it("pins through branch:setPin and shows it before the answer lands", async () => {
    await open(repo, withBranches);
    const dev = dialog().querySelector<HTMLElement>(
      '[aria-label="Pin branch dev"]'
    )!;
    await act(async () => dev.click());
    expect(dispatchMock).toHaveBeenCalledWith("branch:setPin", {
      repoId: "repo-1",
      branch: "dev",
      pinned: true
    });
  });

  it("moves from the filter into the rows with ArrowDown, and back with ArrowUp", async () => {
    await open(repo, withBranches);
    press(filter(), "ArrowDown");
    expect(document.activeElement).toBe(rows()[0]);
    press(rows()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows()[1]);
    press(rows()[1]!, "ArrowUp");
    expect(document.activeElement).toBe(rows()[0]);
    press(rows()[0]!, "ArrowUp");
    expect(document.activeElement).toBe(filter());
  });

  it("pins the focused row with Space, and only when the row itself has focus", async () => {
    await open(repo, withBranches);
    const dev = rows()[1]!;
    dev.focus();
    await act(async () => {
      dev.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
      );
    });
    expect(dispatchMock).toHaveBeenCalledWith("branch:setPin", {
      repoId: "repo-1",
      branch: "dev",
      pinned: true
    });
    dispatchMock.mockClear();
    // Space in the filter is a space, not a pin.
    press(filter(), " ");
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "branch:setPin",
      expect.anything()
    );
  });
});

describe("the Upstream column at the 940px window", () => {
  it("says only what differs from the branch's own name", () => {
    expect(upstreamShorthand("origin/main", "main")).toBe("origin/…");
    expect(upstreamShorthand("origin/feat/x", "feat/x")).toBe("origin/…");
    // A different name is the one worth reading, so it is spelled out.
    expect(upstreamShorthand("upstream/fix/local-rewrites", "fix/rewrite-qs")).toBe(
      "upstream/fix/local-rewrites"
    );
    // Only a whole path segment counts as the same name.
    expect(upstreamShorthand("origin/my-main", "main")).toBe("origin/my-main");
  });

  it("puts the text in its own box, so the ellipsis can draw, and keeps the full ref", async () => {
    await open(repo, {
      ...refs,
      branches: [
        {
          name: "tenant-deploy-windows",
          fullName: "refs/heads/tenant-deploy-windows",
          head: "a".repeat(40),
          upstream: "origin/tenant-deploy-windows",
          ahead: 0,
          behind: 0,
          tracking: "up_to_date",
          checkedOutWorktreeIds: []
        }
      ]
    });
    const cell = dialog().querySelector<HTMLElement>(".refs-copyable-upstream")!;
    expect(cell.querySelector(".refs-copyable-upstream__text")?.textContent).toBe(
      "origin/…"
    );
    expect(cell.getAttribute("aria-label")).toBe(
      "Copy upstream branch origin/tenant-deploy-windows"
    );
  });
});

describe("the row menu says what each entry acts on", () => {
  const local = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    fullName: `refs/heads/${name}`,
    head: "a".repeat(40),
    upstream: `origin/${name}`,
    ahead: 0,
    behind: 0,
    tracking: "up_to_date" as const,
    checkedOutWorktreeIds: [],
    ...extra
  });
  const openMenu = async (label: string): Promise<string[]> => {
    await act(async () =>
      dialog().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
    );
    return [...document.querySelectorAll<HTMLElement>('.pop-menu [role="menuitem"]')].map(
      (item) => item.textContent ?? ""
    );
  };
  const choose = async (label: string): Promise<void> => {
    const item = [...document.querySelectorAll<HTMLElement>('.pop-menu [role="menuitem"]')].find(
      (node) => node.textContent?.startsWith(label)
    );
    await act(async () => item!.click());
  };

  beforeEach(() => {
    copyTextMock.mockResolvedValue(undefined);
    confirmDialogMock.mockResolvedValue(false);
  });

  it("names the worktree as what a checked-out branch's pin pins", async () => {
    await open(repo, {
      ...refs,
      branches: [local("tenant-deploy-windows", { checkedOutWorktreeIds: ["wt-1"] }), local("dev")]
    });
    const checkedOut = await openMenu("Actions for tenant-deploy-windows");
    expect(checkedOut[0]).toBe(
      "Pin worktreeThis branch is checked out, so its worktree is what gets pinned."
    );
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => root.render(null));
    await open(repo, { ...refs, branches: [local("dev")] });
    expect((await openMenu("Actions for dev"))[0]).toBe("Pin branch");
  });

  it("copies a remote row's short name, as a click on the name does, and offers the full ref", async () => {
    dispatchMock.mockImplementation((channel: string) => {
      if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
      if (channel === "pr:openList") {
        return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [] }));
      }
      if (channel === "repo:remoteBranches") {
        return Promise.resolve(
          ok({
            rows: [
              {
                name: "codex/console-rebuild-plan",
                qualifiedName: "origin/codex/console-rebuild-plan",
                fullName: "refs/remotes/origin/codex/console-rebuild-plan",
                head: "b".repeat(40)
              }
            ],
            total: 1
          })
        );
      }
      return Promise.resolve(ok({ rows: [], total: 0 }));
    });
    await open();
    // The remote page is debounced (SEARCH_DEBOUNCE_MS).
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    const items = await openMenu("Actions for origin/codex/console-rebuild-plan");
    expect(items).toEqual(["Copy branch name", "Copy origin/codex/console-rebuild-plan"]);
    await choose("Copy branch name");
    expect(copyTextMock).toHaveBeenLastCalledWith("codex/console-rebuild-plan");
    await openMenu("Actions for origin/codex/console-rebuild-plan");
    await choose("Copy origin/");
    expect(copyTextMock).toHaveBeenLastCalledWith("origin/codex/console-rebuild-plan");
  });

  it("says a pinned branch leaves Pinned too, before it is deleted", async () => {
    await open(repo, { ...refs, branches: [local("main", { pinned: true }), local("dev")] });
    await openMenu("Actions for main");
    await choose("Delete");
    expect(confirmDialogMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("\n\nIt's also removed from Pinned in the sidebar.")
      })
    );
    await openMenu("Actions for dev");
    await choose("Delete");
    expect(confirmDialogMock.mock.lastCall?.[0].message).not.toContain("Pinned");
  });
});
