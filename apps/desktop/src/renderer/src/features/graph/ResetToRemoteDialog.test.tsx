// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteResetPreview,
  RemoteResetSnapshot,
  ResetTargets,
  Worktree
} from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({ dispatch: dispatchMock }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import {
  resetExecutionRequest,
  resetInspectionRequest,
  ResetToRemoteDialog
} from "./ResetToRemoteDialog";
import { showErrorToast, showInfoToast } from "../../lib/toast";

const worktree: Worktree = {
  id: "worktree-1",
  repoId: "repo-1",
  branch: "feature/local",
  path: "/repos/project",
  dirty: 2,
  ahead: 1,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: false,
  pinned: false,
  isPrimary: true
};

const targets: ResetTargets = {
  branch: "feature/local",
  head: "1".repeat(40),
  upstream: {
    ref: "refs/remotes/origin/feature/local",
    label: "origin/feature/local",
    remote: "origin",
    head: "2".repeat(40),
    lastCommitAt: new Date().toISOString(),
    ahead: 9,
    behind: 15
  },
  defaultBranch: {
    ref: "refs/remotes/origin/main",
    label: "origin/main",
    remote: "origin",
    head: "3".repeat(40),
    lastCommitAt: new Date().toISOString(),
    ahead: 0,
    behind: 24
  },
  forkSource: null,
  branchCount: 39,
  lastFetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  lastFetchedRemotes: ["origin"]
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  dispatchMock.mockImplementation((command: string) => {
    if (command === "remote:resetTargets") {
      return Promise.resolve({ ok: true, value: targets });
    }
    return Promise.resolve({ ok: true, value: null });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function open(
  preselectRef?: string,
  on: Worktree = worktree
): Promise<void> {
  await act(async () => {
    root.render(
      <ResetToRemoteDialog
        worktree={on}
        {...(preselectRef === undefined ? {} : { preselectRef })}
        onClose={() => undefined}
        onComplete={() => undefined}
      />
    );
  });
}

const cards = (): { name: string; checked: boolean }[] =>
  [...container.querySelectorAll<HTMLElement>(".reset-target")].map((card) => ({
    name: card.querySelector(".reset-target__name")?.textContent ?? "",
    checked: card.querySelector<HTMLInputElement>("input")?.checked ?? false
  }));

const text = (): string => container.textContent ?? "";

describe("reset to remote — choosing a target", () => {
  it("preselects the branch's own upstream, not the newest remote branch", async () => {
    await open();

    expect(cards()).toEqual([
      { name: "origin/feature/local", checked: true },
      { name: "origin/main", checked: false },
      { name: "Another fetched branch…", checked: false }
    ]);
  });

  it("shows how far the upstream has moved, on the card itself", async () => {
    await open();

    const upstream = container.querySelector(".reset-target");
    expect(upstream?.textContent).toContain("↑9");
    expect(upstream?.textContent).toContain("↓15");
  });

  it("keeps the full branch list one click away, and says how many", async () => {
    await open();

    expect(text()).toContain("39 fetched");
    // Collapsed until asked for: the two cards are the answer nearly every time.
    expect(container.querySelector(".branch-picker")).toBeNull();

    const another = container.querySelectorAll<HTMLInputElement>(
      ".reset-target input"
    )[2];
    await act(async () => {
      another?.click();
    });
    expect(container.querySelector(".branch-picker")).not.toBeNull();
  });

  /**
   * Both radios rendered `checked` when browsing left the ranked card
   * selected. React re-synced the group back to the card, so the dialog
   * showed the upstream selected, opened the picker anyway, and reset to the
   * upstream if the user pressed Review without picking a row.
   */
  it("hands the target to the list rather than keeping the ranked card", async () => {
    await open();

    const another = container.querySelectorAll<HTMLInputElement>(
      ".reset-target input"
    )[2];
    await act(async () => {
      another?.click();
    });

    expect(cards()).toEqual([
      { name: "origin/feature/local", checked: false },
      { name: "origin/main", checked: false },
      { name: "Another fetched branch…", checked: true }
    ]);
    // Nothing is chosen yet, and the picker must not choose for us: its first
    // row is whatever committed most recently.
    const review = container.querySelector<HTMLButtonElement>(".modal__create");
    expect(review?.disabled).toBe(true);
    await act(async () => {
      review?.click();
    });
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "remote:inspectReset",
      expect.anything()
    );
  });

  it("opens on a caller's ref without touching the picker", async () => {
    await open("refs/remotes/upstream/release/next");

    // The chip menu already named the target, so the two ranked cards are
    // present but neither is chosen.
    expect(cards()).toEqual([
      { name: "origin/feature/local", checked: false },
      { name: "origin/main", checked: false },
      { name: "upstream/release/next", checked: true }
    ]);
  });

  it("dates the fetch the reset actually reads from, and offers to redo it", async () => {
    await open();

    expect(text()).toContain("Last fetched 2h ago");
    const fetchNow = container.querySelector(".reset-remote__fetch");
    expect(fetchNow?.textContent).toBe("Fetch now");

    await act(async () => {
      (fetchNow as HTMLButtonElement).click();
    });
    expect(dispatchMock).toHaveBeenCalledWith("remote:fetch", {
      worktreeId: "worktree-1"
    });
  });

  it("still opens when the branch has no upstream and no remote HEAD", async () => {
    dispatchMock.mockImplementation((command: string) =>
      command === "remote:resetTargets"
        ? Promise.resolve({
            ok: true,
            value: {
              ...targets,
              upstream: null,
              defaultBranch: null,
              lastFetchedAt: null
            }
          })
        : Promise.resolve({ ok: true, value: null })
    );
    await open();

    expect(cards()).toEqual([{ name: "Another fetched branch…", checked: true }]);
    expect(container.querySelector(".branch-picker")).not.toBeNull();
    expect(text()).toContain("has not fetched in this session");
  });
});

describe("reset to remote — reset modes", () => {
  it("states soft, hard, untracked, and commit-reachability effects precisely", async () => {
    await open();
    const markup = container.innerHTML;

    expect(markup).toContain("without changing the index or working tree");
    expect(markup).toContain("discards tracked staged and unstaged changes");
    expect(markup).toContain(
      "Untracked and ignored files are normally left alone"
    );
    expect(markup).toContain("obstructs a tracked path");
    expect(markup).toContain("This does not run git clean");
    expect(markup).toContain(
      "Any local commits that are not reachable from that target"
    );
    expect(markup).toContain("reflog may retain them temporarily");
  });

  it("carries the destructive choice through to the button", async () => {
    await open();
    const review = container.querySelector<HTMLButtonElement>(".modal__create");
    expect(review?.textContent).toBe("Review soft reset");
    expect(review?.className).not.toContain("modal__create--danger");

    const hard = container.querySelectorAll<HTMLInputElement>(
      "input[name='reset-mode']"
    )[1];
    await act(async () => {
      hard?.click();
    });

    const afterHard =
      container.querySelector<HTMLButtonElement>(".modal__create");
    expect(afterHard?.textContent).toBe("Review hard reset");
    expect(afterHard?.className).toContain("modal__create--danger");
  });
});

describe("reset to remote — reviewing the loss", () => {
  function commit(shortHash: string, subject: string) {
    return {
      hash: shortHash.padEnd(40, "0"),
      shortHash,
      subject,
      additions: 2,
      deletions: 1
    };
  }

  function withPreview(
    alignedCommits: RemoteResetPreview["alignedCommits"],
    dirty: number
  ): void {
    dispatchMock.mockImplementation((command: string) => {
      if (command === "remote:resetTargets") {
        return Promise.resolve({ ok: true, value: targets });
      }
      if (command === "remote:inspectReset") {
        return Promise.resolve({
          ok: true,
          value: {
            snapshot: {
              branch: "feature/local",
              head: "1".repeat(40),
              remoteRef: "refs/remotes/origin/feature/local",
              remoteHead: "2".repeat(40)
            },
            leaving: alignedCommits
              .map((row) => row.local)
              .filter((row) => row !== null),
            arriving: alignedCommits
              .map((row) => row.upstream)
              .filter((row) => row !== null),
            alignedCommits,
            dirty
          } satisfies RemoteResetPreview
        });
      }
      return Promise.resolve({ ok: true, value: null });
    });
  }

  async function review(mode: "soft" | "hard"): Promise<void> {
    await open();
    if (mode === "hard") {
      const hard = container.querySelectorAll<HTMLInputElement>(
        "input[name='reset-mode']"
      )[1];
      await act(async () => {
        hard?.click();
      });
    }
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".modal__create")?.click();
    });
  }

  const ledger = (): string[] =>
    [...container.querySelectorAll(".reset-ledger__cell")].map(
      (cell) => cell.textContent ?? ""
    );

  it("does not raise the alarm when every leaving commit is on the target", async () => {
    // A rebased-and-force-pushed upstream: different hashes, same work.
    withPreview(
      [
        {
          local: commit("aaa1111", "add media copy"),
          upstream: commit("bbb2222", "add media copy"),
          relation: "equivalent"
        }
      ],
      0
    );
    await review("hard");

    expect(ledger()[0]).toContain("0");
    expect(ledger()[0]).toContain("only on this branch");
    expect(container.querySelector(".reset-remote__ack")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".modal__create")?.disabled
    ).toBe(false);
    expect(text()).toContain(
      "already on the target under a different object name"
    );
  });

  it("gates a hard reset that would strand commits behind an acknowledgement", async () => {
    withPreview(
      [
        {
          local: commit("aaa5555", "wip: never pushed"),
          upstream: null,
          relation: "local-only"
        },
        {
          local: null,
          upstream: commit("bbb6666", "someone else's fix"),
          relation: "upstream-only"
        }
      ],
      3
    );
    await review("hard");

    expect(ledger().at(-1)).toContain("working-tree changes discarded");
    const confirm =
      container.querySelector<HTMLButtonElement>(".modal__create");
    expect(confirm?.disabled).toBe(true);

    const ack = container.querySelector<HTMLInputElement>(
      ".reset-remote__ack input"
    );
    await act(async () => {
      ack?.click();
    });
    expect(
      container.querySelector<HTMLButtonElement>(".modal__create")?.disabled
    ).toBe(false);
  });

  it("asks nothing extra of a soft reset — the changes stay in the tree", async () => {
    withPreview(
      [
        {
          local: commit("aaa5555", "wip: never pushed"),
          upstream: null,
          relation: "local-only"
        }
      ],
      3
    );
    await review("soft");

    expect(container.querySelector(".reset-remote__ack")).toBeNull();
    expect(text()).toContain(
      "The 1 commit leaving the branch keeps its changes in your working tree"
    );
    // The working-tree cell is a hard-reset fact; soft leaves the tree alone.
    expect(ledger().some((cell) => cell.includes("working-tree"))).toBe(false);
  });
});

