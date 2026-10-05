// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type ChangeRequestList,
  type RepoRefs,
  type Repo,
  type Worktree
} from "@pwrgit/shared";

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
      return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [], remotes: [] }));
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
    const remotes = ["origin", "upstream", "team/rocket"];
    expect(upstreamShorthand("origin/main", "main", remotes)).toBe("origin/…");
    expect(upstreamShorthand("origin/feat/x", "feat/x", remotes)).toBe("origin/…");
    expect(upstreamShorthand("team/rocket/main", "main", remotes)).toBe(
      "team/rocket/…"
    );
    // A different name is the one worth reading, so it is spelled out.
    expect(
      upstreamShorthand("upstream/fix/local-rewrites", "fix/rewrite-qs", remotes)
    ).toBe("upstream/fix/local-rewrites");
    // Only a whole path segment counts as the same name.
    expect(upstreamShorthand("origin/my-main", "main", remotes)).toBe("origin/my-main");
    // A matching tail is not the same name: `x` tracking origin/feature/x.
    expect(upstreamShorthand("origin/feature/x", "x", remotes)).toBe(
      "origin/feature/x"
    );
  });

  it("puts the text in its own box, so the ellipsis can draw, and keeps the full ref", async () => {
    await open(repo, {
      ...refs,
      remotes: [
        {
          name: "origin",
          fetchUrl: "git@github.com:me/widget.git",
          pushUrl: "git@github.com:me/widget.git",
          skipFetchAll: false,
          previewBranches: [],
          branchCount: 0
        }
      ],
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
        return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [], remotes: [] }));
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

// Owner's rule: anything a row in the sidebar's short list can do, the same
// row in the browser can do too — the browser is how the rest are reached.
describe("parity with the sidebar's rows", () => {
  const worktree = (id: string, branch: string, path: string, isPrimary = false): Worktree => ({
    id,
    repoId: "repo-1",
    branch,
    path,
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
  const primary = worktree("wt-1", "main", "/repos/widget", true);
  // A folder that is not the branch's name: the chip has something to say.
  const review = worktree("wt-2", "dev", "/repos/widget-review");
  const withWorktrees: Repo = { ...repo, worktrees: [primary, review] };
  const local = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    fullName: `refs/heads/${name}`,
    head: "a".repeat(40),
    ahead: 0,
    behind: 0,
    tracking: "unpublished" as const,
    checkedOutWorktreeIds: [] as string[],
    ...extra
  });
  const held: RepoRefs = {
    ...refs,
    branches: [
      local("main", { checkedOutWorktreeIds: ["wt-1"] }),
      local("dev", { checkedOutWorktreeIds: ["wt-2"] }),
      local("spike")
    ]
  };
  const ORIGIN = "github.com/acme/widget";
  const prList: ChangeRequestList = {
    forge: "github",
    fetchedAt: 1,
    truncated: false,
    entries: [
      {
        pr: {
          number: 381,
          url: "https://example.test/acme/widget/pull/381",
          title: "Audit log export",
          state: "open",
          isDraft: false,
          forge: "github",
          baseRefName: "main",
          headRefName: "fix/audit"
        },
        location: { kind: "unfetched", branch: "fix/audit", remote: "origin" },
        remote: "origin",
        forgeRepo: ORIGIN
      },
      {
        pr: {
          number: 376,
          url: "https://example.test/acme/widget/pull/376",
          title: "Plan view",
          state: "open",
          isDraft: false,
          forge: "github",
          baseRefName: "main",
          headRefName: "dev"
        },
        location: { kind: "worktree", branch: "dev", worktreeId: "wt-2" },
        remote: "origin",
        forgeRepo: ORIGIN
      }
    ],
    remotes: [
      { name: "origin", forge: "github", forgeRepo: ORIGIN, path: "acme/widget", fetchedAt: 1, truncated: false }
    ]
  };
  const origin = {
    name: "origin",
    fetchUrl: "git@github.com:acme/widget.git",
    pushUrl: "git@github.com:acme/widget.git",
    skipFetchAll: false,
    previewBranches: [],
    branchCount: 2
  };
  const remoteRow = (name: string) => ({
    name,
    qualifiedName: `origin/${name}`,
    fullName: `refs/remotes/origin/${name}`,
    head: "b".repeat(40)
  });

  const onRevealWorktree = vi.fn();
  const onCreateWorktree = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    copyTextMock.mockResolvedValue(undefined);
    dispatchMock.mockImplementation((channel: string, request?: { remote?: string }) => {
      if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
      if (channel === "pr:openList") return Promise.resolve(ok(prList));
      if (channel === "pr:fetchHead") {
        return Promise.resolve(
          ok({ kind: "remote", branch: "fix/audit", fullName: "refs/remotes/origin/fix/audit" })
        );
      }
      if (channel === "repo:remoteBranches" && request?.remote === "origin") {
        return Promise.resolve(ok({ rows: [remoteRow("dev"), remoteRow("feature/x")], total: 2 }));
      }
      return Promise.resolve(ok({ rows: [], total: 0 }));
    });
  });

  async function show(
    initialTab: "branches" | "remotes" | "changeRequests",
    shownRefs: RepoRefs = held
  ): Promise<void> {
    await act(async () => {
      root.render(
        <RepoRefsModal
          repo={withWorktrees}
          refs={shownRefs}
          focusedWorktree={primary}
          now={0}
          initialTab={initialTab}
          onRefresh={() => undefined}
          onRevealWorktree={onRevealWorktree}
          onCreateWorktree={onCreateWorktree}
          onClose={onClose}
        />
      );
    });
    // The remote pages are debounced (SEARCH_DEBOUNCE_MS).
    if (initialTab === "remotes") {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    }
  }

  const rows = (): HTMLElement[] => [
    ...dialog().querySelectorAll<HTMLElement>("[data-refs-row]")
  ];
  const rowFor = (text: string): HTMLElement =>
    rows().find((row) => row.textContent?.includes(text))!;
  const labelled = (label: string): HTMLElement | null =>
    dialog().querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const doubleClick = (target: Element): Promise<void> =>
    act(async () => {
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

  it("names the worktree a branch is checked out in, as the sidebar's chip does", async () => {
    await show("branches");
    const chip = labelled("Go to widget-review, which has dev checked out")!;
    expect(chip.textContent).toBe("⑂widget-review");
    // In the action slot it always spells the folder, even the repo's own:
    // a glyph alone in a button-sized box reads as an empty button.
    expect(labelled("main is checked out here, in widget")?.textContent).toBe("⌂widget");
    expect(labelled("Show worktree widget-review")?.textContent).toBe("Show worktree");
    // A free branch has no chip.
    expect(rowFor("spike").querySelector(".ref-checkout-chip")).toBeNull();

    await act(async () => chip.click());
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
    expect(onClose).toHaveBeenCalled();
  });

  it("runs a row's primary action on double-click, as Enter does", async () => {
    await show("branches");
    // On the name: the widest target, and the one the sidebar uses.
    await doubleClick(rowFor("dev").querySelector(".refs-copyable-name strong")!);
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(copyTextMock).not.toHaveBeenCalled();

    onRevealWorktree.mockClear();
    const dev = rowFor("dev");
    dev.focus();
    press(dev, "Enter");
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
  });

  it("leaves a double-click on a control inside the row to that control", async () => {
    await show("branches");
    const dev = rowFor("dev");
    await doubleClick(dev.querySelector("[data-refs-pin]")!);
    await doubleClick(dev.querySelector(".refs-row-menu")!);
    expect(onRevealWorktree).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("jumps to the first and last row with Home and End", async () => {
    await show("branches");
    rows()[1]!.focus();
    press(rows()[1]!, "End");
    expect(document.activeElement).toBe(rows().at(-1));
    press(rows().at(-1)!, "Home");
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("hands New worktree the pull request, so the dialog can name it", async () => {
    await show("changeRequests");
    await act(async () => labelled("New worktree for #381")!.click());
    expect(dispatchMock).toHaveBeenCalledWith("pr:fetchHead", {
      repoId: "repo-1",
      number: 381,
      forgeRepo: ORIGIN
    });
    expect(onCreateWorktree).toHaveBeenCalledWith(
      "fix/audit",
      true,
      "refs/remotes/origin/fix/audit",
      expect.objectContaining({ number: 381, title: "Audit log export" })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("names a pull request's worktree by its folder, and goes there on double-click", async () => {
    await show("changeRequests");
    const plan = rowFor("Plan view");
    const chip = plan.querySelector<HTMLElement>(".ref-checkout-chip")!;
    expect(chip.getAttribute("aria-label")).toBe(
      "Go to widget-review, which has #376 checked out"
    );
    expect(chip.textContent).toBe("⑂widget-review");
    expect(labelled("Show worktree widget-review")).not.toBeNull();

    await doubleClick(plan.querySelector(".refs-pr-title")!);
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
    expect(onClose).toHaveBeenCalled();
  });

  it("makes each remote's branches focus stops whose Enter runs the leading action", async () => {
    await show("remotes", { ...held, remotes: [origin] });
    const dev = rowFor("dev");
    expect(dev.getAttribute("tabindex")).toBe("-1");
    expect(dev.querySelector(".ref-checkout-chip")?.getAttribute("aria-label")).toBe(
      "Go to widget-review, which has dev checked out"
    );
    expect(labelled("Show worktree widget-review")).not.toBeNull();
    // A branch nothing holds leads with the switch, as in the sidebar.
    expect(
      rowFor("feature/x").querySelector("[data-refs-primary] button")?.getAttribute("aria-label")
    ).toBe("Switch widget to feature/x");

    dev.focus();
    press(dev, "Enter");
    expect(onRevealWorktree).toHaveBeenCalledWith("wt-2");
    expect(onClose).toHaveBeenCalled();
  });
});
