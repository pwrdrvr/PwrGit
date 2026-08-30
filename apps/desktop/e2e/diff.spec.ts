import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, primaryShortcut } from "./fixtures/steps";

// Real PNG bytes (4×2 red, then 8×6 blue) — the point of the test is that the
// blob survives the trip from git to <img> intact, so a placeholder string
// would prove nothing.
const PNG_RED_4x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGO4o6EBRwzIHAB/mglherQWOwAAAABJRU5ErkJggg==",
  "base64"
);
const PNG_BLUE_8x6 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGPQCLiDFTEMpAQAjSQ/wczsnUkAAAAASUVORK5CYII=",
  "base64"
);

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

test("clicking a changed file opens its diff, then close returns to lineage", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("diffrepo");
  // Uncommitted modification to the committed README (adds a line).
  writeFileSync(join(repo.path, "README.md"), "# diffrepo\nbrand new line\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "diffrepo");

  // Changes tab (default) frames the WIP and lists the file.
  await expect(window.locator(".changes-wip")).toBeVisible({ timeout: 20_000 });
  const fileRow = window.locator(".file-row", { hasText: "README.md" });
  await expect(fileRow).toBeVisible();
  await fileRow.click();

  // The diff pane shows the added line as an addition row.
  await expect(window.locator(".diff-pane")).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".diff-row--add", { hasText: "brand new line" })
  ).toBeVisible();

  // Close returns to the lineage graph.
  await window.locator(".diff-pane__close").click();
  await expect(window.locator(".graph-toolbar")).toBeVisible();
});

test("hunk and line actions move only the selected changes through Git's index", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("partialdiff");
  const baseline = Array.from({ length: 12 }, (_, index) => `base-${index + 1}`);
  writeFileSync(join(repo.path, "partial.txt"), `${baseline.join("\n")}\n`);
  sandbox.git(repo.path, "add", "partial.txt");
  sandbox.git(repo.path, "commit", "-m", "add partial fixture");
  const working = [...baseline];
  working[1] = "FIRST edit";
  working[9] = "SECOND edit";
  writeFileSync(join(repo.path, "partial.txt"), `${working.join("\n")}\n`);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "partialdiff");

  await window.locator(".file-row", { hasText: "partial.txt" }).click();
  await expect(window.locator(".diff-pane__sub")).toHaveText(
    "index → working tree"
  );
  const hunkActions = window.getByRole("button", { name: "Stage hunk" });
  await expect(hunkActions).toHaveCount(2);

  // Stamp the rendered diff so the check after the stage can tell a repaint
  // from a teardown. Scroll position is the thing the reader actually loses
  // when the body is swapped for a placeholder, but a fixture diff is not
  // reliably taller than the window; the node's survival is the same fact
  // measured without that dependency.
  const view = window.locator(".diff-view");
  await view.evaluate((node) => {
    (node as HTMLElement & { pwrgitProbe?: string }).pwrgitProbe = "kept";
  });

  await hunkActions.first().click();

  await expect
    .poll(() => sandbox?.git(repo.path, "diff", "--cached") ?? "")
    .toContain("FIRST edit");
  expect(sandbox.git(repo.path, "diff", "--cached")).not.toContain(
    "SECOND edit"
  );
  expect(sandbox.git(repo.path, "diff")).toContain("SECOND edit");

  // Applying repaints in place: the same node carries the new patch, so a
  // reader partway down a long file keeps their position instead of being
  // thrown back to line 1 on every hunk they stage.
  await expect(window.locator(".diff-empty")).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Stage hunk" })).toHaveCount(1);
  expect(
    await view.evaluate(
      (node) => (node as HTMLElement & { pwrgitProbe?: string }).pwrgitProbe
    )
  ).toBe("kept");

  // The rail still presents both sides of the partially-staged file, and now
  // says they are one file split rather than two that share a name.
  await expect(
    window.locator(".file-row.is-staged", { hasText: "partial.txt" })
  ).toBeVisible();
  await expect(
    window.locator(".file-row:not(.is-staged)", { hasText: "partial.txt" })
  ).toBeVisible();
  await expect(window.locator(".file-row .file-split")).toHaveCount(2);

  // Crossing to the staged side is a tab in the pane, not a close-and-reopen.
  // Scoped to the tab group and exact: "Staged" is a substring of "Unstaged",
  // and the rail carries section headings by those names too.
  await window
    .locator(".diff-side")
    .getByRole("button", { name: "Staged", exact: true })
    .click();
  await expect(window.locator(".diff-pane__sub")).toHaveText("HEAD → index");
  await window.getByRole("button", { name: "Unstage hunk" }).click();
  await expect
    .poll(() => sandbox?.git(repo.path, "diff", "--cached") ?? "not empty")
    .toBe("");

  // Line selection is intentionally finer than a replacement pair. Staging
  // only the added row keeps the old row in the index; Git then reports that
  // old row as the remaining unstaged deletion.
  await window
    .locator(".diff-side")
    .getByRole("button", { name: "Unstaged", exact: true })
    .click();
  const addedFirst = window.locator(".diff-row--add", {
    hasText: "FIRST edit"
  });
  // Everything left of the code is the target, not the 13px box inside it.
  // The +/− column always carries a glyph, so it is a stable thing to aim at;
  // an added row's old-line gutter is empty and collapses to no height.
  await addedFirst.locator(".diff-sym").click();
  await expect(window.locator(".diff-selection-bar__count")).toHaveText(
    "1 selected"
  );
  await window
    .getByRole("button", { name: "Stage 1 line", exact: true })
    .click();
  await expect
    .poll(() => sandbox?.git(repo.path, "show", ":partial.txt") ?? "")
    .toContain("base-2\nFIRST edit");
  expect(sandbox.git(repo.path, "show", ":partial.txt")).not.toContain(
    "SECOND edit"
  );
});

