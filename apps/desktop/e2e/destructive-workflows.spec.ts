import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import {
  createGitSandbox,
  type GitSandbox,
  type RemoteTestRepo,
  type TestRepo
} from "./fixtures/git-sandbox";
import { addRootAndExpand, lensChip, repoGroup } from "./fixtures/steps";

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

type SourceSnapshot = {
  branch: string;
  head: string;
  history: string;
  refs: string;
  status: string;
  tree: string;
  contents: string | null;
  cherryPickInProgress: boolean;
};

function sourceSnapshot(box: GitSandbox, repo: RemoteTestRepo): SourceSnapshot {
  const cherryPickPath = box.git(
    repo.path,
    "rev-parse",
    "--git-path",
    "CHERRY_PICK_HEAD"
  );
  return {
    branch: box.git(repo.path, "symbolic-ref", "HEAD"),
    head: box.git(repo.path, "rev-parse", "HEAD"),
    history: box.git(repo.path, "log", "--format=%H%x1f%s"),
    refs: box.git(
      repo.path,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes"
    ),
    status: box.git(repo.path, "status", "--porcelain=v1"),
    tree: box.git(repo.path, "rev-parse", "HEAD^{tree}"),
    contents: existsSync(join(repo.path, "shared.txt"))
      ? readFileSync(join(repo.path, "shared.txt"), "utf8")
      : null,
    cherryPickInProgress: existsSync(
      isAbsolute(cherryPickPath)
        ? cherryPickPath
        : join(repo.path, cherryPickPath)
    )
  };
}

function remoteHead(box: GitSandbox, repo: RemoteTestRepo): string {
  return box.git(repo.remotePath, "rev-parse", "refs/heads/main");
}

async function selectCommit(window: Page, subject: string): Promise<void> {
  const row = window.locator(".graph-row", { hasText: subject });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("checkbox").click();
}

async function openReorderPlan(
  window: Page,
  newest: string,
  older: string
): Promise<void> {
  await selectCommit(window, newest);
  await selectCommit(window, older);
  await expect(window.locator(".selection-bar__count")).toHaveText(
    "2 commits selected"
  );
  await window.getByRole("button", { name: "Reorder", exact: true }).click();
  await expect(window.locator(".rebase-section").first()).toHaveText(
    "Reorder · 2 commits"
  );
}

test("normal commit and amend refresh the graph, preserve objects, and never push", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoWithRemote("commit-history");
  const upstreamBefore = remoteHead(box, repo);

  writeFileSync(join(repo.path, "normal.txt"), "created in the normal commit\n");
  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, repo.name);

  await window
    .getByRole("button", { name: "Stage normal.txt", exact: true })
    .click();
  await expect(
    window.locator(".file-row.is-staged", { hasText: "normal.txt" })
  ).toBeVisible({ timeout: 20_000 });
  await window.getByPlaceholder("Summary").fill("feat: durable normal commit");
  await window
    .getByRole("button", { name: "Commit 1 file", exact: true })
    .click();

  await expect(window.locator(".changes-clean")).toBeVisible({
    timeout: 20_000
  });
  await expect(
    window.locator(".graph-row", { hasText: "feat: durable normal commit" })
  ).toBeVisible({ timeout: 20_000 });
  const normalHead = box.git(repo.path, "rev-parse", "HEAD");
  expect(box.git(repo.path, "log", "-1", "--format=%s")).toBe(
    "feat: durable normal commit"
  );
  expect(box.git(repo.path, "status", "--porcelain=v1")).toBe("");
  expect(box.git(repo.path, "log", "-1", "--format=%an <%ae>")).toBe(
    "PwrGit Test <test@pwrgit.com>"
  );
  expect(remoteHead(box, repo)).toBe(upstreamBefore);

  writeFileSync(join(repo.path, "amended.txt"), "added by amend\n");
  await window
    .getByRole("button", { name: `Refresh worktrees for ${repo.name}` })
    .click();
  await expect(
    window.getByRole("button", { name: "Stage amended.txt", exact: true })
  ).toBeVisible({ timeout: 20_000 });
  await window
    .getByRole("button", { name: "Stage amended.txt", exact: true })
    .click();
  await expect(
    window.locator(".file-row.is-staged", { hasText: "amended.txt" })
  ).toBeVisible({ timeout: 20_000 });
  await window.getByPlaceholder("Summary").fill("feat: amended final commit");
  await window.getByRole("button", { name: "Amend", exact: true }).click();

  await expect(window.locator(".changes-clean")).toBeVisible({
    timeout: 20_000
  });
  await expect(
    window.locator(".graph-row", { hasText: "feat: amended final commit" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    window.locator(".graph-row", { hasText: "feat: durable normal commit" })
  ).toHaveCount(0);

  const amendedHead = box.git(repo.path, "rev-parse", "HEAD");
  expect(amendedHead).not.toBe(normalHead);
  expect(box.git(repo.path, "cat-file", "-t", normalHead)).toBe("commit");
  expect(box.git(repo.path, "rev-list", "--count", "HEAD")).toBe("2");
  expect(box.git(repo.path, "rev-parse", "HEAD^")).toBe(upstreamBefore);
  expect(box.git(repo.path, "ls-tree", "--name-only", "HEAD").split("\n"))
    .toEqual(expect.arrayContaining(["amended.txt", "normal.txt"]));
  expect(box.git(repo.path, "status", "--porcelain=v1")).toBe("");
  expect(remoteHead(box, repo)).toBe(upstreamBefore);
});

