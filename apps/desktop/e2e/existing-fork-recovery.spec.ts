import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createForgeFixture } from "./fixtures/forge-fixture";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;
test.afterEach(async () => {
  if (handle !== null) { await handle.cleanup(); handle = null; }
  sandbox?.cleanup(); sandbox = null;
});

test("existing fork remote rename preserves Pull recovery and repairs a denied Push", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const checkout = box.makeRepoWithRemote("widget");
  const parent = "team/widget";
  const fork = "tester/widget";
  box.git(checkout.path, "remote", "set-url", "origin", `git@github.com:${parent}.git`);
  box.git(checkout.path, "remote", "rename", "origin", "upstream");
  box.git(checkout.path, "remote", "add", "origin", `git@github.com:${fork}.git`);
  box.git(checkout.path, "update-ref", "refs/remotes/origin/main", "HEAD");
  box.git(checkout.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  // The checked-out branch must retain its literal name even when a tag collides.
  box.git(checkout.path, "tag", "main");
  writeFileSync(join(checkout.path, "local-edit.txt"), "keep this edit\n");
  const head = box.git(checkout.path, "rev-parse", "HEAD");
  expect(box.git(checkout.path, "rev-parse", "--abbrev-ref", "@{u}")).toBe("upstream/main");

  // A local SSH transport drives real Git's denial classifier and pack
  // protocol. It never opens a socket or accesses a real forge.
  const helper = join(dirname(box.reposDir), "fixture-ssh.cjs");
  const transports = join(dirname(box.reposDir), "fixture-transports.txt");
  writeFileSync(helper, `
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-G")) process.exit(1);
const command = args[args.length - 1] || "";
const push = command.startsWith("git-receive-pack");
const parent = command.includes("team/widget");
appendFileSync(${JSON.stringify(transports)}, (push ? "push " : "fetch ") + (parent ? "parent" : "fork") + "\\n");
if (push && parent) {
  process.stderr.write("ERROR: Permission to team/widget.git denied to tester.\\n");
  process.exit(1);
}
const result = spawnSync("git", [push ? "receive-pack" : "upload-pack", ${JSON.stringify(checkout.remotePath)}], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`);
  box.git(checkout.path, "config", "core.sshCommand", `"${process.execPath}" "${helper}"`);
  const fixture = createForgeFixture(box, { github: {
    installed: true, loggedIn: true, owners: [{ login: "tester", kind: "user" }],
    repositories: {
      [parent]: { remotePath: checkout.remotePath, visibility: "public" },
      [fork]: { remotePath: checkout.remotePath, visibility: "public", parent }
    }
  } });
  handle = await launchApp({ forgeFixturePath: fixture.path });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "widget");
  await window.locator(".wt-row").filter({ hasText: "main" }).first().click();
  const caret = window.locator(".wt-split__caret");
  await expect(caret).toBeEnabled();
  await caret.click();
  await expect(window.getByRole("menuitem", { name: /Track origin\/main/ })).toBeVisible();
  await window.locator(".pull-menu").screenshot({ path: testInfo.outputPath("pull-tracking-repair.png") });
  await window.keyboard.press("Escape");

  // Repair adds a menu, but plain Pull must still run with no source and no
  // incoming commits (the default sync preference used to swallow this click).
  await window.getByRole("button", { name: "Pull", exact: true }).click();
  await expect(window.locator(".sync-chip").first()).toContainText("fast-forwarded");
  expect(box.git(checkout.path, "rev-parse", "--abbrev-ref", "@{u}")).toBe("upstream/main");

  await window.getByRole("button", { name: "Push", exact: true }).click();
  const recovery = window.getByRole("dialog", { name: "Set up fork tracking" });
  await expect(recovery).toContainText("Use your existing fork");
  await expect(recovery).toContainText("Permission to team/widget.git denied");
  await recovery.screenshot({ path: testInfo.outputPath("denied-push-repair.png") });
  await recovery.getByRole("button", { name: "Track origin/main", exact: true }).click();
  await expect(recovery).toBeHidden();
  expect(box.git(checkout.path, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/main");
  expect(box.git(checkout.path, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(checkout.path, "local-edit.txt"), "utf8")).toBe("keep this edit\n");
  expect(readFileSync(transports, "utf8").split("\n").filter((line) => line === "push parent")).toHaveLength(1);
  expect(readFileSync(transports, "utf8")).not.toContain("push fork");
  expect(fixture.calls().some((call) => call.operation === "fork")).toBe(false);

  await caret.click();
  await expect(window.getByRole("menuitemradio", { name: /Sync with upstream\/main/ })).toBeVisible();
  await expect(window.getByRole("menuitemradio", { name: /Pull origin\/main only/ })).toBeVisible();
  await window.locator(".pull-menu").screenshot({ path: testInfo.outputPath("pull-fork-options.png") });
  await window.keyboard.press("Escape");
  await window.getByRole("button", { name: "Push", exact: true }).click();
  await expect.poll(() => readFileSync(transports, "utf8")).toContain("push fork");
  await expect(window.locator(".sync-chip").first()).toContainText("pushed");
});
