import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

test("⌘F search pick expands the repo, selects Primary, and scrolls it into view", async () => {
  sandbox = createGitSandbox();
  // A branch-heavy repo that sorts FIRST — expanded, its worktrees push
  // everything below it out of the sidebar viewport.
  const park = sandbox.makeRepo("aaa-park");
  for (let i = 0; i < 25; i += 1) {
    park.addWorktree(`wt/pad-${String(i).padStart(2, "0")}`);
  }
  sandbox.makeRepo("agent-kit");

  handle = await launchApp();
  const { window } = handle;
  // Expands aaa-park (26 rows) so agent-kit's row is far below the fold.
  await addRootAndExpand(window, handle, sandbox, "aaa-park");

  // Find via ⌘F (alias of ⌘K), pick agent-kit with Enter.
  await window.keyboard.press("Meta+f");
  await expect(window.locator(".overlay-panel")).toBeVisible();
  await window.locator(".overlay-search input").fill("agent-kit");
  // Wait for the query's results to land before Enter. `repo:search` is an
  // async round-trip with no debounce, and Enter picks `items[sel]` with sel
  // pinned to 0 — so pressing it early picks whatever topped the PREVIOUS
  // (empty-query) browse list, which is alphabetically "aaa-park" here. The
  // window is invisible when the app is idle and opens up whenever the
  // sidebar has more background status work in flight.
  await expect(window.locator(".overlay-result").first()).toContainText(
    "agent-kit"
  );
  await window.keyboard.press("Enter");

  // The main pane switched to agent-kit…
  await expect(window.locator(".titlebar__repo")).toHaveText("agent-kit", {
    timeout: 20_000
  });
  // …AND the sidebar expanded it, selected its Local checkout, and scrolled
  // the row into view (it was below an expanded 26-row repo).
  const selected = window.locator(".wt-row.is-selected");
  await expect(selected.locator(".wt-tag--local")).toBeVisible();
  await expect(selected).toBeInViewport();
});

test("⌘F finds a worktree by branch name and jumps to it", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("expfarm");
  repo.addWorktree("claude/side-by-side-experiment-groups-8013ec");
  for (let i = 0; i < 6; i += 1) repo.addWorktree(`claude/pad-${i}`);
  sandbox.makeRepo("other-repo");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "other-repo");

  // Out-of-order prefix tokens (FTS5) find the branch — "8013 exp side"
  // matches side-by-side-experiment-groups-8013ec.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("8013 exp side");
  const hit = window.locator(".overlay-result", {
    hasText: "claude/side-by-side-experiment-groups-8013ec"
  });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("expfarm");
  // The visible hit lazily fills its status (tip age via the cancelable
  // asyncFill queue → search:status; git fallback since expfarm was never
  // expanded/state-computed).
  await expect(hit.locator(".hit-status__age")).toHaveText(/just now|\d/, {
    timeout: 10_000
  });

  // And the full pasted branch name works too, of course.
  await window
    .locator(".overlay-search input")
    .fill("claude/side-by-side-experiment-groups-8013ec");
  await expect(hit).toBeVisible();
  await window.keyboard.press("Enter");

  // THAT worktree — not the repo's primary — is selected, revealed in the
  // sidebar (repo expanded + scrolled), and driving the main pane.
  const selected = window.locator(".wt-row.is-selected");
  await expect(selected).toContainText(
    "claude/side-by-side-experiment-groups-8013ec",
    { timeout: 20_000 }
  );
  await expect(selected).toBeInViewport();
  await expect(window.locator(".titlebar__branch-name")).toHaveText(
    "claude/side-by-side-experiment-groups-8013ec"
  );
});

// A worktree's directory is named once, when it is created; its branch can be
// renamed or recreated afterwards and nothing renames the directory to match.
// Agent tooling does this routinely, and the sidebar then titled the row with a
// branch that appears nowhere in the shell prompt sitting in that directory —
// while ⌘F for the directory name returned that row (paths are indexed) with
// nothing on it explaining the match.
test("a worktree whose folder no longer matches its branch shows both names", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("snapfarm");
  const wtPath = repo.addWorktree("recursing-euler-9edf74");
  box.git(wtPath, "branch", "-m", "dmg-file-art-update-4fd193");
  box.makeRepo("other-repo");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "snapfarm");

  // The sidebar row carries the branch AND the directory it lives in.
  const row = branchRow(window, "dmg-file-art-update-4fd193");
  await expect(row.locator(".wt-row__branch")).toHaveText(
    "dmg-file-art-update-4fd193",
    { timeout: 20_000 }
  );
  await expect(row.locator(".wt-row__folder-name")).toHaveText(
    "recursing-euler-9edf74"
  );
  // The repo's own checkout keeps its single name: the folder row above it
  // already says "snapfarm".
  await expect(
    branchRow(window, "main").locator(".wt-row__folder")
  ).toHaveCount(0);

  // ⌘F for the directory — what your shell prompt shows — reaches the same
  // row, and the row says why it matched.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("recursing-euler");
  const hit = window.locator(".overlay-result", {
    has: window.locator(".overlay-result__folder-name", {
      hasText: "recursing-euler-9edf74"
    })
  });
  await expect(hit).toHaveCount(1);
  await expect(hit.locator(".overlay-result__name")).toHaveText(
    "dmg-file-art-update-4fd193"
  );
  await window.keyboard.press("Escape");
});

