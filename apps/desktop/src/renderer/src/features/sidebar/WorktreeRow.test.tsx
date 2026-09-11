import type { Worktree } from "@pwrgit/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorktreeRow } from "./WorktreeRow";

const worktree = (partial: Partial<Worktree>): Worktree => ({
  id: "wt1",
  repoId: "r1",
  branch: "feat/graph-x",
  path: "/wt/PwrGit/graph-x",
  dirty: 0,
  ahead: 0,
  behind: 0,
  behindDefault: 0,
  defaultBranch: "main",
  mergedIntoDefault: false,
  divergedFromDefault: false,
  isDefaultBranch: false,
  pinned: false,
  isPrimary: false,
  ...partial
});

const render = (
  wt: Worktree,
  options: { reorderable?: boolean; platform?: string } = {}
): string =>
  renderToStaticMarkup(
    <WorktreeRow
      worktree={wt}
      selected={false}
      multiSelected={false}
      now={new Date("2026-08-18T12:00:00.000Z").getTime()}
      onSelect={() => undefined}
      onContextMenu={() => undefined}
      onTogglePin={() => undefined}
      onRemove={() => undefined}
      dragProps={{ draggable: options.reorderable ?? true }}
      dragging={false}
      dropPosition={null}
      focusable={false}
      onKeyDown={() => undefined}
      onFocus={() => undefined}
      posinset={1}
      setsize={1}
      platform={options.platform ?? "darwin"}
    />
  );

describe("WorktreeRow — a checkout that is gone", () => {
  // The directory was deleted outside PwrGit (an agent cleaning up its
  // worktrees). The row used to keep its last green badges and every action
  // on it failed with git's raw error; now it says what happened and offers
  // the one thing that helps, which is removing it.
  it("says the directory is missing and drops the stale counts", () => {
    const markup = render(
      worktree({
        missing: true,
        dirty: 3,
        ahead: 2,
        behind: 1,
        mergedIntoDefault: true,
        lastActivityAt: "2026-08-01T00:00:00.000Z"
      })
    );
    expect(markup).toContain("wt-row is-missing");
    expect(markup).toContain(
      '<span class="wt-tag wt-tag--missing"'
    );
    expect(markup).toContain(">directory missing</span>");
    // The full path is named where the user will look for the tag's meaning.
    expect(markup).toContain("/wt/PwrGit/graph-x");
    for (const badge of ["●3", "↑2", "↓1", "in default"]) {
      expect(markup).not.toContain(badge);
    }
    // Reset needs the checkout; Remove is exactly what a gone row needs.
    expect(markup).toContain("Worktree actions");
  });

  it("says nothing on a checkout that is still there", () => {
    expect(render(worktree({}))).not.toContain("directory missing");
    expect(render(worktree({}))).not.toContain("is-missing");
  });

  it("names a locked worktree", () => {
    const markup = render(worktree({ locked: true }));
    expect(markup).toContain('<span class="wt-tag wt-tag--locked"');
    expect(markup).toContain(">locked</span>");
  });
});

describe("WorktreeRow — the folder a worktree lives in", () => {
  // A worktree whose branch was renamed or recreated after it was created keeps
  // its original directory name. The row titled itself with the branch alone,
  // so nothing on screen matched the directory the user was standing in.
  it("names the directory beside the branch when the two differ", () => {
    const markup = render(
      worktree({
        branch: "dmg-file-art-update-4fd193",
        path: "/Users/me/claude-worktrees/PwrSnap/recursing-euler-9edf74"
      })
    );

    expect(markup).toContain(
      '<span class="wt-row__folder-name">recursing-euler-9edf74</span>'
    );
    // Both names, so either one identifies the row.
    expect(markup).toContain("dmg-file-art-update-4fd193");
    // Hovering the folder line names the branch in full — that name is the
    // row's first casualty of a narrow sidebar — over a path elided in the
    // middle so the tooltip fits on screen.
    expect(markup).toContain(
      "dmg-file-art-update-4fd193\nWorktree folder — /Users/…/PwrSnap/recursing-euler-9edf74"
    );
  });

  // The branch is what a long name truncates to "fix/desktop-price-a…", and
  // the folder line under it is where the pointer lands when someone goes
  // looking for the rest of it.
  it("names the whole branch on the folder line's tooltip", () => {
    const markup = render(
      worktree({
        branch: "fix/desktop-price-and-token-columns-for-agent-runs",
        path: "/Users/me/claude-worktrees/PwrAgnt/elated-cartwright-f52b78"
      })
    );

    expect(markup).toContain(
      'title="fix/desktop-price-and-token-columns-for-agent-runs\nWorktree folder — /Users/…/PwrAgnt/elated-cartwright-f52b78"'
    );
  });

  it("says nothing when the branch already names the directory", () => {
    expect(render(worktree({}))).not.toContain("wt-row__folder");
  });

  // The repo's folder row sits directly above it and already carries this name.
  it("says nothing on the primary checkout", () => {
    const markup = render(
      worktree({ branch: "main", path: "/repos/PwrSnap", isPrimary: true })
    );
    expect(markup).not.toContain("wt-row__folder");
  });

  it("labels the folder for a screen reader rather than running two names together", () => {
    const markup = render(
      worktree({ branch: "detached@2ffe55f", path: "/wt/release-audit" })
    );
    expect(markup).toContain('<span class="a11y-sr-only">in folder</span>');
    expect(markup).toContain(
      '<span class="wt-row__folder-name">release-audit</span>'
    );
  });
});

describe("WorktreeRow — reorder affordance", () => {
  it("does not advertise a drag gesture for a computed row", () => {
    const markup = render(worktree({ branch: "feature/computed" }), {
      reorderable: false
    });

    expect(markup).toContain('draggable="false"');
    expect(markup).not.toContain("Drag to reorder");
    expect(markup).toContain(
      '<span class="wt-row__handle" aria-hidden="true"></span>'
    );
  });
});

describe("WorktreeRow — platform shortcut affordance", () => {
  it("keeps the Command-glyph reorder tooltip on macOS", () => {
    expect(render(worktree({}), { platform: "darwin" })).toContain(
      "Drag to reorder — or ⇧⌘↑ / ⇧⌘↓ from the keyboard"
    );
  });

  it("shows the working Ctrl chord on Windows", () => {
    expect(render(worktree({}), { platform: "win32" })).toContain(
      "Drag to reorder — or Ctrl+Shift+↑ / Ctrl+Shift+↓ from the keyboard"
    );
  });
});
