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

/** These specs render the strip at rest — the branch picker is never opened,
 *  so its "held elsewhere" escape hatch has nothing to do. */
const chrome = { onRevealBranchWorktree: () => {} };

describe("TitleBar path chip", () => {
  it("renders a Windows path tail instead of the entire backslash path", () => {
    const markup = renderToStaticMarkup(
      <TitleBar {...chrome} repo={repo} worktree={worktree} platform="win32" />
    );
    expect(markup).toContain("pwrdrvr\\PwrGit");
    expect(markup).not.toContain(">C:\\Users\\me\\pwrdrvr\\PwrGit<");
  });

  it("keeps slash-separated macOS path tails", () => {
    const markup = renderToStaticMarkup(
      <TitleBar
        {...chrome}
        repo={repo}
        worktree={{ ...worktree, path: "/Users/me/pwrdrvr/PwrGit" }}
        platform="darwin"
      />
    );
    expect(markup).toContain("pwrdrvr/PwrGit");
  });
});

describe("TitleBar change request crumb", () => {
  it("names the change request on screen where the branch crumb would be", () => {
    const markup = renderToStaticMarkup(
      <TitleBar
        {...chrome}
        repo={repo}
        worktree={worktree}
        changeRequest={{
          pr: {
            number: 381,
            url: "https://example.test/acme/orbit/pull/381",
            title: "Audit log export",
            state: "open",
            isDraft: false,
            forge: "github"
          },
          location: { kind: "unfetched", branch: "fix/audit", remote: "origin" },
          remote: "origin",
          forgeRepo: "github.com/acme/orbit"
        }}
        platform="darwin"
      />
    );
    expect(markup).toContain("titlebar__cr");
    expect(markup).toContain("Audit log export");
    expect(markup).toContain("#381");
    // The worktree it replaces says nothing: no branch, no path.
    expect(markup).not.toContain("titlebar__branch");
    expect(markup).not.toContain("titlebar__pathchip");
  });
});

describe("TitleBar window chrome", () => {
  it("paints caption buttons on Linux, where no frame provides them", () => {
    const markup = renderToStaticMarkup(
      <TitleBar {...chrome} repo={repo} worktree={worktree} platform="linux" />
    );
    expect(markup).toContain('aria-label="Minimize"');
    expect(markup).toContain('aria-label="Maximize"');
    expect(markup).toContain('aria-label="Close"');
  });

  it.each(["darwin", "win32"] as const)(
    "leaves %s window buttons to the OS",
    (platform) => {
      const markup = renderToStaticMarkup(
        <TitleBar {...chrome} repo={repo} worktree={worktree} platform={platform} />
      );
      expect(markup).not.toContain('aria-label="Close"');
    }
  );

  it("keeps the gutter element everywhere and leaves its width to CSS", () => {
    const markup = renderToStaticMarkup(
      <TitleBar {...chrome} repo={null} worktree={null} platform="linux" />
    );
    // Width is CSS's call (darwin only) — the element itself stays, so the
    // strip has the same shape on every platform.
    expect(markup).toContain('class="titlebar__gutter"');
  });
});

describe("TitleBar history", () => {
  const history = {
    canGoBack: true,
    canGoForward: false,
    backLabel: "PwrGit › fix/release-audit",
    onBack: () => {},
    onForward: () => {},
    menuItems: () => []
  };

  it("draws Back and Forward between the brand and the crumbs", () => {
    const markup = renderToStaticMarkup(
      <TitleBar
        {...chrome}
        repo={repo}
        worktree={worktree}
        history={history}
        platform="darwin"
      />
    );
    const nav = markup.indexOf('class="history-nav"');
    expect(nav).toBeGreaterThan(markup.indexOf("titlebar__brand"));
    expect(nav).toBeLessThan(markup.indexOf('class="titlebar__id"'));
    expect(markup).toMatch(/aria-label="Back"[^>]*aria-description="PwrGit › fix\/release-audit"/);
    // Forward is drawn disabled rather than hidden, so the crumbs never move.
    expect(markup).toMatch(/aria-label="Forward"[^>]*disabled=""/);
  });

  it("still draws the pair with nothing selected", () => {
    const markup = renderToStaticMarkup(
      <TitleBar
        {...chrome}
        repo={null}
        worktree={null}
        history={{ ...history, canGoBack: false }}
        platform="darwin"
      />
    );
    expect(markup).toContain('data-testid="history-nav-back"');
  });
});

