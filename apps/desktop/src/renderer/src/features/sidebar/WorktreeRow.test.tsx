// @vitest-environment jsdom
import type { Worktree } from "@pwrgit/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
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

const row = (
  wt: Worktree,
  options: { reorderable?: boolean; platform?: string } = {}
) => (
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

const render = (
  wt: Worktree,
  options: { reorderable?: boolean; platform?: string } = {}
): string => renderToStaticMarkup(row(wt, options));

/**
 * Park the pointer on one element of a live row and read the card it opens.
 *
 * The row's hover copy — the reorder chord, the missing directory's path, the
 * folder line's full branch — used to be native `title` attributes, which
 * `renderToStaticMarkup` put straight into the string these tests assert on.
 * They are `useViewportTooltip` cards now (see `lib/AGENTS.md`), so they exist
 * only once something is hovered: React turns a bubbling `mouseover` into
 * `onMouseEnter`, the same route `WorktreeHeader.test.tsx` takes.
 */
const hoverCard = async (
  wt: Worktree,
  selector: string,
  options: { reorderable?: boolean; platform?: string } = {}
): Promise<string> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(row(wt, options)));
  await act(async () => {
    container
      .querySelector<HTMLElement>(selector)
      ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? "";
  await act(async () => root.unmount());
  container.remove();
  return text;
};

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
    for (const badge of ["●3", "↑2", "↓1", "in default"]) {
      expect(markup).not.toContain(badge);
    }
    // Reset needs the checkout; Remove is exactly what a gone row needs.
    expect(markup).toContain("Worktree actions");
  });

  // The full path is named where the user will look for the tag's meaning.
  it("names the missing directory on the tag's card", async () => {
    const card = await hoverCard(
      worktree({ missing: true, path: "/wt/PwrGit/graph-x" }),
      ".wt-tag--missing"
    );
    expect(card).toContain("/wt/PwrGit/graph-x");
    expect(card).toContain("git still registers the worktree");
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
  });

  // Hovering the folder line names the branch in full — that name is the row's
  // first casualty of a narrow sidebar — over a path elided in the middle so
  // the card fits on screen.
  it("names both on the folder line's card", async () => {
    expect(
      await hoverCard(
        worktree({
          branch: "dmg-file-art-update-4fd193",
          path: "/Users/me/claude-worktrees/PwrSnap/recursing-euler-9edf74"
        }),
        ".wt-row__folder"
      )
    ).toBe(
      "dmg-file-art-update-4fd193\nWorktree folder — /Users/…/PwrSnap/recursing-euler-9edf74"
    );
  });

  // The branch is what a long name truncates to "fix/desktop-price-a…", and
  // the folder line under it is where the pointer lands when someone goes
  // looking for the rest of it.
  it("names the whole branch on the folder line's tooltip", async () => {
    expect(
      await hoverCard(
        worktree({
          branch: "fix/desktop-price-and-token-columns-for-agent-runs",
          path: "/Users/me/claude-worktrees/PwrAgnt/elated-cartwright-f52b78"
        }),
        ".wt-row__folder"
      )
    ).toBe(
      "fix/desktop-price-and-token-columns-for-agent-runs\nWorktree folder — /Users/…/PwrAgnt/elated-cartwright-f52b78"
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
    expect(markup).toContain(
      '<span class="wt-row__handle" aria-hidden="true"></span>'
    );
  });

  // Not `expect(markup).not.toContain("Drag to reorder")`: the chord lives in
  // a hover card rather than a `title` now, so it is absent from the markup of
  // a draggable row too and that assertion would pass for the wrong reason.
  it("opens no reorder card on a computed row", async () => {
    expect(
      await hoverCard(worktree({ branch: "feature/computed" }), ".wt-row__handle", {
        reorderable: false
      })
    ).toBe("");
  });
});

describe("WorktreeRow — platform shortcut affordance", () => {
  it("keeps the Command-glyph reorder tooltip on macOS", async () => {
    expect(
      await hoverCard(worktree({}), ".wt-row__handle", { platform: "darwin" })
    ).toBe("Drag to reorder — or ⇧⌘↑ / ⇧⌘↓ from the keyboard");
  });

  it("shows the working Ctrl chord on Windows", async () => {
    expect(
      await hoverCard(worktree({}), ".wt-row__handle", { platform: "win32" })
    ).toBe("Drag to reorder — or Ctrl+Shift+↑ / Ctrl+Shift+↓ from the keyboard");
  });
});
