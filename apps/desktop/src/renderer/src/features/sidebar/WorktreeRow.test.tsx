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

const render = (wt: Worktree, reorderable = true): string =>
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
      dragProps={{ draggable: reorderable }}
      dragging={false}
      dropPosition={null}
      focusable={false}
      onKeyDown={() => undefined}
      onFocus={() => undefined}
      posinset={1}
      setsize={1}
    />
  );

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
    // The full path is one hover away; the row only has room for the leaf.
    expect(markup).toContain(
      "Worktree folder — /Users/me/claude-worktrees/PwrSnap/recursing-euler-9edf74"
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
    const markup = render(worktree({ branch: "feature/computed" }), false);

    expect(markup).toContain('draggable="false"');
    expect(markup).not.toContain("Drag to reorder");
    expect(markup).toContain(
      '<span class="wt-row__handle" aria-hidden="true"></span>'
    );
  });
});