test("rebase Apply stays approval-gated, then rewrites locally and refreshes the graph", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoWithRemote("approved-rebase");
  const upstreamBefore = remoteHead(box, repo);
  box.commit(repo.path, "one.txt", "rebase older commit");
  box.commit(repo.path, "two.txt", "rebase newest commit");
  const before = sourceSnapshot(box, repo);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, repo.name);
  await openReorderPlan(
    window,
    "rebase newest commit",
    "rebase older commit"
  );

  const apply = window.getByRole("button", {
    name: "Apply rebase",
    exact: true
  });
  await expect(apply).toBeDisabled();
  await window
    .getByRole("button", { name: "Check in isolated copy", exact: true })
    .click();
  await expect(window.locator(".rebase-check-result--clean")).toContainText(
    "Clean"
  );
  await expect(apply).toBeEnabled();

  expect(box.git(repo.path, "rev-parse", "HEAD")).toBe(before.head);
  expect(box.git(repo.path, "log", "--format=%H%x1f%s")).toBe(before.history);
  expect(box.git(repo.path, "status", "--porcelain=v1")).toBe("");
  expect(remoteHead(box, repo)).toBe(upstreamBefore);

  await apply.click();
  await expect(
    window.locator(".graph-row").first()
  ).toContainText("rebase older commit", { timeout: 20_000 });

  expect(box.git(repo.path, "rev-parse", "HEAD")).not.toBe(before.head);
  expect(box.git(repo.path, "rev-parse", "HEAD^{tree}")).toBe(before.tree);
  expect(
    box.git(repo.path, "log", "-2", "--format=%s").split("\n")
  ).toEqual(["rebase older commit", "rebase newest commit"]);
  expect(box.git(repo.path, "rev-list", "--count", "HEAD")).toBe("3");
  expect(box.git(repo.path, "status", "--porcelain=v1")).toBe("");
  expect(remoteHead(box, repo)).toBe(upstreamBefore);

  await window.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(window.locator(".changes-clean")).toBeVisible();
});

test("a source-only Apply conflict aborts and restores the approved checkout exactly", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoWithApplyOnlyRebaseFailure("restored-rebase");
  const upstreamBefore = remoteHead(box, repo);
  const before = sourceSnapshot(box, repo);
  expect(before.status).toBe("");
  expect(before.cherryPickInProgress).toBe(false);

  handle = await launchApp({
    gitConfig:
      '[merge "reject"]\n\tname = Normal text merge in isolated copies\n\tdriver = git merge-file %A %O %B\n'
  });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, repo.name);
  await openReorderPlan(
    window,
    "change second setting",
    "change first setting"
  );

  const apply = window.getByRole("button", {
    name: "Apply rebase",
    exact: true
  });
  await expect(apply).toBeDisabled();
  await window
    .getByRole("button", { name: "Check in isolated copy", exact: true })
    .click();
  await expect(window.locator(".rebase-check-result--clean")).toContainText(
    "Clean"
  );
  await expect(apply).toBeEnabled();
  expect(sourceSnapshot(box, repo)).toEqual(before);

  await apply.click();
  const snag = window.locator(".rebase-check-result--snag");
  await expect(snag).toContainText("Reorder hit a conflict");
  await expect(snag).toContainText("restored unchanged");
  await expect(apply).toBeDisabled();

  expect(sourceSnapshot(box, repo)).toEqual(before);
  expect(remoteHead(box, repo)).toBe(upstreamBefore);
  await expect(
    window.locator(".graph-row").first()
  ).toContainText("change second setting");
  await window.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(window.locator(".changes-clean")).toBeVisible();
});