// A branch created without a checkout — the app can now make these itself —
// belongs to no worktree, so before 0022 it was in none of the indexed kinds
// and ⌘K could not reach it at all.
test("⌘F finds a local branch with no worktree and checks it out", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("localonly");
  repo.createBranch("spike/no-checkout");
  box.makeRepo("other-repo");

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "localonly");

  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("spike/no-checkout");
  const hit = window.locator(".overlay-result");
  await expect(hit).toHaveCount(1);
  await expect(hit.locator(".overlay-result__name")).toHaveText(
    "spike/no-checkout"
  );
  // Owning repo plus why it isn't in the sidebar. Nothing to pin, and no lazy
  // status either — there is no working tree to report dirty/ahead/behind.
  await expect(hit).toContainText("localonly · no worktree");
  await expect(hit.locator(".pin")).toHaveCount(0);
  await expect(window.locator(".overlay-foot")).not.toContainText("pin");

  await window.keyboard.press("Enter");

  // The branch already exists, so the modal checks it out rather than creating
  // it — "Create as a new branch" is off, and there is no start point to show.
  const modal = window.locator(".modal", {
    hasText: "New worktree · localonly"
  });
  await expect(modal.locator(".modal__input")).toHaveValue("spike/no-checkout");
  await expect(modal.locator(".modal__check input")).not.toBeChecked();
  await expect(modal).not.toContainText("Starting from");

  await modal.locator(".modal__create").click();
  // `worktree add <path> <branch>` on the existing branch — no "already
  // exists" error, and the branch is now a real checkout in the sidebar.
  await expect(modal).toHaveCount(0);
  await expect(branchRow(window, "spike/no-checkout")).toBeVisible({
    timeout: 20_000
  });
  expect(
    existsSync(join(box.worktreeRoot, "localonly", "spike-no-checkout"))
  ).toBe(true);

  // And the app took you to it. Creating a worktree is a "go there" action —
  // leaving the selection on the repo's primary means hunting for the row you
  // just made, which in a repo with a hundred worktrees is the whole list.
  const selected = window.locator(".wt-row.is-selected");
  await expect(selected).toContainText("spike/no-checkout", {
    timeout: 20_000
  });
  await expect(selected).toBeInViewport();
  await expect(window.locator(".titlebar__branch-name")).toHaveText(
    "spike/no-checkout"
  );

  // And it has moved between indexed kinds: one hit, now a pinnable worktree.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("spike/no-checkout");
  await expect(hit).toHaveCount(1);
  await expect(hit).not.toContainText("no worktree");
  await expect(hit.locator(".pin")).toHaveCount(1);
});

test("narrowing a ⌘F query leaves no stale ghost rows behind", async () => {
  sandbox = createGitSandbox();
  const s = sandbox;
  // A repo whose NAME matches a broad query while its PRIMARY worktree
  // matches by PATH — repo id and primary-worktree id are the same
  // hash-of-path, so a duplicate React key here corrupted reconciliation
  // and stale rows survived every later re-render.
  const repo = s.makeRepo("codex-tools");
  const wt = repo.addWorktree("codex-search-quality-issues");
  s.commit(wt, "q.txt", "quality work");
  s.makeRepo("codex-extras");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, s, "codex-tools");

  await window.keyboard.press("Meta+f");
  const input = window.locator(".overlay-search input");
  // Broad query first — repos + primary-worktree path hits render together.
  await input.fill("codex");
  await expect
    .poll(async () => window.locator(".overlay-result").count())
    .toBeGreaterThan(2);

  // Narrow to the branch. ONLY the branch hit may remain — the row count
  // must agree with the footer, no ghosts from the broad render.
  await input.fill("codex-search-quality");
  await expect(
    window.locator(".overlay-result", { hasText: "codex-search-quality-issues" })
  ).toBeVisible();
  await expect(window.locator(".overlay-result")).toHaveCount(1);
  await expect(window.locator(".overlay-foot")).toContainText("1 result");
});

