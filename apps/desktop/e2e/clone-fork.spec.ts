import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ForgeKind } from "@pwrgit/shared";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import {
  createForgeFixture,
  type ForgeFixtureHandle
} from "./fixtures/forge-fixture";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { lensChip } from "./fixtures/steps";

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

async function addRoot(window: Page, app: AppHandle, box: GitSandbox) {
  await app.setPickDirectory(box.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await expect(window.locator(".clone-repo")).toBeEnabled();
  await expect(window.locator(".fork-repo")).toBeEnabled();
  await lensChip(window, "All").click();
}

async function recordProgress(
  window: Page,
  channel: "repo:cloneProgress" | "repo:forkProgress"
): Promise<void> {
  await window.evaluate((eventChannel) => {
    const target = window as unknown as {
      __transferProgress: { progress: { phase: string } }[];
      pwrgit: {
        on: (
          name: string,
          listener: (payload: { progress: { phase: string } }) => void
        ) => () => void;
      };
    };
    target.__transferProgress = [];
    target.pwrgit.on(eventChannel, (payload) => {
      target.__transferProgress.push(payload);
    });
  }, channel);
}

async function recordedPhases(window: Page): Promise<string[]> {
  return window.evaluate(() => {
    const target = window as unknown as {
      __transferProgress: { progress: { phase: string } }[];
    };
    return target.__transferProgress.map((event) => event.progress.phase);
  });
}

function repoBlock(window: Page, name: string) {
  return window.locator(".repo-block", {
    has: window.locator(".repo-row__name", { hasText: name })
  });
}

async function expectIndexedAndSelected(window: Page, name: string) {
  const block = repoBlock(window, name);
  await expect(block.locator(".repo-row__name")).toHaveText(name);
  await expect(block.locator(".wt-row.is-selected .wt-row__branch")).toHaveText(
    "main"
  );
}

async function chooseCloneSource(dialog: Locator, source: string) {
  await dialog.locator("#clone-source").fill(source);
  const row = dialog.locator(".clone-source-row", { hasText: source }).first();
  await expect(row).toBeVisible();
  await row.click();
}

async function chooseDestination(
  dialog: Locator,
  destination: string,
  kind: "clone" | "fork"
) {
  const input = dialog.locator(
    kind === "clone" ? "#clone-destination" : "#fork-destination"
  );
  await expect(input).toBeEnabled();
  // The row itself owns the title; using an attribute locator avoids path
  // labels whose root basename can be identical on different CI machines.
  const titled = dialog.getByTitle(destination, { exact: true });
  await expect(titled).toBeVisible();
  await titled.click();
}

test("local clone selects a nested destination, indexes and reveals it, and rejects a duplicate", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("services/existing");
  const source = sandbox.makeBareRemote("local-tool");
  const nestedDestination = join(sandbox.reposDir, "services");
  const checkout = join(nestedDestination, "local-tool");
  handle = await launchApp();
  const { window } = handle;
  await addRoot(window, handle, sandbox);
  await recordProgress(window, "repo:cloneProgress");

  await window.locator(".clone-repo").click();
  let dialog = window.getByRole("dialog", { name: "Clone a repository" });
  await chooseCloneSource(dialog, source);
  await chooseDestination(dialog, nestedDestination, "clone");
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog).toBeHidden();

  expect(existsSync(join(checkout, ".git"))).toBe(true);
  expect(
    sandbox.git(checkout, "remote", "get-url", "origin").replaceAll("\\", "/")
  ).toBe(source.replaceAll("\\", "/"));
  await expectIndexedAndSelected(window, "local-tool");
  expect(await recordedPhases(window)).toEqual(
    expect.arrayContaining(["starting", "indexing"])
  );

  // Repeating the exact destination is rejected before Git runs and leaves
  // the indexed checkout selected rather than creating a second row.
  await window.locator(".clone-repo").click();
  dialog = window.getByRole("dialog", { name: "Clone a repository" });
  await chooseCloneSource(dialog, source);
  await chooseDestination(dialog, nestedDestination, "clone");
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog.locator(".clone-submit-error")).toContainText(
    "already exists"
  );
  await expect(
    window.locator(".repo-row__name", { hasText: "local-tool" })
  ).toHaveCount(1);
});