describe("reset to remote — request shapes", () => {
  it("wires only the selected full remote ref and reviewed snapshot", () => {
    const snapshot: RemoteResetSnapshot = {
      branch: "feature/local",
      head: "1".repeat(40),
      remoteRef: "refs/remotes/upstream/release/next",
      remoteHead: "2".repeat(40)
    };

    expect(resetInspectionRequest(worktree.id, snapshot.remoteRef)).toEqual({
      worktreeId: "worktree-1",
      remoteRef: "refs/remotes/upstream/release/next"
    });
    expect(resetExecutionRequest(worktree.id, "hard", snapshot)).toEqual({
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
  });
});

describe("reset to remote — a fork and its source", () => {
  const main: Worktree = { ...worktree, branch: "main", isDefaultBranch: true };
  const tracked = "1".repeat(40);
  const sourceTip = "4".repeat(40);

  /** `main` tracks `origin/main`, identical to it; the source is 10 ahead. */
  function forkTargets(
    overrides: {
      overwrites?: number;
      upstreamBehind?: number;
      lastFetchedRemotes?: string[];
    } = {}
  ): ResetTargets {
    const overwrites = overrides.overwrites ?? 0;
    return {
      branch: "main",
      head: tracked,
      upstream: {
        ref: "refs/remotes/origin/main",
        label: "origin/main",
        remote: "origin",
        head: tracked,
        ahead: 0,
        behind: overrides.upstreamBehind ?? 0
      },
      defaultBranch: null,
      forkSource: {
        ref: "refs/remotes/upstream/main",
        label: "upstream/main",
        remote: "upstream",
        head: sourceTip,
        ahead: overwrites,
        behind: 10,
        parent: "acme/widget",
        pushBack: {
          remote: "origin",
          branch: "main",
          ref: "refs/remotes/origin/main",
          head: tracked,
          overwrites,
          adds: 10
        }
      },
      branchCount: 19,
      lastFetchedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      lastFetchedRemotes: overrides.lastFetchedRemotes ?? ["origin", "upstream"]
    };
  }

  function answer(
    value: ResetTargets,
    push: { ok: true; value: null } | { ok: false; error: object } = {
      ok: true,
      value: null
    }
  ): void {
    dispatchMock.mockImplementation((command: string) => {
      if (command === "remote:resetTargets") {
        return Promise.resolve({ ok: true, value });
      }
      if (command === "remote:inspectReset") {
        return Promise.resolve({
          ok: true,
          value: {
            snapshot: {
              branch: "main",
              head: tracked,
              remoteRef: "refs/remotes/upstream/main",
              remoteHead: sourceTip
            },
            leaving: [],
            arriving: [],
            alignedCommits: [],
            dirty: 0
          } satisfies RemoteResetPreview
        });
      }
      if (command === "remote:pushBranchWithLease") {
        return Promise.resolve(push);
      }
      return Promise.resolve({ ok: true, value: null });
    });
  }

  const button = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(".modal__create");
  const pushBox = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>(".reset-remote__push input");

  async function click(element: HTMLElement | null | undefined): Promise<void> {
    await act(async () => {
      element?.click();
    });
  }

  it("opens on the fork's source when the tracked branch would change nothing", async () => {
    answer(forkTargets());
    await open(undefined, main);

    expect(cards()).toEqual([
      { name: "upstream/main", checked: true },
      { name: "origin/main", checked: false },
      { name: "Another fetched branch…", checked: false }
    ]);
    const [fork, same] = container.querySelectorAll(".reset-target");
    expect(fork?.textContent).toContain("acme/widget");
    expect(fork?.textContent).toContain("Fork source");
    expect(fork?.textContent).toContain("↓10");
    // Still choosable, but drawn as the no-op it is — and never called
    // "Upstream" beside a remote that is literally named upstream.
    expect(same?.className).toContain("is-identical");
    expect(same?.textContent).toContain("already identical to main");
    expect(same?.textContent).toContain("Tracking");
    expect(text()).not.toContain("Upstream");
  });

  it("still opens on the tracked branch when resetting to it would move something", async () => {
    answer(forkTargets({ upstreamBehind: 3 }));
    await open(undefined, main);

    expect(cards()[1]).toEqual({ name: "origin/main", checked: true });
    expect(container.querySelector(".reset-remote__push")).toBeNull();
  });

  it("says Upstream remote, not Fork source, when only the remote's name said so", async () => {
    const unconfirmed = forkTargets();
    const { parent: _parent, ...rest } = unconfirmed.forkSource!;
    answer({ ...unconfirmed, forkSource: rest });
    await open(undefined, main);

    expect(text()).toContain("Upstream remote");
    expect(text()).not.toContain("Fork source");
    expect(text()).toContain("After the reset");
  });

  it("offers the fast-forward to the fork, ticked, and names it on the button", async () => {
    answer(forkTargets());
    await open(undefined, main);

    expect(pushBox()?.checked).toBe(true);
    expect(text()).toContain("Update origin/main to match");
    expect(text()).toContain("Fast-forward");
    expect(button()?.textContent).toBe("Review soft reset + push");
    expect(button()?.className).not.toContain("modal__create--danger");

    await click(pushBox());
    expect(button()?.textContent).toBe("Review soft reset");
  });

  it("makes a forced push opt-in, and destructive once chosen", async () => {
    answer(forkTargets({ overwrites: 2 }));
    await open(undefined, main);

    expect(pushBox()?.checked).toBe(false);
    expect(text()).toContain("Force-push origin/main to match");
    expect(text()).toContain("origin/main has 2 commits that upstream/main doesn't");
    expect(button()?.textContent).toBe("Review soft reset");

    await click(pushBox());
    expect(button()?.textContent).toBe("Review soft reset + force-push");
    expect(button()?.className).toContain("modal__create--danger");
  });

  it("offers the push only with the fork's source selected", async () => {
    answer(forkTargets());
    await open(undefined, main);

    await click(
      container.querySelectorAll<HTMLInputElement>(".reset-target input")[1]
    );
    expect(container.querySelector(".reset-remote__push")).toBeNull();
    expect(button()?.textContent).toBe("Review soft reset");
  });

  it("warns when the last fetch skipped the fork's source, and fetches both", async () => {
    answer(forkTargets({ lastFetchedRemotes: ["origin"] }));
    await open(undefined, main);

    const strip = container.querySelector(".reset-remote__fetched");
    expect(strip?.className).toContain("is-stale");
    expect(strip?.textContent).toContain(
      "The last fetch, 2m ago, covered origin only. upstream/main may be behind acme/widget."
    );
    const fetch = container.querySelector<HTMLButtonElement>(".reset-remote__fetch");
    expect(fetch?.textContent).toBe("Fetch origin + upstream");

    await click(fetch);
    expect(dispatchMock).toHaveBeenCalledWith("remote:fetch", {
      worktreeId: "worktree-1",
      remotes: ["origin", "upstream"]
    });
  });

  it("resets, then pushes the reviewed object leased on the reviewed tip", async () => {
    answer(forkTargets());
    await open(undefined, main);
    await click(button());

    const then = container.querySelector(".reset-remote__then");
    expect(then?.textContent).toContain("Then push to your fork");
    expect(then?.textContent).toContain(
      `git push --force-with-lease=refs/heads/main:${tracked} origin ${sourceTip}:refs/heads/main`
    );
    expect(button()?.textContent).toBe("Soft reset + push");

    await click(button());
    const commands = dispatchMock.mock.calls.map(([command]) => command);
    expect(commands.indexOf("remote:pushBranchWithLease")).toBeGreaterThan(
      commands.indexOf("remote:resetToRemote")
    );
    expect(dispatchMock).toHaveBeenCalledWith("remote:pushBranchWithLease", {
      worktreeId: "worktree-1",
      remote: "origin",
      branch: "main",
      head: sourceTip,
      expectedHead: tracked
    });
    expect(showInfoToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Soft reset complete",
        message: expect.stringContaining("origin/main was pushed to match")
      })
    );
  });

  it("reports a refused push as a reset that landed, not a reset that failed", async () => {
    answer(forkTargets(), {
      ok: false,
      error: {
        kind: "remote",
        code: "push_lease_stale",
        message: "origin/main moved after the review, so the lease stopped the push."
      }
    });
    await open(undefined, main);
    await click(button());
    await click(button());

    expect(showErrorToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Soft reset complete — push refused",
        message: expect.stringContaining("origin/main is unchanged")
      })
    );
    expect(showInfoToast).not.toHaveBeenCalled();
  });

  // A soft reset keeps a leaving commit's changes locally, but the forced
  // push still deletes the commits from the fork.
  it("asks for acknowledgement before a forced push, even on a soft reset", async () => {
    answer(forkTargets({ overwrites: 2 }));
    await open(undefined, main);
    await click(pushBox());
    await click(button());

    expect(button()?.textContent).toBe("Soft reset + force-push");
    expect(button()?.disabled).toBe(true);
    const ack = container.querySelector(".reset-remote__ack");
    expect(ack?.textContent).toContain(
      "2 commits will be removed from origin/main"
    );
    await click(ack?.querySelector("input"));
    expect(button()?.disabled).toBe(false);
  });
});