test("⌘K keeps focus in the query while arrows select and reveal rows", async () => {
  sandbox = createGitSandbox();
  for (let index = 0; index < 14; index += 1) {
    sandbox.makeRepo(`palette-${String(index).padStart(2, "0")}`);
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "palette-00");

  await window.keyboard.press("Meta+k");
  const input = window.locator(".overlay-search input");
  const rows = window.locator(".overlay-result");
  await expect(rows).toHaveCount(14);
  await expect(input).toBeFocused();
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");

  for (let index = 0; index < 12; index += 1) {
    await window.keyboard.press("ArrowDown");
  }
  await window.keyboard.press("ArrowUp");
  const selected = rows.nth(11);
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toBeInViewport();
  await expect(input).toBeFocused();
  const selectedId = await selected.getAttribute("id");
  if (selectedId === null) throw new Error("selected palette row has no id");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    selectedId
  );

  await window.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(window.locator(".titlebar__repo")).toHaveText("palette-11", {
    timeout: 20_000
  });
});

test("⌘F rows show pin state, toggle it by star click and ⌘P, and browse pins-first", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha-kit");
  sandbox.makeRepo("bravo-park");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha-kit");

  // Empty-query browse: alphabetical, nothing pinned yet.
  await window.keyboard.press("Meta+f");
  await expect(window.locator(".overlay-panel")).toBeVisible();
  const bravoRow = window.locator(".overlay-result", { hasText: "bravo-park" });
  await expect(bravoRow).toBeVisible();
  await expect(window.locator(".overlay-result .pin.is-pinned")).toHaveCount(0);

  // Click bravo's star (revealed on hover) — pins without closing the overlay
  // or reordering the open list.
  await bravoRow.locator(".pin").click();
  await expect(bravoRow.locator(".pin.is-pinned")).toBeVisible();
  await expect(window.locator(".overlay-panel")).toBeVisible();

  // Reopen: the pin persisted, and browse floats bravo-park to the top.
  await window.keyboard.press("Escape");
  await window.keyboard.press("Meta+f");
  const firstRow = window.locator(".overlay-result").first();
  await expect(firstRow).toContainText("bravo-park");
  await expect(firstRow.locator(".pin.is-pinned")).toBeVisible();

  // ⌘P unpins the SELECTED row. Selection follows hover, and the cursor is
  // still parked where the star click left it — a re-render under a
  // stationary cursor can re-fire hover on whatever row now sits there
  // (seen on Windows CI), so point at the first row explicitly.
  await firstRow.hover();
  await window.keyboard.press("Meta+p");
  await expect(firstRow.locator(".pin.is-pinned")).toHaveCount(0);
});

test("moving selection via ⌘F leaves no second 'selected-looking' row behind", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha-kit");
  sandbox.makeRepo("bravo-park");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "bravo-park");

  // A real sidebar click on bravo's Local row — this also seeds the batch
  // (shift-range) set with that row.
  await window
    .locator(".repo-block", { hasText: "bravo-park" })
    .locator(".wt-row")
    .first()
    .click();

  // Now move the selection from OUTSIDE the sidebar: ⌘F → pick alpha-kit.
  await window.keyboard.press("Meta+f");
  await window.locator(".overlay-search input").fill("alpha-kit");
  // Same race as above — wait for the query's own results before picking.
  await expect(window.locator(".overlay-result").first()).toContainText(
    "alpha-kit"
  );
  await window.keyboard.press("Enter");
  await expect(window.locator(".titlebar__repo")).toHaveText("alpha-kit", {
    timeout: 20_000
  });

  // Exactly ONE row may look selected. The active row itself may carry the
  // batch class too (CSS neutralizes the combo) — what must NOT exist is a
  // batch-tinted row that isn't the selected one (the "two selected repos at
  // once" bug), and bravo must have no lit rows at all.
  await expect(window.locator(".wt-row.is-selected")).toHaveCount(1);
  await expect(
    window.locator(".wt-row.is-multiselected:not(.is-selected)")
  ).toHaveCount(0);
  const bravo = window.locator(".repo-block", { hasText: "bravo-park" });
  await expect(bravo.locator(".wt-row.is-selected")).toHaveCount(0);
  await expect(bravo.locator(".wt-row.is-multiselected")).toHaveCount(0);
  await expect(
    window
      .locator(".repo-block", { hasText: "alpha-kit" })
      .locator(".wt-row.is-selected")
  ).toHaveCount(1);
});
