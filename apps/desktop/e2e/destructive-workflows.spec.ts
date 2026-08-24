import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import {
  createGitSandbox,
  type GitSandbox,
  type RemoteTestRepo
} from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

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
    "PwrGit Test <test@pwrgit.dev>"
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
