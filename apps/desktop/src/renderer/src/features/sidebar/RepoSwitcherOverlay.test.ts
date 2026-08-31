import type { Commit, FileSearchHit, RepoSearchHit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import {
  buildPaletteItems,
  paletteItemKey,
  selectedPaletteItemIndex
} from "./RepoSwitcherOverlay";

const commit: Commit = {
  hash: "a".repeat(40),
  shortHash: "a".repeat(7),
  parents: [],
  subject: "fix: codex search results",
  authorName: "Harold",
  authorEmail: "harold@example.com",
  committedAt: "2026-08-15T12:00:00.000Z",
  isMerge: false
};

const repo = (name: string): RepoSearchHit => ({
  kind: "repo",
  repoId: name,
  name,
  path: `/repos/${name}`,
  profileId: "default",
  profileName: "Default",
  worktreeCount: 1,
  pinned: false
});

const file = (path: string): FileSearchHit => {
  const cut = path.lastIndexOf("/");
  return {
    path,
    name: cut === -1 ? path : path.slice(cut + 1),
    dir: cut === -1 ? "" : path.slice(0, cut)
  };
};

describe("buildPaletteItems", () => {
  it("puts file matches above commits but below an exact repo name", () => {
    const items = buildPaletteItems(
      [commit],
      [repo("Codex")],
      "codex",
      [file("src/codex.ts")]
    );

    expect(items.map((item) => item.kind)).toEqual(["repo", "file", "commit"]);
    expect(paletteItemKey(items[1] as never)).toBe("file:src/codex.ts");
  });

  it("keeps every kind addressable by its own key", () => {
    const items = buildPaletteItems([commit], [repo("codex-tools")], "codex", [
      file("README.md")
    ]);
    const keys = items.map((item) => paletteItemKey(item));
    expect(new Set(keys).size).toBe(keys.length);
    expect(selectedPaletteItemIndex(items, "file:README.md")).toBe(0);
  });

  it("omits the file tier entirely when nothing matched", () => {
    const items = buildPaletteItems([commit], [repo("codex-tools")], "codex");
    expect(items.some((item) => item.kind === "file")).toBe(false);
  });

  it("ranks an exact repository-name match above matching commits", () => {
    const items = buildPaletteItems(
      [commit],
      [repo("codex-tools"), repo("Codex")],
      "codex"
    );

    expect(items[0]).toMatchObject({
      kind: "repo",
      hit: { name: "Codex" }
    });
  });

  it("keeps commit-first ordering when no repository name matches exactly", () => {
    const items = buildPaletteItems([commit], [repo("codex-tools")], "codex");

    expect(items.map((item) => item.kind)).toEqual(["commit", "repo"]);
  });

  it("preserves a selected commit when async results prepend an exact repo", () => {
    const otherCommit = {
      ...commit,
      hash: "b".repeat(40),
      shortHash: "b".repeat(7),
      subject: "docs: explain codex search"
    };
    const initialItems = buildPaletteItems([commit, otherCommit], [], "codex");
    const selectedKey = paletteItemKey(initialItems[1]!);

    const reorderedItems = buildPaletteItems(
      [commit, otherCommit],
      [repo("codex")],
      "codex"
    );
    const selectedIndex = selectedPaletteItemIndex(
      reorderedItems,
      selectedKey
    );

    expect(reorderedItems[selectedIndex]).toEqual(initialItems[1]);
    expect(selectedIndex).toBe(2);
  });
});