test("Escape closes the diff pane only while the pane owns the keystroke", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("escrepo");
  writeFileSync(join(repo.path, "README.md"), "# escrepo\nbrand new line\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "escrepo");

  await expect(window.locator(".changes-wip")).toBeVisible({ timeout: 20_000 });
  const fileRow = window.locator(".file-row", { hasText: "README.md" });
  await fileRow.click();
  await expect(window.locator(".diff-pane")).toBeVisible({ timeout: 20_000 });

  // The row is a plain div, so the click alone would leave focus on <body>;
  // the pane takes it on open, and that is what makes the next Escape its own.
  await expect(window.locator(".diff-pane")).toBeFocused();

  // An overlay that has taken focus keeps its Escape: the repo switcher
  // closes, the pane underneath does not.
  await window.keyboard.press("Meta+k");
  await expect(window.locator(".overlay-panel")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.locator(".overlay-panel")).toBeHidden();
  await expect(window.locator(".diff-pane")).toBeVisible();

  // Clicking anywhere in the pane hands it focus again; then Escape closes it.
  await window.locator(".diff-pane__body").click();
  await expect(window.locator(".diff-pane")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.locator(".diff-pane")).toHaveCount(0);
  await expect(window.locator(".graph-toolbar")).toBeVisible();
});

test("clicking a commit scopes the rail to its files; a file opens its diff", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("commitscope");
  sandbox.commit(repo.path, "second.md", "add second doc");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "commitscope");

  // Click the commit in the lineage → the rail shows THAT commit's files,
  // not a full-pane laundry-list diff.
  await window.locator(".graph-row", { hasText: "add second doc" }).click();
  const commitTab = window.locator(".commit-tab");
  await expect(commitTab).toBeVisible({ timeout: 20_000 });
  // The focused commit is highlighted in the graph — even when it isn't HEAD.
  const focusedRow = window.locator(".graph-row.is-focused");
  await expect(focusedRow).toHaveCount(1);
  await expect(focusedRow).toContainText("add second doc");
  await expect(commitTab.locator(".commit-tab__subject")).toHaveText(
    "add second doc"
  );
  await expect(window.locator(".diff-pane")).toHaveCount(0);
  const fileRow = commitTab.locator(".file-row", { hasText: "second.md" });
  await expect(fileRow).toBeVisible();

  // Click the file → a diff scoped to that file within the commit.
  await fileRow.click();
  await expect(window.locator(".diff-pane")).toBeVisible();
  await expect(
    window.locator(".diff-row--add", { hasText: "add second doc" })
  ).toBeVisible();
  await expect(window.locator(".diff-pane__sub")).toContainText("in ");

  // Close → lineage; ‹ Changes → the working-tree view returns.
  await window.locator(".diff-pane__close").click();
  await expect(window.locator(".graph-toolbar")).toBeVisible();
  await commitTab.locator(".commit-tab__close").click();
  await expect(window.locator(".commit-tab")).toHaveCount(0);
  await expect(window.locator(".graph-row.is-focused")).toHaveCount(0);
  await expect(window.locator(".changes-clean")).toBeVisible();
});

