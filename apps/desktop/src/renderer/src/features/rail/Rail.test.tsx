// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type OperationState,
  type StashEntry,
  type Worktree
} from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  stashRenders: [] as Array<{
    entries: StashEntry[];
    loading: boolean;
    reload: () => Promise<void>;
  }>
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));
// The tabs own their own command contracts and suites; this file is about
// which of them the rail lets you reach while Git is mid-operation.
vi.mock("./ChangesTab", () => ({
  ChangesTab: () => <div data-testid="changes-tab" />
}));
vi.mock("./CommitTab", () => ({
  CommitTab: () => <div data-testid="commit-tab" />
}));
vi.mock("./RebaseTab", () => ({
  RebaseTab: () => <div data-testid="rebase-tab" />
}));
vi.mock("./StashesTab", () => ({
  StashesTab: (props: {
    entries: StashEntry[];
    loading: boolean;
    reload: () => Promise<void>;
  }) => {
    mocks.stashRenders.push(props);
    return (
      <div data-testid="stash-view">
        {props.loading ? "loading" : props.entries.map((entry) => entry.name).join(",")}
      </div>
    );
  }
}));

import { Rail } from "./Rail";

const worktree = { id: "worktree-1", dirty: 4 } as Worktree;

const midRebase: OperationState = {
  operation: {
    kind: "rebase",
    label: "Rebase",
    progress: { current: 2, total: 5 }
  },
  conflictCount: 3
};

describe("Rail operation banner", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** Event channel → the handlers the rail subscribed to it. */
  let handlers: Map<string, ((p: { worktreeId: string }) => void)[]>;

  const render = async (
    props: Partial<Parameters<typeof Rail>[0]> = {}
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <Rail
          worktree={worktree}
          state={null}
          activeEmail="a@b.c"
          selectedHashes={[]}
          rebaseAction={null}
          commitFocus={null}
          onCloseCommit={vi.fn()}
          onOpenCommitFile={vi.fn()}
          onOpenFullCommitDiff={vi.fn()}
          onOpenStashPatch={vi.fn()}
          onClearSelection={vi.fn()}
          onCollapse={vi.fn()}
          onOpenDiff={vi.fn()}
          onOpenFileInsight={vi.fn()}
          activeFile={null}
          commitView={null}
          {...props}
        />
      );
    });
  };

  const tabButton = (text: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll("button.rail-tab")].find((b) =>
      (b.textContent ?? "").includes(text)
    ) as HTMLButtonElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    mocks.subscribe.mockImplementation(
      (channel: string, handler: (p: { worktreeId: string }) => void) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return () => handlers.delete(channel);
      }
    );
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "stash:list" ? ok([]) : ok(midRebase)
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows the banner once operation state arrives", async () => {
    await render();

    expect(mocks.dispatch).toHaveBeenCalledWith("operation:state", {
      worktreeId: "worktree-1"
    });
    expect(container.querySelector(".op-banner")).not.toBeNull();
    expect(container.textContent).toContain("step 2 of 5");
  });

  /**
   * The regression that closed the previous attempt: it replaced the whole
   * rail, so mid-rebase you could not see your files, commit, or reach the
   * rebase tab — which is precisely when you need them.
   */
  it("keeps every tab reachable while an operation is in progress", async () => {
    await render();

    expect(container.querySelector('[data-testid="changes-tab"]')).not.toBeNull();
    expect(tabButton("Changes")).toBeTruthy();
    const rebase = tabButton("Rebase");
    expect(rebase).toBeTruthy();

    await act(async () => rebase?.click());

    expect(container.querySelector('[data-testid="rebase-tab"]')).not.toBeNull();
    // The banner stays put across tab switches.
    expect(container.querySelector(".op-banner")).not.toBeNull();
  });

  it("renders the file list immediately, without waiting on operation state", async () => {
    // A dispatch that never settles stands in for a slow/queued git read.
    mocks.dispatch.mockReturnValue(new Promise(() => {}));

    await render();

    expect(container.querySelector('[data-testid="changes-tab"]')).not.toBeNull();
    expect(container.querySelector(".op-banner")).toBeNull();
  });

  it("shows no banner when Git is not mid-operation", async () => {
    mocks.dispatch.mockResolvedValue(
      ok({ operation: null, conflictCount: 0 } satisfies OperationState)
    );

    await render();

    expect(container.querySelector(".op-banner")).toBeNull();
  });

  it("leaves the rail usable when operation state cannot be read", async () => {
    mocks.dispatch.mockResolvedValue(
      err({ kind: "git", code: "boom", message: "git failed" })
    );

    await render();

    expect(container.querySelector(".op-banner")).toBeNull();
    expect(container.querySelector('[data-testid="changes-tab"]')).not.toBeNull();
  });

  it("re-reads state when this worktree's index moves", async () => {
    await render();
    mocks.dispatch.mockClear();

    await act(async () => {
      for (const handler of handlers.get("changes:changed") ?? []) {
        handler({ worktreeId: "worktree-1" });
      }
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("operation:state", {
      worktreeId: "worktree-1"
    });
  });

  it("ignores index movement in another worktree", async () => {
    await render();
    mocks.dispatch.mockClear();

    await act(async () => {
      for (const handler of handlers.get("changes:changed") ?? []) {
        handler({ worktreeId: "worktree-2" });
      }
    });

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("drops a response that lands after the worktree changed", async () => {
    let settleFirst: (value: unknown) => void = () => {};
    mocks.dispatch.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      })
    );
    await render();

    // Switch worktrees, then let the first worktree's read finish late.
    mocks.dispatch.mockResolvedValue(
      ok({ operation: null, conflictCount: 0 } satisfies OperationState)
    );
    await render({ worktree: { id: "worktree-2", dirty: 0 } as Worktree });
    await act(async () => {
      settleFirst(ok(midRebase));
    });

    expect(container.querySelector(".op-banner")).toBeNull();
  });
});

