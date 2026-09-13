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

describe("TitleBar window chrome", () => {
  it("paints caption buttons on Linux, where no frame provides them", () => {
    const markup = renderToStaticMarkup(
      <TitleBar repo={repo} worktree={worktree} platform="linux" />
    );
    expect(markup).toContain('aria-label="Minimize"');
    expect(markup).toContain('aria-label="Maximize"');
    expect(markup).toContain('aria-label="Close"');
  });

  it.each(["darwin", "win32"] as const)(
    "leaves %s window buttons to the OS",
    (platform) => {
      const markup = renderToStaticMarkup(
        <TitleBar repo={repo} worktree={worktree} platform={platform} />
      );
      expect(markup).not.toContain('aria-label="Close"');
    }
  );

  it("keeps the gutter element everywhere and leaves its width to CSS", () => {
    const markup = renderToStaticMarkup(
      <TitleBar repo={null} worktree={null} platform="linux" />
    );
    // Width is CSS's call (darwin only) — the element itself stays, so the
    // strip has the same shape on every platform.
    expect(markup).toContain('class="titlebar__gutter"');
  });
});
