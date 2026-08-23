import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
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

test("browses, creates, deletes, and explicitly reviews remote tag actions", async () => {
  test.setTimeout(90_000);
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("tag-refs");
  const target = box.git(repo.path, "rev-parse", "HEAD");
  box.git(repo.path, "tag", "v1.0-light", target);
  box.git(
    repo.path,
    "tag",
    "--annotate",
    "--message",
    "Release 1.0\n\nVerified annotation metadata",
    "v1.0",
    target
  );
  for (let index = 0; index < 60; index += 1) {
    box.git(
      repo.path,
      "tag",
      `archive/build-${String(index).padStart(3, "0")}`,
      target
    );
  }

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "tag-refs");

  const tagsToggle = window.getByRole("button", { name: /^Tags 62/ });
  await tagsToggle.click();
  await expect(window.locator(".ref-tag-row")).toHaveCount(6);
  const viewAll = window.getByRole("button", { name: "View all 62 tags…" });
  await viewAll.click();

  const browser = window.getByRole("dialog", {
    name: "tag-refs branches and remotes"
  });
  await expect(browser.getByRole("button", { name: /^Tags 62/ })).toHaveClass(
    /is-active/
  );
  await expect(browser.locator(".refs-page-footer")).toContainText(
    "Showing 50 of 62"
  );
  await expect(browser.locator(".refs-tag-table .refs-table__row")).toHaveCount(
    50
  );

  const filter = browser.getByPlaceholder("Filter tags…");
  await filter.fill("v1.0");
  await expect(browser.locator(".refs-tag-table .refs-table__row")).toHaveCount(2);
  const annotated = browser.locator(".refs-tag-table .refs-table__row", {
    hasText: "v1.0"
  }).filter({ hasText: "annotated" });
  await expect(annotated).toContainText("tag");
  await expect(annotated).toContainText("commit");
  await expect(annotated).toContainText("Release 1.0");
  await expect(annotated).toContainText("PwrGit Test");
  await expect(annotated.getByRole("button", { name: "New worktree" })).toHaveCount(
    0
  );

  // Search runs over every local tag, not just the first 50 delivered.
  await filter.fill("build-059");
  await expect(browser.locator(".refs-tag-table .refs-table__row")).toHaveCount(1);
  await expect(browser).toContainText("archive/build-059");

  await filter.fill("");
  await browser.getByRole("button", { name: "Create tag…" }).click();
  const create = window.getByRole("dialog", { name: "Create tag in tag-refs" });
  await create.getByRole("textbox", { name: "Tag name" }).fill("candidate/2.0");
  await create.getByRole("textbox", { name: "Target commit" }).fill(target);
  await create.getByRole("combobox", { name: "Tag kind" }).selectOption(
    "annotated"
  );
  await create
    .getByRole("textbox", { name: "Annotation" })
    .fill("Candidate 2.0\n\nReviewed in Playwright");
  await create.getByRole("button", { name: "Create tag" }).click();
  await expect(create).toHaveCount(0);
  expect(box.git(repo.path, "cat-file", "-t", "refs/tags/candidate/2.0")).toBe(
    "tag"
  );
  expect(
    box.git(repo.path, "rev-parse", "refs/tags/candidate/2.0^{}")
  ).toBe(target);

  await filter.fill("candidate/2.0");
  const candidate = browser.locator(".refs-tag-table .refs-table__row", {
    hasText: "candidate/2.0"
  });
  await expect(candidate).toBeVisible();
  await candidate.getByRole("button", { name: "Remote…" }).click();
  let remote = window.getByRole("dialog", {
    name: "Manage remote tag candidate/2.0"
  });
  await remote.getByRole("button", { name: "Review action" }).click();
  await expect(remote).toContainText("requires it to remain absent", {
    timeout: 20_000
  });
  await remote.getByRole("button", { name: "Push tag" }).click();
  await expect(remote).toContainText("pushed", { timeout: 20_000 });
  await expect
    .poll(() =>
      box.git(
        repo.path,
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/candidate/2.0"
      )
    )
    .not.toBe("");
  await remote.getByRole("button", { name: "Close" }).click();

  // Remote deletion is not coupled to local deletion: it gets its own fresh
  // remote-object review and exact leased confirmation.
  await candidate.getByRole("button", { name: "Remote…" }).click();
  remote = window.getByRole("dialog", {
    name: "Manage remote tag candidate/2.0"
  });
  await remote
    .getByRole("combobox", { name: "Remote tag action" })
    .selectOption("delete");
  await remote.getByRole("button", { name: "Review action" }).click();
  await expect(remote).toContainText("remain exactly the object shown", {
    timeout: 20_000
  });
  await remote.getByRole("button", { name: "Delete remote tag" }).click();
  await expect(remote).toContainText("deleted", { timeout: 20_000 });
  await expect
    .poll(() =>
      box.git(
        repo.path,
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/candidate/2.0"
      )
    )
    .toBe("");
  await remote.getByRole("button", { name: "Close" }).click();

  await candidate.getByRole("button", { name: "Delete local" }).click();
  await window.getByRole("button", { name: "Delete local tag" }).click();
  await expect(candidate).toHaveCount(0);
  expect(box.git(repo.path, "tag", "--list", "candidate/2.0")).toBe("");
});
