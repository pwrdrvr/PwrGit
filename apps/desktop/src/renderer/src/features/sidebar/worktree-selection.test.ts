// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo, Worktree } from "@pwrgit/shared";
import {
  readStoredWorktreeSelection,
  resolveWorktreeSelection,
  storeWorktreeSelection,
  type WorktreeSelection
} from "./worktree-selection";

const worktree = (repoId: string, id: string, isPrimary = false): Worktree => ({
  id,
  repoId,
  branch: id,
  path: `/repos/${repoId}/${id}`,
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

const repo = (id: string, trees: Worktree[]): Repo => ({
  id,
  name: id,
  path: `/repos/${id}`,
  profileId: "personal",
  pinned: false,
  worktrees: trees
});

beforeEach(() => window.localStorage.clear());

describe("stored worktree selection", () => {
  it("round-trips independently per profile", () => {
    storeWorktreeSelection("personal", {
      repoId: "project",
      worktreeId: "feature/personal"
    });
    storeWorktreeSelection("work", {
      repoId: "service",
      worktreeId: "feature/work"
    });

    expect(readStoredWorktreeSelection("personal")).toEqual({
      repoId: "project",
      worktreeId: "feature/personal"
    });
    expect(readStoredWorktreeSelection("work")).toEqual({
      repoId: "service",
      worktreeId: "feature/work"
    });
  });

  it("ignores malformed or incomplete values", () => {
    window.localStorage.setItem(
      "pwrgit.worktreeSelection.personal",
      JSON.stringify({ repoId: "project" })
    );
    expect(readStoredWorktreeSelection("personal")).toBeNull();

    window.localStorage.setItem(
      "pwrgit.worktreeSelection.personal",
      "not json"
    );
    expect(readStoredWorktreeSelection("personal")).toBeNull();
  });

  it("keeps the current session usable when storage rejects writes", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    expect(() =>
      storeWorktreeSelection("personal", {
        repoId: "project",
        worktreeId: "main"
      })
    ).not.toThrow();
    setItem.mockRestore();
  });
});

describe("resolveWorktreeSelection", () => {
  const project = repo("project", [
    worktree("project", "main", true),
    worktree("project", "feature/remembered")
  ]);
  const second = repo("second", [worktree("second", "trunk", true)]);

  it("keeps an exact remembered worktree", () => {
    const remembered: WorktreeSelection = {
      repoId: "project",
      worktreeId: "feature/remembered"
    };
    expect(resolveWorktreeSelection([project, second], remembered)).toBe(
      remembered
    );
  });

  it("falls back to the same repo's primary when a worktree was removed", () => {
    expect(
      resolveWorktreeSelection([project, second], {
        repoId: "project",
        worktreeId: "feature/gone"
      })
    ).toEqual({ repoId: "project", worktreeId: "main" });
  });

  it("falls back to the first available primary when a repo was removed", () => {
    expect(
      resolveWorktreeSelection([project, second], {
        repoId: "gone",
        worktreeId: "also-gone"
      })
    ).toEqual({ repoId: "project", worktreeId: "main" });
  });

  it("skips repositories with no worktrees", () => {
    expect(
      resolveWorktreeSelection([repo("empty", []), second], null)
    ).toEqual({ repoId: "second", worktreeId: "trunk" });
    expect(resolveWorktreeSelection([repo("empty", [])], null)).toBeNull();
  });
});
