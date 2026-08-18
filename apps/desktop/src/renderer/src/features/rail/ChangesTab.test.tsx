// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ChangeSet, type Worktree } from "@pwrgit/shared";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  dispatch: vi.fn(),
  subscribe: vi.fn(),
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
  copyText: vi.fn()
}));

vi.mock("../../lib/pwrgit", () => ({
  dispatch: mocks.dispatch,
  subscribe: mocks.subscribe
}));
vi.mock("../shell/dialogs", () => ({ confirmDialog: mocks.confirmDialog }));
vi.mock("../../lib/toast", () => ({
  showErrorToast: mocks.showErrorToast,
  showInfoToast: mocks.showInfoToast
}));
vi.mock("../../lib/copyText", () => ({ copyText: mocks.copyText }));

import { ChangesTab, confirmAndDiscardAllChanges, groupChanges } from "./ChangesTab";

const changes: ChangeSet = {
  staged: [
    { path: "both.txt", status: "M", staged: true },
    { path: "staged add.txt", status: "A", staged: true }
  ],
  unstaged: [
    { path: "both.txt", status: "M", staged: false },
    { path: "new folder/file.txt", status: "?", staged: false }
  ]
};

describe("ChangesTab discard all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.dispatch.mockResolvedValue(ok(null));
  });

  it("confirms the unique file count and sends one bulk IPC command", async () => {
    await confirmAndDiscardAllChanges("worktree-1", changes);

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Discard all changes?",
        message: expect.stringContaining("across 3 files")
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      "changes:discardAll",
      { worktreeId: "worktree-1" }
    );
  });
});

describe("groupChanges", () => {
  const untracked = (path: string) =>
    ({ path, status: "?", staged: false }) as const;

  it("gathers files under their folder, whatever their status", () => {
    const edited = { path: "src/app.ts", status: "M", staged: false } as const;
    expect(
      groupChanges([
        edited,
        untracked("design/handoff/icon.swift"),
        untracked("design/handoff/tray.mjs"),
        untracked("README.md")
      ])
    ).toEqual([
      { kind: "file", file: edited },
      {
        kind: "folder",
        dir: "design/handoff",
        files: [
          untracked("design/handoff/icon.swift"),
          untracked("design/handoff/tray.mjs")
        ]
      },
      { kind: "file", file: untracked("README.md") }
    ]);
  });

  it("does not wrap a lone file in folder chrome", () => {
    expect(groupChanges([untracked("design/only.md")])).toEqual([
      { kind: "file", file: untracked("design/only.md") }
    ]);
  });
});

