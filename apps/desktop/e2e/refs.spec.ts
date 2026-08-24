import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

async function openBranchBrowser(
  window: AppHandle["window"],
  repoName: string
) {
  await window.getByRole("button", { name: /^Branches/ }).click();
  await window
    .getByRole("button", { name: /^View all \d+ branches…$/ })
    .click();
  return window.getByRole("dialog", {
    name: `${repoName} branches and remotes`
  });
}

function addRemoteOnlyBranch(
  box: GitSandbox,
  repo: ReturnType<GitSandbox["makeRepoBehindRemote"]>,
  branch = "releases/1.0"
): void {
  repo.createBranch(branch);
  box.git(repo.path, "push", "origin", branch);
  box.git(repo.path, "branch", "-D", branch);
}

/**
 * Push `count` remote-only branches in two git invocations rather than three
 * per branch — enough of them to exceed one page, without spending the whole
 * test budget on process spawns.
 */
function addManyRemoteOnlyBranches(
  box: GitSandbox,
  repo: ReturnType<GitSandbox["makeRepoBehindRemote"]>,
  count: number,
  prefix = "bulk"
): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}/branch-${String(index).padStart(3, "0")}`;
    names.push(name);
    repo.createBranch(name);
  }
  box.git(
    repo.path,
    "push",
    "origin",
    `refs/heads/${prefix}/*:refs/heads/${prefix}/*`
  );
  for (const name of names) box.git(repo.path, "branch", "-D", name);
  return names;
}

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

test("adds the first remote to a repository with no configured remotes", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("local-only");
  const remoteUrl = "https://example.com/local-only.git";

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "local-only");

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await expect(window.getByText("No remotes configured.")).toBeVisible();
  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();

  const browser = window.getByRole("dialog", {
    name: "local-only branches and remotes"
  });
  await browser.getByRole("button", { name: "Add remote…" }).click();
  const editor = window.getByRole("dialog", { name: "Add remote" });
  const fields = editor.locator(".refs-field input");
  await fields.nth(0).fill("origin");
  await fields.nth(1).fill(remoteUrl);
  await editor.getByRole("button", { name: "Add remote" }).click();

  await expect(
    browser.locator(".refs-remote-card", { hasText: "origin" })
  ).toBeVisible();
  await expect
    .poll(() => box.git(repo.path, "remote", "get-url", "origin"))
    .toBe(remoteUrl);
});

test("closes the repository refs browser with Escape", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  box.makeRepoBehindRemote("escape-refs");

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "escape-refs");

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();
  const browser = window.getByRole("dialog", {
    name: "escape-refs branches and remotes"
  });
  await expect(browser).toBeVisible();

  await window.keyboard.press("Escape");

  await expect(browser).toHaveCount(0);
});

test("includes fetched remote-only branches in the branches browser", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("remote-refs");
  addRemoteOnlyBranch(box, repo);

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "remote-refs");

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();
  const browser = window.getByRole("dialog", {
    name: "remote-refs branches and remotes"
  });
  await browser.getByRole("button", { name: /^Branches/ }).click();
  await browser.getByPlaceholder("Filter branches…").fill("releases/1.0");

  const release = browser.locator(".refs-table__row", {
    hasText: "releases/1.0"
  });
  await expect(release).toBeVisible();
  await expect(release).toContainText("origin/releases/1.0");
  await expect(release.getByRole("button", { name: "New worktree" })).toBeVisible();
});

test("finds fetched remote-only branches from the command palette", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("remote-search");
  for (let index = 0; index < 5; index += 1) {
    addRemoteOnlyBranch(
      box,
      repo,
      `releases/1.0-releases-1.0-noise-${index}`
    );
  }
  addRemoteOnlyBranch(box, repo);

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "remote-search");

  await window.keyboard.press("Meta+k");
  await window.locator(".overlay-search input").fill("releases/1.0");

  const release = window.locator(".overlay-result").first();
  await expect(release).toBeVisible();
  await expect(release.locator(".overlay-result__name")).toHaveText(
    "releases/1.0"
  );
  await expect(release).toContainText("remote-search");
  await release.click();
  const newWorktree = window.locator(".modal", {
    hasText: "New worktree · remote-search"
  });
  await expect(newWorktree.locator(".modal__input")).toHaveValue("releases/1.0");
  await expect(newWorktree).toContainText("Starting from refs/remotes/origin/releases/1.0");
});

test("narrowing remote branches across repos removes ghosts and keeps exact matches first", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  for (let index = 0; index < 4; index += 1) {
    const repo = box.makeRepoBehindRemote(`release-${index}`);
    addRemoteOnlyBranch(box, repo, "release");
  }
  for (let index = 0; index < 2; index += 1) {
    const repo = box.makeRepoBehindRemote(`exact-${index}`);
    addRemoteOnlyBranch(box, repo);
  }

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "exact-0");

  await window.keyboard.press("Meta+k");
  const input = window.locator(".overlay-search input");
  const rows = window.locator(".overlay-result");
  await input.fill("release");
  await expect.poll(async () => rows.count()).toBeGreaterThan(6);

  await input.fill("releases/1.0");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".overlay-result__name")).toHaveText(
    "releases/1.0"
  );
  await expect(window.locator(".overlay-foot")).toContainText("2 results");
});

test("browses local branches and nested remotes, then pushes to a test target", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("refsrepo");
  repo.createBranch("feat/local-only");
  const remoteUrl = box.git(repo.path, "remote", "get-url", "origin");
  box.git(repo.path, "remote", "add", "upstream", remoteUrl);
  box.git(repo.path, "remote", "add", "mac-tests", remoteUrl);
  box.git(repo.path, "fetch", "--all");

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "refsrepo");

  // The primary checkout remains visible above the collapsible linked-worktree
  // list, so a repo with only its primary has zero rows behind the disclosure.
  const worktrees = window.getByRole("button", { name: /^Worktrees 0/ });
  await expect(worktrees).toBeVisible();
  await expect(window.locator(".wt-tag--local")).toHaveText("primary");

  await window.getByRole("button", { name: /^Branches/ }).click();
  await expect(window.locator(".ref-branch-row", { hasText: "main" })).toBeVisible();
  await expect(
    window.locator(".ref-branch-row", { hasText: "feat/local-only" })
  ).toBeVisible();

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await expect(window.locator(".ref-remote__main", { hasText: "origin" })).toBeVisible();
  await expect(
    window.locator(".ref-remote__main", { hasText: "upstream" })
  ).toBeVisible();
  await expect(
    window.locator(".ref-remote__main", { hasText: "mac-tests" })
  ).toBeVisible();
  const compactOrigin = window.locator(".ref-remote", {
    has: window.locator(".ref-remote__main", { hasText: "origin" })
  });
  await compactOrigin.locator(".ref-remote__main").click();
  await expect(
    compactOrigin
      .locator(".ref-remote-branch-row", { hasText: "main" })
      .getByTitle("Show checked-out worktree")
  ).toHaveText("●");

  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();
  const browser = window.getByRole("dialog", {
    name: "refsrepo branches and remotes"
  });
  await expect(browser).toBeVisible();

  await browser.getByRole("button", { name: /^Branches/ }).click();
  await browser
    .getByRole("button", { name: "Copy branch name feat/local-only" })
    .click();
  await expect
    .poll(() => window.evaluate(() => navigator.clipboard.readText()))
    .toBe("feat/local-only");
  await browser.getByRole("button", { name: /^Remotes/ }).click();
  const originMain = browser
    .locator(".refs-remote-card", { hasText: "origin" })
    .locator(".refs-remote-branch", { hasText: "main" })
    .first();
  await expect(
    originMain.getByRole("button", { name: "Show worktree" })
  ).toBeVisible();
  await browser.getByRole("button", { name: "Push to remotes…" }).click();

  const push = window.getByRole("dialog", {
    name: "Push refsrepo branch to remotes"
  });
  await expect(push).toBeVisible();
  await push.getByRole("listbox", { name: "Source" })
    .selectOption("refs/heads/main");
  await push.locator(".refs-destination", { hasText: "mac-tests" }).click();
  await push.getByRole("textbox", { name: "Destination branch" })
    .fill("playwright/main");
  await push.getByRole("button", { name: "Review push" }).click();
  await expect(push.getByText("Will create")).toBeVisible({ timeout: 20_000 });
  await expect(push.getByText(/Push uses a lease/)).toBeVisible();
  await push
    .getByRole("button", { name: "Copy source branch main" })
    .click();
  await expect
    .poll(() => window.evaluate(() => navigator.clipboard.readText()))
    .toBe("main");
  await push.getByRole("button", { name: "Push to 1 remote" }).click();
  await expect(push.getByText("1 destination updated.")).toBeVisible({
    timeout: 20_000
  });

  await expect
    .poll(() =>
      box.git(repo.path, "ls-remote", "--heads", "origin", "refs/heads/playwright/main")
    )
    .not.toBe("");

  await push.getByRole("button", { name: "Close" }).click();
  await browser.getByRole("button", { name: "Push to remotes…" }).click();
  const equalPush = window.getByRole("dialog", {
    name: "Push refsrepo branch to remotes"
  });
  await equalPush.getByRole("listbox", { name: "Source" })
    .selectOption("refs/heads/main");
  await equalPush.locator(".refs-destination", { hasText: "mac-tests" }).click();
  await equalPush.getByRole("textbox", { name: "Destination branch" })
    .fill("playwright/main");
  await equalPush.getByRole("button", { name: "Review push" }).click();
  await expect(equalPush.getByText("Up to date")).toBeVisible({ timeout: 20_000 });
  await expect(
    equalPush.getByRole("button", { name: "Nothing to push" })
  ).toBeDisabled();
  await expect(
    equalPush.getByText("All selected destinations already match the source.")
  ).toBeVisible();
  await equalPush.getByRole("button", { name: "Cancel" }).click();

  await browser.getByRole("button", { name: "Add remote…" }).click();
  const editor = window.getByRole("dialog", { name: "Add remote" });
  const fields = editor.locator(".refs-field input");
  await fields.nth(0).fill("backup");
  await fields.nth(1).fill(remoteUrl);
  await editor.getByRole("button", { name: "Add remote" }).click();
  const backup = browser.locator(".refs-remote-card", { hasText: "backup" });
  await expect(backup).toBeVisible();

  await backup.getByRole("button", { name: "Remove" }).click();
  await window.getByRole("button", { name: "Remove remote" }).click();
  await expect(backup).toHaveCount(0);

  await browser.getByRole("button", { name: "Close" }).click();
  const localOnly = window.locator(".ref-branch-row", {
    hasText: "feat/local-only"
  });
  await localOnly.getByTitle("Create worktree").click();
  const newWorktree = window.locator(".modal", { hasText: "New worktree" });
  await newWorktree.getByRole("button", { name: "Create" }).click();
  // A local branch that now has a worktree swaps its "+" for a checkout chip
  // naming that worktree — the successor to the old "●" reveal button. (The
  // remote list above still uses the button; only local rows carry the pair.)
  await expect(localOnly.locator(".ref-checkout-chip")).toBeVisible({
    timeout: 20_000
  });
});

test("bounds the remote branch preview and pages the rest on demand", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("many-refs");
  // 60 bulk branches + main = 61 remote-tracking refs, so the sidebar preview
  // (6) and the first page (50) both fall short of the whole remote.
  addManyRemoteOnlyBranches(box, repo, 60);

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "many-refs");

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await window.getByRole("button", { name: /^origin/ }).click();

  // The disclosure renders a preview, not the remote: six rows and an honest
  // count, rather than 61 rows nobody asked for.
  await expect(window.locator(".ref-remote-branch-row")).toHaveCount(6);
  const viewAll = window.getByRole("button", {
    name: "View all 61 branches on origin…"
  });
  await expect(viewAll).toBeVisible();

  await viewAll.click();
  const browser = window.getByRole("dialog", {
    name: "many-refs branches and remotes"
  });
  const card = browser.locator(".refs-remote-card", { hasText: "origin" });
  await expect(card).toContainText("61 branches");

  // One page, and it says so rather than trailing off at 50 silently.
  const footer = card.locator(".refs-page-footer");
  await expect(footer).toContainText("Showing 50 of 61");
  await expect(card.locator(".refs-remote-branch")).toHaveCount(50);

  await footer.getByRole("button", { name: "Load more" }).click();
  await expect(footer).toContainText("Showing 61 of 61");
  await expect(card.locator(".refs-remote-branch")).toHaveCount(61);
  await expect(
    footer.getByRole("button", { name: "Load more" })
  ).toHaveCount(0);
});

test("filters remote branches in the main process rather than in the page", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("filter-refs");
  addManyRemoteOnlyBranches(box, repo, 60);
  addRemoteOnlyBranch(box, repo, "releases/1.0");

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "filter-refs");

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();
  const browser = window.getByRole("dialog", {
    name: "filter-refs branches and remotes"
  });
  const card = browser.locator(".refs-remote-card", { hasText: "origin" });
  await expect(card.locator(".refs-page-footer")).toContainText("Showing 50 of 62");

  // A filter narrows the whole remote, not just the rows already fetched —
  // branch-057 sorts well past the first page.
  await browser.getByPlaceholder("Filter remotes…").fill("branch-057");
  await expect(card.locator(".refs-remote-branch")).toHaveCount(1);
  await expect(card).toContainText("bulk/branch-057");

  await browser.getByPlaceholder("Filter remotes…").fill("releases/1.0");
  await expect(card.locator(".refs-remote-branch")).toHaveCount(1);
  await expect(card).toContainText("releases/1.0");

  await browser.getByPlaceholder("Filter remotes…").fill("no-such-branch");
  await expect(card.locator(".refs-remote-branch")).toHaveCount(0);
  await expect(card).toContainText("No fetched branches match this filter.");
});

test("the push source picker filters instead of listing every remote branch", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("push-picker");
  addManyRemoteOnlyBranches(box, repo, 60);

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "push-picker");

  await window.getByRole("button", { name: /^Remotes/ }).click();
  await window
    .getByRole("button", { name: "Manage remotes and remote branches…" })
    .click();
  const browser = window.getByRole("dialog", {
    name: "push-picker branches and remotes"
  });
  await browser.getByRole("button", { name: "Push to remotes…" }).click();

  const push = window.getByRole("dialog", {
    name: "Push push-picker branch to remotes"
  });
  const picker = push.locator(".branch-picker");
  // The source control is a page plus the local branches, never 61 options.
  await expect(picker.locator("option")).toHaveCount(51);
  await expect(picker.locator(".branch-picker__status")).toContainText(
    "Showing 51 of 62"
  );

  await picker.getByPlaceholder("Filter by name or commit subject").fill(
    "branch-042"
  );
  // Two options, not one: the match, plus the branch that was already selected.
  // A filter that silently dropped the selection would let a stray keystroke
  // repoint the push without the user seeing it change.
  await expect(picker.locator("option")).toHaveCount(2);
  await expect(picker.locator("option").nth(0)).toContainText("main");
  await expect(picker.locator("option").nth(0)).toContainText("(selected)");
  await expect(picker.locator("option").nth(1)).toContainText(
    "origin/bulk/branch-042"
  );
  // The pinned selection is not counted as a match.
  await expect(picker.locator(".branch-picker__status")).toContainText(
    "Showing 1 of 1"
  );
});

test("renames and normally deletes a free merged local branch", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("branch-lifecycle");
  repo.createBranch("feature/old-name");

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "branch-lifecycle");
  const browser = await openBranchBrowser(window, "branch-lifecycle");

  // Main is current, so renderer affordances agree with main's live guard.
  const main = browser.locator(".refs-table__row", {
    has: window.getByRole("button", { name: "Copy branch name main" })
  });
  await expect(
    main.getByRole("button", { name: "Rename local branch main" })
  ).toBeDisabled();
  await expect(
    main.getByRole("button", { name: "Delete local branch main" })
  ).toBeDisabled();

  const old = browser.locator(".refs-table__row", {
    has: window.getByRole("button", {
      name: "Copy branch name feature/old-name"
    })
  });
  await old
    .getByRole("button", { name: "Rename local branch feature/old-name" })
    .click();
  const rename = window.getByRole("dialog", {
    name: "Rename branch feature/old-name"
  });
  await rename.getByRole("textbox", { name: "New branch name" }).fill(
    "feature/new-name"
  );
  await rename.getByRole("button", { name: "Rename branch" }).click();

  const renamed = browser.locator(".refs-table__row", {
    has: window.getByRole("button", {
      name: "Copy branch name feature/new-name"
    })
  });
  await expect(renamed).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() =>
      box.git(
        repo.path,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads"
      )
    )
    .toContain("feature/new-name");

  await renamed
    .getByRole("button", { name: "Delete local branch feature/new-name" })
    .click();
  await window.getByRole("button", { name: "Delete branch" }).click();

  await expect(renamed).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(() =>
      box.git(
        repo.path,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads"
      )
    )
    .not.toContain("feature/new-name");
});

test("force deletion requires a second confirmation and leaves the remote branch", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("force-branch-delete");
  const worktree = repo.addWorktree("feature/unique");
  box.commit(worktree, "unique.txt", "unique branch work");
  box.git(worktree, "push", "origin", "feature/unique");
  box.git(repo.path, "worktree", "remove", worktree);

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "force-branch-delete");
  const browser = await openBranchBrowser(window, "force-branch-delete");
  await browser.getByPlaceholder("Filter branches…").fill("feature/unique");
  const local = browser.locator(".refs-table__row", {
    has: window.getByRole("button", {
      name: "Copy branch name feature/unique"
    })
  });
  const remove = local.getByRole("button", {
    name: "Delete local branch feature/unique"
  });

  await remove.click();
  await window.getByRole("button", { name: "Delete branch" }).click();
  const forceDialog = window.getByRole("alertdialog", {
    name: "Force delete feature/unique?"
  });
  await expect(forceDialog).toContainText("No remote branch is changed");
  await forceDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(local).toBeVisible();

  await remove.click();
  await window.getByRole("button", { name: "Delete branch" }).click();
  await window.getByRole("button", { name: "Force delete branch" }).click();

  await expect
    .poll(() =>
      box.git(
        repo.path,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads"
      )
    )
    .not.toContain("feature/unique");
  await expect
    .poll(() =>
      box.git(
        repo.path,
        "ls-remote",
        "--heads",
        "origin",
        "refs/heads/feature/unique"
      )
    )
    .not.toBe("");

  // Once the local row disappears, the fetched remote row remains and offers
  // worktree creation only — there is no remote-delete action hidden here.
  const remote = browser.locator(".refs-table__row", {
    hasText: "origin/feature/unique"
  });
  await expect(remote.getByRole("button", { name: "New worktree" })).toBeVisible({
    timeout: 20_000
  });
  await expect(
    remote.getByRole("button", { name: /Delete local branch/ })
  ).toHaveCount(0);
});
