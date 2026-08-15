import type { Commit, RepoSearchHit } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import { buildPaletteItems } from "./RepoSwitcherOverlay";

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

describe("buildPaletteItems", () => {
  it("ranks an exact repository-name match above matching commits", () => {
    const items = buildPaletteItems([commit], [repo("codex-tools"), repo("codex")], "codex");

    expect(items[0]).toMatchObject({
      kind: "repo",
      hit: { name: "codex" }
    });
  });
});