test("file history follows a rename and opens each commit's change in place", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("lineagefile");
  mkdirSync(join(repo.path, "docs"), { recursive: true });
  sandbox.git(repo.path, "mv", "README.md", "docs/README.md");
  sandbox.git(repo.path, "commit", "-m", "move readme into docs");
  sandbox.commitAs(
    "historian@pwrgit.dev",
    repo.path,
    "docs/README.md",
    "explain file lineage"
  );
  // A current line gives working-tree blame an explicit WIP hunk while the
  // committed history remains anchored through HEAD.
  writeFileSync(
    join(repo.path, "docs", "README.md"),
    "explain file lineage\nuncommitted follow-up\n"
  );

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "lineagefile");

  const fileRow = window.locator(".file-row", { hasText: "docs/README.md" });
  await expect(fileRow).toBeVisible({ timeout: 20_000 });
  await fileRow.click();
  await expect(window.locator(".diff-pane")).toBeVisible();
  await window.getByRole("button", { name: "History" }).click();

  const history = window.getByTestId("file-history");
  await expect(history).toBeVisible({ timeout: 20_000 });
  await expect(history).toContainText("explain file lineage");
  await expect(history).toContainText("move readme into docs");
  await expect(history).toContainText("README.md → docs/README.md");

  // The row itself opens that commit's change to THIS file, in place — the
  // list stays mounted underneath, so Escape puts it straight back.
  await history
    .locator(".file-history__open", { hasText: "explain file lineage" })
    .click();
  const commitDiff = window.getByTestId("file-insight-diff");
  await expect(commitDiff).toBeVisible({ timeout: 20_000 });
  await expect(commitDiff).toContainText("explain file lineage");
  await window.keyboard.press("Escape");
  await expect(commitDiff).toHaveCount(0);
  await expect(history).toBeVisible();

  // Back to the diff the pane opened over: it renders UNDER file details
  // rather than being replaced, so nothing but un-hiding tells it that it is
  // on screen again — and Escape only works while focus is inside it.
  await window.locator(".file-insight-pane__back").click();
  await expect(window.locator(".file-insight-pane")).toHaveCount(0);
  await expect(window.locator(".diff-pane")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(window.locator(".diff-pane")).toHaveCount(0);
  await expect(window.locator(".graph-toolbar")).toBeVisible();

  // Re-open — this time through a gutter line number, which is the "I am
  // reading line 2, blame line 2" path: blame opens with that line marked.
  await fileRow.click();
  await expect(window.locator(".diff-pane")).toBeVisible();
  await window.locator('[title="Blame from line 2"]').click();
  const blame = window.getByTestId("file-blame");
  await expect(blame).toBeVisible({ timeout: 20_000 });
  await expect(blame.locator(".file-blame__row.is-target")).toContainText(
    "uncommitted follow-up"
  );
  await expect(blame).toContainText("WIP");
  await expect(blame).toContainText("uncommitted follow-up");
  // A gutter, so every line carries its own number and there is one scroller.
  await expect(blame.locator(".file-blame__number").nth(1)).toHaveText("2");
  await expect(blame.locator(".file-blame__lines")).toHaveCount(1);

  // The file ITSELF, not its changes — the third tab.
  await window.getByRole("tab", { name: "File" }).click();
  const contents = window.getByTestId("file-contents");
  await expect(contents).toBeVisible({ timeout: 20_000 });
  await expect(contents).toContainText("explain file lineage");
  await expect(contents).toContainText("uncommitted follow-up");

  // Revealing the commit in the lineage is now an explicit, secondary verb.
  await window.getByRole("tab", { name: "Blame" }).click();
  await expect(blame).toBeVisible();
  await blame.getByRole("button", { name: /Show commit .* in lineage/ }).click();
  await expect(window.locator(".graph-row.is-focused")).toContainText(
    "explain file lineage"
  );
});

