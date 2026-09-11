import { createServer, type Server, type Socket } from "node:net";
import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand } from "./fixtures/steps";

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;
let silentRemote: Server | null = null;
let held: Socket[] = [];

/**
 * A `git://` endpoint that accepts the connection and then says nothing.
 *
 * This is the failure the status surfaces exist for, reproduced exactly: TCP
 * succeeds, Git sends its request, and no byte ever comes back. `git fetch`
 * waits indefinitely and — because it never reaches the transfer — prints not
 * one line of `--progress` output. To the old UI that was a spinner; there was
 * no way to tell it apart from a large, healthy clone.
 *
 * A real network hang would be slower and far less reliable than this; an
 * upload-pack wrapper script would not run on the Windows E2E job.
 */
async function startSilentRemote(): Promise<number> {
  const server = createServer((socket) => {
    held.push(socket);
    socket.on("error", () => undefined);
  });
  silentRemote = server;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("silent remote did not bind a TCP port");
  }
  return address.port;
}

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  for (const socket of held) socket.destroy();
  held = [];
  silentRemote?.close();
  silentRemote = null;
  sandbox?.cleanup();
  sandbox = null;
});

test("a pull that gets no answer says so, shows Git's command, and cancels", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("svc", { behindBy: 1 });
  const port = await startSilentRemote();
  box.git(repo.path, "remote", "set-url", "origin", `git://127.0.0.1:${port}/svc.git`);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "svc");

  const pull = window.getByRole("button", { name: /^Pull/ });
  await expect(pull).toBeVisible({ timeout: 20_000 });
  await pull.click();

  // Phase first: the toolbar has to stop saying "Pull" and start saying what
  // Git is doing, without waiting for output that is never coming.
  const busy = window.locator('.wt-btn[aria-busy="true"]');
  await expect(busy).toHaveAttribute("aria-label", "Fetching updates…", {
    timeout: 20_000
  });

  await busy.hover();
  const card = window.locator(".remote-activity-popover");
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("Pull · svc · main");
  // The two facts that turn "it's spinning" into something actionable.
  await expect(card).toContainText("git fetch --prune --progress");
  await expect(card).toContainText("Git has produced no output yet.");

  // And a way out that is not force-quitting the app.
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(busy).toHaveCount(0, { timeout: 20_000 });
  await expect(window.locator(".sync-chip")).toContainText("pull canceled", {
    timeout: 10_000
  });
  // A cancel is the user's own decision, not a failure to report back at them.
  await expect(window.locator(".app-toast")).toHaveCount(0);
});

test("an operation in another repository stays visible and cancellable after you navigate away", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const stuck = box.makeRepoBehindRemote("stuck", { behindBy: 1 });
  box.makeRepo("other");
  const port = await startSilentRemote();
  box.git(stuck.path, "remote", "set-url", "origin", `git://127.0.0.1:${port}/stuck.git`);

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "stuck");

  const pull = window.getByRole("button", { name: /^Pull/ });
  await expect(pull).toBeVisible({ timeout: 20_000 });
  await pull.click();
  await expect(window.locator('.wt-btn[aria-busy="true"]')).toHaveCount(1, {
    timeout: 20_000
  });

  // Click into the other repository. Its toolbar is correctly silent about
  // work that is not its own — which is how a wedged fetch used to disappear.
  await window.locator(".repo-row", { hasText: "other" }).first().click();

  const toast = window.locator(".app-toast--activity");
  // Deliberately delayed: a card that appeared for every half-second refresh
  // would be a flicker rather than a status.
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("Pull · stuck · main");

  await toast.getByRole("button", { name: "Cancel" }).click();
  await expect(toast).toHaveCount(0, { timeout: 20_000 });
});
