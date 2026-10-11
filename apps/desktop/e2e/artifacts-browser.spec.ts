import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createForgeFixture } from "./fixtures/forge-fixture";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";

let handle: AppHandle | null = null;
let sandbox: GitSandbox | null = null;
test.afterEach(async () => { await handle?.cleanup(); handle = null; sandbox?.cleanup(); sandbox = null; });

test("browse an Artifacts account and namespace, then select its exact HTTPS repository", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const accountId = "0123456789abcdef0123456789abcdef";
  const hostname = `${accountId}.artifacts.cloudflare.net`;
  const remote = `https://${hostname}/git/default/demo.git`;
  const repo = { id: "repo_fixture", name: "demo", description: "Contrived Artifacts repository", default_branch: "main", read_only: true, remote };
  const fixture = createForgeFixture(sandbox, { artifacts: { hostname, loggedIn: true, owners: [], repositories: { "default/demo": { remotePath: sandbox.makeBareRemote("demo"), visibility: "unknown" } } } });
  fixture.config.discoveredHosts = [{ kind: "artifacts", host: hostname, account: "Fixture account" }];
  fixture.config.wranglerResponses = {
    "--version": "fixture-wrangler",
    "whoami --json": { loggedIn: true, accounts: [{ id: accountId, name: "Fixture account" }] },
    "artifacts namespaces list --json": [{ namespace: "default" }],
    "artifacts repos list --namespace default --json": [repo],
    "artifacts repos get demo --namespace default --json": repo
  };
  fixture.write();
  handle = await launchApp({ forgeFixturePath: fixture.path });
  await handle.setPickDirectory(sandbox.reposDir);
  await handle.window.getByRole("button", { name: /Add folders/i }).click();
  await expect(handle.window.locator(".clone-repo")).toBeEnabled();
  await handle.window.locator(".clone-repo").click();
  const dialog = handle.window.getByRole("dialog", { name: "Clone a repository" });
  await dialog.getByRole("button", { name: "Browse Cloudflare repositories" }).click();
  await dialog.getByLabel("Cloudflare account", { exact: true }).selectOption(hostname);
  await dialog.getByLabel("Artifacts namespace", { exact: true }).selectOption("default");
  await expect(dialog.getByRole("option", { name: "default/demo · Read only" })).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath("artifacts-browser.png") });
  await dialog.getByRole("option", { name: "default/demo · Read only" }).click();
  await expect(dialog.locator("#clone-source")).toHaveValue(remote);
  expect(fixture.calls().filter((call) => call.operation === "wrangler" && Array.isArray(call.input.args) && call.input.args[0] === "artifacts").map((call) => call.input.accountId)).toEqual([accountId, accountId, accountId]);
  expect(fixture.calls().some((call) => call.operation === "fork")).toBe(false);
  // The transport suite exercises actual Git against a local HTTP fixture.
  // This UI fixture never clones or sends a request to a Cloudflare hostname.
});