test("the command palette opens history for a file with no pending change", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("palettefile");
  mkdirSync(join(repo.path, "docs"), { recursive: true });
  sandbox.commitAs(
    "historian@pwrgit.dev",
    repo.path,
    "docs/stable.md",
    "add the stable note"
  );

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "palettefile");
  // Nothing is uncommitted, so this file appears in no diff — before the
  // palette learned about files it could not be reached at all.
  await expect(window.locator(".changes-clean")).toBeVisible({ timeout: 20_000 });

  // The Windows shard runs this too, so use the host's own primary modifier.
  await window.keyboard.press(primaryShortcut("k"));
  await expect(window.locator(".overlay-panel")).toBeVisible();
  await window.keyboard.type("docs/stable.md");

  const fileHit = window.locator(".overlay-result", { hasText: "stable.md" });
  await expect(fileHit).toBeVisible({ timeout: 20_000 });
  await fileHit.click();

  const history = window.getByTestId("file-history");
  await expect(history).toBeVisible({ timeout: 20_000 });
  await expect(history).toContainText("add the stable note");
  // Opened without a diff behind it, so back goes to the lineage.
  await expect(window.locator(".file-insight-pane__back")).toHaveText("‹ Lineage");
  await window.keyboard.press("Escape");
  await expect(window.locator(".file-insight-pane")).toHaveCount(0);
  await expect(window.locator(".graph-toolbar")).toBeVisible();
});

test("a changed image renders both revisions instead of a binary notice", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("imagerepo");
  mkdirSync(join(repo.path, "art"), { recursive: true });
  writeFileSync(join(repo.path, "art", "dot.png"), PNG_RED_4x2);
  sandbox.git(repo.path, "add", "art/dot.png");
  sandbox.git(repo.path, "commit", "-m", "add dot");
  // Uncommitted replacement, a different size so the two sides are tellable
  // apart by what Chromium actually decoded.
  writeFileSync(join(repo.path, "art", "dot.png"), PNG_BLUE_8x6);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "imagerepo");

  const fileRow = window.locator(".file-row", { hasText: "dot.png" });
  await expect(fileRow).toBeVisible({ timeout: 20_000 });
  await fileRow.click();

  await expect(window.locator(".diff-pane")).toBeVisible({ timeout: 20_000 });
  await expect(window.locator(".diff-binary")).toHaveCount(0);

  const shown = window.locator(".diff-image__img");
  await expect(shown).toHaveCount(2);
  // naturalWidth is non-zero only once the bytes decoded as an image.
  await expect
    .poll(() =>
      shown.evaluateAll((nodes) =>
        nodes.map((n) => {
          const img = n as HTMLImageElement;
          return `${img.naturalWidth}x${img.naturalHeight}`;
        })
      )
    )
    .toEqual(["4x2", "8x6"]);
  await expect(window.locator(".diff-image__meta").first()).toContainText("4×2");
});

test("an untracked image previews the new file with no before side", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("newimagerepo");
  // Never added to the index — the "Binary files /dev/null and … differ"
  // patch the app synthesizes for untracked files. Kept beside the committed
  // README so `git status` lists the file rather than collapsing a new
  // directory into one untracked row.
  writeFileSync(join(repo.path, "fresh.png"), PNG_BLUE_8x6);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "newimagerepo");

  const fileRow = window.locator(".file-row", { hasText: "fresh.png" });
  await expect(fileRow).toBeVisible({ timeout: 20_000 });
  await fileRow.click();

  await expect(window.locator(".diff-pane")).toBeVisible({ timeout: 20_000 });
  await expect(window.locator(".diff-binary")).toHaveCount(0);
  await expect(window.locator(".diff-image__side")).toHaveCount(1);
  await expect(window.locator(".diff-image__label")).toHaveText("after");
  await expect.poll(() =>
    window
      .locator(".diff-image__img")
      .evaluate((n) => (n as HTMLImageElement).naturalWidth)
  ).toBe(8);
});
