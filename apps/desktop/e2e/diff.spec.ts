import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

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
