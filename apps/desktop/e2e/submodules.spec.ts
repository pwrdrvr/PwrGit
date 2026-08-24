import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("shows the parent pin, live checkout, dirtiness, tag, branch hint, and URL end to end", async () => {
  sandbox = createGitSandbox();
  const child = sandbox.makeRepo("submodule-child");
  const parent = sandbox.makeRepo("submodule-parent");
  const pinned = sandbox.git(child.path, "rev-parse", "HEAD");
  sandbox.git(child.path, "tag", "v1.0.0", pinned);
  sandbox.commit(child.path, "next.txt", "newer child commit");
  const newer = sandbox.git(child.path, "rev-parse", "HEAD");

  sandbox.git(
    parent.path,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    "api",
    child.path,
    "modules/api"
  );
  sandbox.git(join(parent.path, "modules/api"), "checkout", "--detach", pinned);
  sandbox.git(
    parent.path,
    "config",
    "--file",
    ".gitmodules",
    "submodule.api.branch",
    "release/1"
  );
  sandbox.git(parent.path, "add", "-A");
  sandbox.git(parent.path, "commit", "-m", "pin api v1");
  sandbox.git(join(parent.path, "modules/api"), "checkout", "--detach", newer);
  writeFileSync(join(parent.path, "modules/api", "scratch.txt"), "dirty\n");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "submodule-parent");

  const panel = window.getByRole("region", { name: "Submodules" });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator(".submodule-panel__count")).toHaveText("1");
  const row = panel.locator(".submodule-row", { hasText: "modules/api" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Dirty");
  await expect(row).toContainText("Ahead of pin");
  await expect(row).toContainText("Parent pin");
  await expect(row).toContainText(pinned.slice(0, 8));
  await expect(row).toContainText(newer.slice(0, 8));
  await expect(row).toContainText("v1.0.0");
  await expect(row).toContainText("detached HEAD");
  await expect(row).toContainText("release/1");
  await expect(row).toContainText(child.path);
  await expect(panel).toContainText("Pins come from Git’s 160000 entries");

  // Refresh is deliberately read-only; the same parent pin and dirty child
  // remain visible after the second full main/preload/renderer round trip.
  await panel.getByRole("button", { name: "Refresh submodules" }).click();
  await expect(row).toContainText(pinned.slice(0, 8));
  await expect(row).toContainText("Dirty");
});
