import { describe, expect, it, vi } from "vitest";
import type { FileChange } from "@pwrgit/shared";
import {
  canIgnore,
  changesRowMenuItems,
  ignorePathFor,
  targetIsStaged,
  targetPaths,
  type ChangesRowTarget
} from "./changes-row-menu";

const file = (
  path: string,
  status: FileChange["status"],
  staged = false
): FileChange => ({ path, status, staged });

const actions = () => ({
  onToggle: vi.fn(),
  onDiscard: vi.fn(),
  onIgnore: vi.fn(),
  onCopyPath: vi.fn(),
  onHistory: vi.fn(),
  onBlame: vi.fn()
});

const labels = (target: ChangesRowTarget): string[] =>
  changesRowMenuItems(target, actions())
    .filter((item) => item.type === "item")
    .map((item) => item.label);

describe("canIgnore", () => {
  it("offers ignoring an untracked file", () => {
    expect(canIgnore({ kind: "file", file: file("dist/app.js", "?") })).toBe(
      true
    );
  });

  it("refuses a tracked file, where a .gitignore line does nothing", () => {
    expect(canIgnore({ kind: "file", file: file("src/app.ts", "M") })).toBe(
      false
    );
  });

  it("refuses a folder holding anything git already tracks", () => {
    // One tracked file is enough: ignoring the folder would not stop git
    // reporting that file, so the menu must not promise it.
    expect(
      canIgnore({
        kind: "folder",
        dir: "mixed",
        files: [file("mixed/new.js", "?"), file("mixed/tracked.ts", "M")]
      })
    ).toBe(false);
  });

  it("offers a folder that is entirely new", () => {
    expect(
      canIgnore({
        kind: "folder",
        dir: "dist",
        files: [file("dist/a.js", "?"), file("dist/b.js", "?")]
      })
    ).toBe(true);
  });
});

describe("ignorePathFor", () => {
  it("ignores a folder as a directory, not as a file", () => {
    expect(
      ignorePathFor({ kind: "folder", dir: "dist", files: [] })
    ).toEqual({ path: "dist", directory: true });
  });

  it("ignores a file by its own path", () => {
    expect(ignorePathFor({ kind: "file", file: file("a/b.js", "?") })).toEqual({
      path: "a/b.js",
      directory: false
    });
  });
});

describe("targetIsStaged", () => {
  it("treats a partly staged folder as unstaged, so staging is offered", () => {
    expect(
      targetIsStaged({
        kind: "folder",
        dir: "d",
        files: [file("d/a", "A", true), file("d/b", "?", false)]
      })
    ).toBe(false);
  });

  it("treats a fully staged folder as staged", () => {
    expect(
      targetIsStaged({
        kind: "folder",
        dir: "d",
        files: [file("d/a", "A", true), file("d/b", "A", true)]
      })
    ).toBe(true);
  });
});

describe("changesRowMenuItems", () => {
  it("names the count so a folder action cannot be mistaken for a file one", () => {
    expect(
      labels({
        kind: "folder",
        dir: "dist",
        files: [file("dist/a.js", "?"), file("dist/b.js", "?")]
      })
    ).toEqual([
      "Stage (2 files)",
      "Add folder to .gitignore",
      "Copy path",
      "Discard (2 files)…"
    ]);
  });

  it("drops the ignore entry for a tracked file", () => {
    expect(labels({ kind: "file", file: file("src/app.ts", "M") })).toEqual([
      "Stage",
      "File history",
      "Blame",
      "Copy path",
      "Discard changes…"
    ]);
  });

  it("offers unstaging for a staged file", () => {
    expect(
      labels({ kind: "file", file: file("src/app.ts", "M", true) })[0]
    ).toBe("Unstage");
  });

  it("marks only discard as destructive", () => {
    const items = changesRowMenuItems(
      { kind: "file", file: file("dist/a.js", "?") },
      actions()
    );
    expect(
      items.filter((item) => item.type === "item" && item.danger === true)
    ).toHaveLength(1);
  });

  it("wires each label to its own action", () => {
    const spies = actions();
    const items = changesRowMenuItems(
      { kind: "file", file: file("dist/a.js", "?") },
      spies
    );
    for (const item of items) {
      if (item.type === "item") item.onSelect();
    }
    expect(spies.onToggle).toHaveBeenCalledOnce();
    expect(spies.onIgnore).toHaveBeenCalledOnce();
    expect(spies.onCopyPath).toHaveBeenCalledOnce();
    expect(spies.onDiscard).toHaveBeenCalledOnce();
  });
});

describe("targetPaths", () => {
  it("stands for every file a folder lists", () => {
    expect(
      targetPaths({
        kind: "folder",
        dir: "dist",
        files: [file("dist/a.js", "?"), file("dist/b.js", "?")]
      })
    ).toEqual(["dist/a.js", "dist/b.js"]);
  });
});

describe("file history and blame entries", () => {
  it("offers both for a tracked file", () => {
    expect(labels({ kind: "file", file: file("src/a.ts", "M") })).toEqual([
      "Stage",
      "File history",
      "Blame",
      "Copy path",
      "Discard changes…"
    ]);
  });

  it("omits them for an untracked file, which has no committed history", () => {
    expect(labels({ kind: "file", file: file("src/new.ts", "?") })).not.toContain(
      "File history"
    );
  });

  it("omits them for a folder, since both are per-file views", () => {
    const target: ChangesRowTarget = {
      kind: "folder",
      dir: "src",
      files: [file("src/a.ts", "M"), file("src/b.ts", "M")]
    };
    expect(labels(target)).not.toContain("Blame");
  });
});