/**
 * A repo with one genuinely finished worktree: its branch is merged into main,
 * its last commit is months old, and it holds both regenerable bulk
 * (`node_modules`) and an unrecoverable local file (`.env`).
 *
 * Deliberately set up WITHOUT expanding the repo in the sidebar, because that
 * is the case the pruner exists for: per-worktree Git state is computed lazily
 * on expand, so until something computes it the Stale lens is empty and there
 * is nothing to prune from.
 */
function makeFinishedWorktree(
  box: GitSandbox,
  name: string
): { repo: TestRepo; worktreePath: string } {
  const repo = box.makeRepo(name);
  writeFileSync(join(repo.path, ".gitignore"), "node_modules/\n.env\n");
  box.git(repo.path, "add", ".gitignore");
  box.git(repo.path, "commit", "-m", "ignore build output");

  const worktreePath = repo.addWorktree("feat/finished");
  // Months old: the staleness rule reads the branch tip's committer date.
  box.commitEmptyAt(worktreePath, "finished work", 1_735_689_600);
  box.git(repo.path, "merge", "--no-ff", "-m", "merge feat/finished", "feat/finished");

  mkdirSync(join(worktreePath, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(
    join(worktreePath, "node_modules", "left-pad", "index.js"),
    "x".repeat(4096)
  );
  writeFileSync(join(worktreePath, ".env"), "SECRET=hunter2\n");
  return { repo, worktreePath };
}

/** Add the sandbox as a repo folder and switch to All — WITHOUT expanding any
 *  repo, so no worktree Git state is computed. */
async function addRootUnexpanded(
  window: Page,
  app: AppHandle,
  box: GitSandbox
): Promise<void> {
  await app.setPickDirectory(box.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
}

const confirmDialogButton = (window: Page): Locator =>
  window.locator(".modal--dialog .modal__create");

test("the pruner sweeps a never-browsed profile, then reclaims only ignored files", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const { repo, worktreePath } = makeFinishedWorktree(box, "prune-reclaim");

  handle = await launchApp();
  const { window } = handle;
  await addRootUnexpanded(window, handle, box);
  await expect(repoGroup(window, repo.name)).toBeVisible({ timeout: 20_000 });

  // The premise: nothing has computed Git state, so the lens has no answer.
  await expect(lensChip(window, "Stale")).toHaveAttribute("aria-label", "Stale");

  await window.getByRole("button", { name: /Prune worktrees/ }).click();
  const dialog = window.getByRole("dialog", { name: "Prune worktrees" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  const row = dialog.locator(".prune__row");
  await expect(row).toHaveCount(1, { timeout: 40_000 });
  await expect(row).toContainText("feat/finished");
  await expect(row.locator(".prune__reason")).toHaveText("merged into main");

  // The sweep's states are cached, so the lens it could not answer now can.
  await expect(lensChip(window, "Stale")).toHaveAttribute(
    "aria-label",
    "Stale (1)"
  );

  await dialog.locator(".prune__select input").click();
  await dialog.getByRole("button", { name: /Reclaim disk space/ }).click();

  const plan = dialog.locator(".prune__plan");
  await expect(plan).toHaveCount(1, { timeout: 40_000 });
  await expect(plan.locator(".prune__paths li > span")).toHaveText([
    "node_modules/"
  ]);
  // The whole safety claim of this action, visible in the preview: a spared
  // `.env` is never offered for deletion.
  await expect(plan).not.toContainText(".env");

  await dialog.getByRole("button", { name: /Delete ignored files/ }).click();
  await expect(confirmDialogButton(window)).toBeVisible({ timeout: 20_000 });
  await expect(window.locator(".dialog__message")).toContainText(
    "cannot be undone"
  );
  await confirmDialogButton(window).click();

  await expect(dialog.locator(".prune__summary")).toContainText("1 reclaimed", {
    timeout: 40_000
  });

  // Ignored bulk gone; everything that has no commit behind it kept; the
  // worktree still a worktree.
  expect(existsSync(join(worktreePath, "node_modules"))).toBe(false);
  expect(existsSync(join(worktreePath, ".env"))).toBe(true);
  expect(existsSync(join(worktreePath, ".git"))).toBe(true);
  expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  expect(box.git(worktreePath, "status", "--porcelain=v1")).toBe("");
  expect(box.git(worktreePath, "log", "-1", "--format=%s")).toBe(
    "finished work"
  );
});

test("removing from the pruner confirms the count, deletes the checkout, and keeps the commits", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const { repo, worktreePath } = makeFinishedWorktree(box, "prune-remove");
  const branchTip = box.git(repo.path, "rev-parse", "refs/heads/feat/finished");

  handle = await launchApp();
  const { window } = handle;
  await addRootUnexpanded(window, handle, box);
  await expect(repoGroup(window, repo.name)).toBeVisible({ timeout: 20_000 });

  await window.getByRole("button", { name: /Prune worktrees/ }).click();
  const dialog = window.getByRole("dialog", { name: "Prune worktrees" });
  await expect(dialog.locator(".prune__row")).toHaveCount(1, {
    timeout: 40_000
  });

  // Nothing is selected when the sweep lands: this dialog's output is a list
  // of things it believes are safe to delete, and pre-ticking them would make
  // it a dialog that deletes by default.
  await expect(dialog.locator(".prune__row input:checked")).toHaveCount(0);
  const remove = dialog.getByRole("button", { name: /Remove .*worktree/ });
  await expect(remove).toBeDisabled();

  await dialog.locator(".prune__row input").click();
  await expect(remove).toBeEnabled();
  await remove.click();

  await expect(confirmDialogButton(window)).toHaveText("Remove 1");
  await expect(window.locator(".dialog__message")).toContainText(
    "every commit is already in main"
  );
  await expect(window.locator(".dialog__message")).toContainText(
    "Branches and commits are kept."
  );
  await confirmDialogButton(window).click();

  await expect(dialog.locator(".prune__row")).toHaveCount(0, {
    timeout: 40_000
  });
  // An emptied list must report the removal, not explain why nothing
  // qualified: the two states look identical and the explanation reads as
  // "nothing happened" directly after the directory was deleted.
  const empty = dialog.locator(".prune__empty");
  await expect(empty).toContainText("Removed 1 worktree");
  await expect(empty).not.toContainText("Nothing is safe to remove");
  await expect(dialog.locator(".prune__count")).toHaveText("1 removed");
  expect(existsSync(worktreePath)).toBe(false);
  // The branch and its commit survive — that is what "remove the worktree"
  // has to mean, or the confirm above is a lie.
  expect(box.git(repo.path, "rev-parse", "refs/heads/feat/finished")).toBe(
    branchTip
  );
  expect(box.git(repo.path, "cat-file", "-t", branchTip)).toBe("commit");
  expect(box.git(repo.path, "worktree", "list")).not.toContain(worktreePath);
});

test("the pruner never offers a dirty or unmerged worktree", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const { repo } = makeFinishedWorktree(box, "prune-guards");
  // Merged and old, but with uncommitted work in the checkout.
  const dirty = repo.addWorktree("feat/dirty");
  box.commitEmptyAt(dirty, "dirty work", 1_735_689_600);
  box.git(repo.path, "merge", "--no-ff", "-m", "merge feat/dirty", "feat/dirty");
  writeFileSync(join(dirty, "uncommitted.txt"), "work in progress\n");
  // Clean and old, but never merged anywhere.
  const open = repo.addWorktree("feat/open");
  box.commitEmptyAt(open, "open work", 1_735_689_600);
  // Merged, old and clean — but locked, which is git's explicit "do not touch
  // this". Removing one needs --force, which the bulk remove only offers for
  // the dirty set behind its own prompt, so offering it would promise a
  // removal that then fails.
  const held = repo.addWorktree("feat/held");
  box.commitEmptyAt(held, "held work", 1_735_689_600);
  box.git(repo.path, "merge", "--no-ff", "-m", "merge feat/held", "feat/held");
  box.git(repo.path, "worktree", "lock", held);

  handle = await launchApp();
  const { window } = handle;
  await addRootUnexpanded(window, handle, box);
  await expect(repoGroup(window, repo.name)).toBeVisible({ timeout: 20_000 });

  await window.getByRole("button", { name: /Prune worktrees/ }).click();
  const dialog = window.getByRole("dialog", { name: "Prune worktrees" });
  await expect(dialog.locator(".prune__row")).toHaveCount(1, {
    timeout: 40_000
  });
  await expect(dialog.locator(".prune__row")).toContainText("feat/finished");
  await expect(dialog.locator(".prune__rows")).not.toContainText("feat/dirty");
  await expect(dialog.locator(".prune__rows")).not.toContainText("feat/open");
  await expect(dialog.locator(".prune__rows")).not.toContainText("feat/held");
});