describe("ChangesTab list", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** Event channel → the ChangesTab handler subscribed to it. */
  let handlers: Map<string, (payload: { worktreeId: string }) => void>;

  const worktree = { id: "worktree-1" } as Worktree;

  const listed: ChangeSet = {
    staged: [],
    unstaged: [
      { path: "design/Background Comparison.html", status: "?", staged: false },
      { path: "design/handoff/icon.swift", status: "?", staged: false },
      { path: "design/handoff/tray.mjs", status: "?", staged: false }
    ]
  };

  const buttonByLabel = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label
    );
    if (found === undefined) {
      throw new Error(
        `no button labelled "${label}"; saw ${[...container.querySelectorAll("button")]
          .map((b) => b.getAttribute("aria-label") ?? b.textContent)
          .join(" | ")}`
      );
    }
    return found;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers = new Map();
    mocks.subscribe.mockImplementation(
      (channel: string, handler: (p: { worktreeId: string }) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      }
    );
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "changes:list" ? ok(listed) : ok(null)
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangesTab worktree={worktree} activeEmail="a@b.c" onOpenDiff={vi.fn()} />
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows a new folder's files and stages the whole folder from one click", async () => {
    expect(container.textContent).toContain("design/handoff/");
    expect(container.textContent).toContain("icon.swift");
    expect(container.textContent).toContain("tray.mjs");

    await act(async () => {
      buttonByLabel("Stage all 2 files in design/handoff").click();
    });

    // Named files, not the directory — `git add -- design/handoff` would also
    // sweep in nested folders this row never listed.
    expect(mocks.dispatch).toHaveBeenCalledWith("changes:stage", {
      worktreeId: "worktree-1",
      paths: ["design/handoff/icon.swift", "design/handoff/tray.mjs"]
    });
  });

  it("unstages a staged folder as a unit", async () => {
    const withStaged: ChangeSet = {
      staged: [
        { path: "design/briefs/one.md", status: "A", staged: true },
        { path: "design/briefs/two.md", status: "A", staged: true }
      ],
      unstaged: []
    };
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "changes:list" ? ok(withStaged) : ok(null)
    );
    await act(async () => {
      handlers.get("changes:changed")?.({ worktreeId: "worktree-1" });
    });

    await act(async () => {
      buttonByLabel("Unstage all 2 files in design/briefs").click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("changes:unstage", {
      worktreeId: "worktree-1",
      paths: ["design/briefs/one.md", "design/briefs/two.md"]
    });
  });

  it("stages one file out of a folder", async () => {
    await act(async () => {
      buttonByLabel("Stage design/handoff/icon.swift").click();
    });

    expect(mocks.dispatch).toHaveBeenCalledWith("changes:stage", {
      worktreeId: "worktree-1",
      paths: ["design/handoff/icon.swift"]
    });
  });

  // The reported bug: the second stage click looked dead, because the list only
  // reloaded on `worktree:changed` and staging a file never moves that state.
  it("re-reads the change set when the index moves", async () => {
    const listCalls = (): number =>
      mocks.dispatch.mock.calls.filter((c) => c[0] === "changes:list").length;
    const before = listCalls();

    await act(async () => {
      handlers.get("changes:changed")?.({ worktreeId: "worktree-1" });
    });

    expect(listCalls()).toBe(before + 1);
  });

  it("ignores index moves in other worktrees", async () => {
    const before = mocks.dispatch.mock.calls.filter(
      (c) => c[0] === "changes:list"
    ).length;

    await act(async () => {
      handlers.get("changes:changed")?.({ worktreeId: "worktree-2" });
    });

    expect(
      mocks.dispatch.mock.calls.filter((c) => c[0] === "changes:list").length
    ).toBe(before);
  });

  it("surfaces a failed stage instead of swallowing it", async () => {
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "changes:list"
        ? ok(listed)
        : {
            ok: false,
            error: { kind: "git", code: "exit_128", message: "index.lock exists" }
          }
    );

    await act(async () => {
      buttonByLabel("Stage design/Background Comparison.html").click();
    });

    expect(mocks.showErrorToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Stage failed",
        message: "index.lock exists"
      })
    );
  });
});

describe("ChangesTab truncation notice", () => {
  let container: HTMLDivElement;
  let root: Root;

  const worktree = { id: "worktree-1" } as Worktree;

  const render = async (changeSet: ChangeSet): Promise<void> => {
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "changes:list" ? ok(changeSet) : ok(null)
    );
    await act(async () => {
      root.render(
        <ChangesTab worktree={worktree} activeEmail="a@b.c" onOpenDiff={vi.fn()} />
      );
    });
  };

  const capped = (largestUntrackedFolder: { dir: string; count: number } | null) =>
    ({
      staged: [],
      unstaged: Array.from({ length: 3 }, (_, i) => ({
        path: `dist/f${i}.js`,
        status: "?" as const,
        staged: false
      })),
      truncated: { staged: 0, unstaged: 20_000, largestUntrackedFolder }
    }) satisfies ChangeSet;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscribe.mockReturnValue(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("says what it is not showing and which folder to ignore", async () => {
    await render(capped({ dir: "dist", count: 19_800 }));

    const notice = container.querySelector(".changes-truncated");
    // "3", not CHANGE_LIST_LIMIT: the notice counts the rows beside it rather
    // than assuming the cap produced them, so the two cannot drift apart.
    expect(notice?.textContent).toContain("Showing 3 of 20,000");
    expect(notice?.textContent).toContain("dist/");
    expect(notice?.textContent).toContain("19,800");
    expect(notice?.textContent).toContain(".gitignore");
  });

  it("counts the header and the commit button off the real total", async () => {
    await render(capped({ dir: "dist", count: 19_800 }));

    // Not "Unstaged · 3" — the header would otherwise contradict the notice
    // sitting directly beneath it.
    expect(container.textContent).toContain("Unstaged · 20,000");
  });

  it("drops the .gitignore advice when no folder is to blame", async () => {
    await render(capped(null));

    const notice = container.querySelector(".changes-truncated");
    expect(notice?.textContent).toContain("Showing");
    expect(notice?.textContent).not.toContain(".gitignore");
  });

  it("shows no notice for a list that fits", async () => {
    await render({
      staged: [],
      unstaged: [{ path: "a.txt", status: "?", staged: false }]
    });

    expect(container.querySelector(".changes-truncated")).toBeNull();
  });
});