test("clone uses the visibly selected default destination without a click", async () => {
  sandbox = createGitSandbox();
  const source = sandbox.makeBareRemote("default-destination");
  const checkout = join(sandbox.reposDir, "default-destination");
  handle = await launchApp();
  const { window } = handle;
  await addRoot(window, handle, sandbox);

  await window.locator(".clone-repo").click();
  const dialog = window.getByRole("dialog", { name: "Clone a repository" });
  await chooseCloneSource(dialog, source);

  const destination = dialog.getByTitle(sandbox.reposDir, { exact: true });
  await expect(destination).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator(".clone-destination-choice")).toHaveText(
    `Will create ${checkout}`
  );
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog).toBeHidden();

  expect(existsSync(join(checkout, ".git"))).toBe(true);
  await expectIndexedAndSelected(window, "default-destination");
});

for (const host of ["github", "gitlab"] as const) {
  test(`${host} fork creates the expected origin/upstream topology and metadata`, async () => {
    sandbox = createGitSandbox();
    const name = `${host}-fork-e2e`;
    const sourceSlug =
      host === "gitlab" ? `upstream/team/${name}` : `upstream/${name}`;
    const targetSlug = `tester/${name}`;
    const sourceRemote = sandbox.makeBareRemote(`${host}-source`);
    const forkRemote = sandbox.makeBareRemote(`${host}-target`);
    const other: ForgeKind = host === "github" ? "gitlab" : "github";
    const fixture = createForgeFixture(sandbox, {
      [host]: {
        installed: true,
        loggedIn: true,
        owners: [{ login: "tester", kind: "user" }],
        repositories: {
          [sourceSlug]: {
            remotePath: sourceRemote,
            visibility: "private",
            description: `${host} source fixture`
          }
        },
        forks: {
          [targetSlug]: {
            source: sourceSlug,
            remotePath: forkRemote,
            visibility: "private",
            parent: sourceSlug
          }
        }
      },
      [other]: {
        installed: false,
        loggedIn: false,
        owners: [],
        repositories: {}
      }
    });
    handle = await launchApp({ forgeFixturePath: fixture.path });
    const { window } = handle;
    await addRoot(window, handle, sandbox);
    await recordProgress(window, "repo:forkProgress");

    await window.locator(".fork-repo").click();
    const dialog = window.getByRole("dialog", { name: "Fork a repository" });
    await dialog.locator("#fork-source").fill(sourceSlug);
    const sourceRow = dialog
      .locator(".clone-source-row", { hasText: sourceSlug })
      .first();
    await expect(sourceRow).toBeVisible();
    await sourceRow.click();
    await expect(dialog.locator("#fork-name")).toHaveValue(name);
    await expect(
      dialog.getByRole("button", { name: "tester personal account", exact: true })
    ).toBeVisible();
    await dialog
      .locator(".clone-protocol", {
        hasText: host === "github" ? "GitHub CLI" : "GitLab CLI"
      })
      .click();
    if (host === "github") {
      await dialog.getByLabel("Copy the default branch only").check();
    }
    await chooseDestination(dialog, sandbox.reposDir, "fork");
    await dialog.locator(".clone-dialog__submit").click();
    await expect(dialog).toBeHidden();

    const checkout = join(sandbox.reposDir, name);
    expect(sandbox.git(checkout, "remote", "get-url", "origin")).toBe(
      `git@${host === "github" ? "github.com" : "gitlab.com"}:${targetSlug}.git`
    );
    expect(sandbox.git(checkout, "remote", "get-url", "upstream")).toBe(
      `git@${host === "github" ? "github.com" : "gitlab.com"}:${sourceSlug}.git`
    );
    await expectIndexedAndSelected(window, name);
    await expect(
      repoBlock(window, name).locator(`[title^="Fork of ${sourceSlug}"]`)
    ).toBeVisible();
    await expect(
      repoBlock(window, name).getByTitle(
        `private on ${host === "github" ? "github.com" : "gitlab.com"}`,
        { exact: true }
      )
    ).toBeVisible();
    expect(await recordedPhases(window)).toEqual(
      expect.arrayContaining([
        "starting",
        "creating",
        "awaiting_fork",
        "counting",
        "receiving",
        "adding_upstream",
        "indexing"
      ])
    );
    const forkCall = fixture
      .calls()
      .find((call) => call.host === host && call.operation === "fork");
    expect(forkCall?.input).toMatchObject({
      source: sourceSlug,
      targetOwner: "tester",
      targetName: name,
      defaultBranchOnly: host === "github"
    });
  });
}

