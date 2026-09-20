import type { Commit, FileSearchHit, RepoSearchHit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import {
  buildPaletteItems,
  hitForLocation,
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

describe("change requests in the palette", () => {
  const withPr = (hit: RepoSearchHit, number: number): RepoSearchHit => ({
    ...hit,
    pr: {
      number,
      url: `https://github.com/o/r/pull/${number}`,
      title: `PR ${number}`,
      state: "open",
      isDraft: false,
      headRefName: "codex/console"
    }
  });
  const branch: RepoSearchHit = {
    ...repo("orbit"),
    kind: "local_branch",
    name: "codex/console",
    repoName: "orbit"
  };

  it("leads with whatever holds the change request the query names by number", () => {
    // A bare number also reads as a commit hash prefix; the PR is what was meant.
    const items = buildPaletteItems(
      [commit],
      [repo("issue-10604"), withPr(branch, 106)],
      "106"
    );
    expect(items.map(paletteItemKey)[0]).toBe("local_branch:orbit:codex/console");
  });

  it("keys a change request by its number, not its title", () => {
    const a: RepoSearchHit = { ...withPr(branch, 1), kind: "change_request", name: "Same title" };
    const b: RepoSearchHit = { ...withPr(branch, 2), kind: "change_request", name: "Same title" };
    const keys = buildPaletteItems([], [a, b], "same").map(paletteItemKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("turns a fetched head back into the hit the existing paths expect", () => {
    const request: RepoSearchHit = { ...withPr(branch, 106), kind: "change_request", name: "PR 106" };
    expect(
      hitForLocation(request, {
        kind: "remote",
        branch: "codex/console",
        fullName: "refs/remotes/origin/codex/console"
      })
    ).toMatchObject({
      kind: "remote_branch",
      name: "codex/console",
      remoteRef: "refs/remotes/origin/codex/console",
      remoteName: "origin",
      pr: { number: 106 }
    });
    expect(hitForLocation(request, { kind: "local", branch: "pr/106" })).toMatchObject({
      kind: "local_branch",
      name: "pr/106"
    });
    expect(hitForLocation(request, { kind: "missing", branch: null })).toBeNull();
  });
});