describe("ChangesTab folder actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  const worktree = { id: "worktree-1" } as Worktree;

  const listed: ChangeSet = {
    staged: [],
    unstaged: [
      { path: "dist/a.js", status: "?", staged: false },
      { path: "dist/b.js", status: "?", staged: false },
      { path: "src/app.ts", status: "M", staged: false }
    ]
  };

  const byLabel = (label: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label
    );
    if (found === undefined) throw new Error(`no button labelled "${label}"`);
    return found;
  };

  const menuItem = (text: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll(".pop-menu__item")].find(
      (b) => b.textContent === text
    );
    if (found === undefined) {
      throw new Error(
        `no menu item "${text}"; saw ${[...document.querySelectorAll(".pop-menu__item")]
          .map((b) => b.textContent)
          .join(" | ")}`
      );
    }
    return found as HTMLButtonElement;
  };

  const rightClick = async (row: Element): Promise<void> => {
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })
      );
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.subscribe.mockReturnValue(() => undefined);
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "changes:list"
        ? ok(listed)
        : command === "changes:ignore"
          ? ok({ added: ["/dist/"], gitignorePath: "/repo/.gitignore" })
          : ok(null)
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ChangesTab worktree={worktree} activeEmail="a@b.c" onOpenDiff={vi.fn()} />
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("discards a whole folder from its row, after confirming the count", async () => {
    await act(async () => {
      byLabel("Discard all 2 files in dist").click();
    });

    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("all 2 files in dist/"),
        danger: true
      })
    );
    expect(mocks.dispatch).toHaveBeenCalledWith("changes:discard", {
      worktreeId: "worktree-1",
      paths: ["dist/a.js", "dist/b.js"]
    });
  });

  it("does not discard when the confirmation is declined", async () => {
    mocks.confirmDialog.mockResolvedValue(false);

    await act(async () => {
      byLabel("Discard all 2 files in dist").click();
    });

    expect(mocks.dispatch).not.toHaveBeenCalledWith(
      "changes:discard",
      expect.anything()
    );
  });

  it("ignores a whole new folder from the context menu", async () => {
    const folderRow = container.querySelector(".folder-row");
    if (folderRow === null) throw new Error("no folder row");
    await rightClick(folderRow);

    await act(async () => {
      menuItem("Add folder to .gitignore").click();
    });

    // A directory entry, so main writes "/dist/" rather than a file pattern.
    expect(mocks.dispatch).toHaveBeenCalledWith("changes:ignore", {
      worktreeId: "worktree-1",
      entries: [{ path: "dist", directory: true }]
    });
  });

  it("offers no ignore entry for a tracked file", async () => {
    const row = [...container.querySelectorAll(".file-row")].find((r) =>
      r.textContent?.includes("src/app.ts")
    );
    if (row === undefined) throw new Error("no tracked row");
    await rightClick(row);

    expect(
      [...document.querySelectorAll(".pop-menu__item")].map((b) => b.textContent)
    ).toEqual(["Stage", "Copy path", "Discard changes…"]);
  });

  it("says so when the pattern was already there", async () => {
    mocks.dispatch.mockImplementation(async (command: string) =>
      command === "changes:list"
        ? ok(listed)
        : command === "changes:ignore"
          ? ok({ added: [], gitignorePath: "/repo/.gitignore" })
          : ok(null)
    );
    const folderRow = container.querySelector(".folder-row");
    if (folderRow === null) throw new Error("no folder row");
    await rightClick(folderRow);

    await act(async () => {
      menuItem("Add folder to .gitignore").click();
    });

    expect(mocks.showInfoToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Already ignored" })
    );
  });

  it("copies every path a folder stands for", async () => {
    const folderRow = container.querySelector(".folder-row");
    if (folderRow === null) throw new Error("no folder row");
    await rightClick(folderRow);

    await act(async () => {
      menuItem("Copy path").click();
    });

    expect(mocks.copyText).toHaveBeenCalledWith("dist/a.js\ndist/b.js");
  });
});