function githubCloneFixture(
  box: GitSandbox,
  name: string
): { fixture: ForgeFixtureHandle; source: string } {
  const source = `upstream/${name}`;
  const fixture = createForgeFixture(box, {
    github: {
      installed: true,
      loggedIn: true,
      owners: [{ login: "tester", kind: "user" }],
      repositories: {
        [source]: {
          remotePath: box.makeBareRemote(name),
          description: "Hermetic GitHub repository"
        }
      }
    },
    gitlab: {
      installed: false,
      loggedIn: false,
      owners: [],
      repositories: {}
    }
  });
  return { fixture, source };
}

test("canceling a forge clone removes its partial checkout and can retry", async () => {
  sandbox = createGitSandbox();
  const name = "cancel-retry";
  const { fixture, source } = githubCloneFixture(sandbox, name);
  const github = fixture.config.hosts.github!;
  github.cloneDelayMs = 5_000;
  github.partialDuringClone = true;
  fixture.write();
  handle = await launchApp({ forgeFixturePath: fixture.path });
  const { window } = handle;
  await addRoot(window, handle, sandbox);

  await window.locator(".clone-repo").click();
  const dialog = window.getByRole("dialog", { name: "Clone a repository" });
  await chooseCloneSource(dialog, source);
  await dialog.locator(".clone-protocol", { hasText: "GitHub CLI" }).click();
  await chooseDestination(dialog, sandbox.reposDir, "clone");
  await dialog.locator(".clone-dialog__submit").click();
  await expect(
    dialog.getByRole("progressbar", { name: "Receiving objects" })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.locator(".clone-submit-error")).toContainText(
    "No partial checkout was kept"
  );
  await expect.poll(() => existsSync(join(sandbox!.reposDir, name))).toBe(false);

  github.cloneDelayMs = 0;
  github.partialDuringClone = false;
  fixture.write();
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog).toBeHidden();
  await expectIndexedAndSelected(window, name);
});

test("forge authentication and provider failures remain retryable", async () => {
  sandbox = createGitSandbox();
  const name = "failure-retry";
  const { fixture, source } = githubCloneFixture(sandbox, name);
  const github = fixture.config.hosts.github!;
  github.errors = {
    [`clone:${source}`]: {
      kind: "auth",
      message: "Fixture credentials expired. Sign in and try again."
    }
  };
  fixture.write();
  handle = await launchApp({ forgeFixturePath: fixture.path });
  const { window } = handle;
  await addRoot(window, handle, sandbox);

  await window.locator(".clone-repo").click();
  const dialog = window.getByRole("dialog", { name: "Clone a repository" });
  await chooseCloneSource(dialog, source);
  await dialog.locator(".clone-protocol", { hasText: "GitHub CLI" }).click();
  await chooseDestination(dialog, sandbox.reposDir, "clone");
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog.locator(".clone-submit-error")).toContainText(
    "credentials expired"
  );

  github.errors![`clone:${source}`] = {
    kind: "provider",
    message: "Fixture provider is temporarily unavailable."
  };
  fixture.write();
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog.locator(".clone-submit-error")).toContainText(
    "temporarily unavailable"
  );

  delete github.errors![`clone:${source}`];
  fixture.write();
  await dialog.locator(".clone-dialog__submit").click();
  await expect(dialog).toBeHidden();
  await expectIndexedAndSelected(window, name);
  expect(existsSync(join(sandbox.reposDir, name, ".git"))).toBe(true);
});
