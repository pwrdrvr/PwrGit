import type { Repo, Worktree } from "@pwrgit/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TitleBar } from "./TitleBar";

const worktree: Worktree = {
  id: "worktree-1",
  repoId: "repo-1",
  branch: "main",
  path: "C:\\Users\\me\\pwrdrvr\\PwrGit",
  dirty: 0,
  ahead: 0,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: true,
  pinned: false,
  isPrimary: true
};

const repo: Repo = {
  id: "repo-1",
  name: "PwrGit",
  path: worktree.path,
  profileId: "profile-1",
  pinned: false,
  worktrees: [worktree]
};

describe("TitleBar path chip", () => {
  it("renders a Windows path tail instead of the entire backslash path", () => {
    const markup = renderToStaticMarkup(
      <TitleBar repo={repo} worktree={worktree} platform="win32" />
    );
    expect(markup).toContain("pwrdrvr\\PwrGit");
    expect(markup).not.toContain(">C:\\Users\\me\\pwrdrvr\\PwrGit<");
  });

  it("keeps slash-separated macOS path tails", () => {
    const markup = renderToStaticMarkup(
      <TitleBar
        repo={repo}
        worktree={{ ...worktree, path: "/Users/me/pwrdrvr/PwrGit" }}
        platform="darwin"
      />
    );
    expect(markup).toContain("pwrdrvr/PwrGit");
  });
});