const stash = (hash: string, name: string): StashEntry => ({
  selector: "stash@{0}",
  hash,
  occurrenceCount: 1,
  shortHash: hash.slice(0, 7),
  baseHash: "b".repeat(40),
  branch: "main",
  subject: "On main: " + name,
  name,
  kind: "ordinary",
  createdAt: "2026-08-23T12:00:00Z"
});

const stashWorktree = (id: string, repoId: string): Worktree =>
  ({ id, repoId, branch: "main", dirty: 0 }) as Worktree;

describe("Rail stash loading", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderRail = async (selected: Worktree): Promise<void> => {
    await act(async () => {
      root.render(
        <Rail
          worktree={selected}
          state={null}
          activeEmail="test@pwrgit.dev"
          selectedHashes={[]}
          rebaseAction={null}
          commitFocus={null}
          onCloseCommit={vi.fn()}
          onOpenCommitFile={vi.fn()}
          onOpenFullCommitDiff={vi.fn()}
          onOpenStashPatch={vi.fn()}
          onClearSelection={vi.fn()}
          onCollapse={vi.fn()}
          onOpenDiff={vi.fn()}
        />
      );
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stashRenders.length = 0;
    mocks.subscribe.mockImplementation(() => vi.fn());
    mocks.dispatch.mockImplementation(
      async (command: string, req: { worktreeId: string }) =>
        command === "operation:state"
          ? ok({ operation: null, conflictCount: 0 } satisfies OperationState)
          : ok([
              req.worktreeId === "worktree-a"
                ? stash("a".repeat(40), "repo A")
                : stash("b".repeat(40), "repo B")
            ])
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("ignores an old reload callback after another worktree is selected", async () => {
    await renderRail(stashWorktree("worktree-a", "repo-a"));
    const stashesButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Stashes") === true
    );
    if (stashesButton === undefined) throw new Error("Stashes tab missing");
    await act(async () => stashesButton.click());
    const oldReload = mocks.stashRenders.at(-1)?.reload;
    if (oldReload === undefined) throw new Error("old reload missing");

    await renderRail(stashWorktree("worktree-b", "repo-b"));
    expect(container.querySelector('[data-testid="stash-view"]')?.textContent).toBe(
      "repo B"
    );
    const callsBefore = mocks.dispatch.mock.calls.length;

    await act(async () => oldReload());

    expect(mocks.dispatch).toHaveBeenCalledTimes(callsBefore);
    expect(container.querySelector('[data-testid="stash-view"]')?.textContent).toBe(
      "repo B"
    );
  });
});
