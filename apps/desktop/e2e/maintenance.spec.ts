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

test("collects all repositories and reviews stale local branches without touching dirty work", async ({}, testInfo) => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepoBehindRemote("atlas-client");
  sandbox.makeRepoBehindRemote("beacon-api");
  sandbox.git(repo.path, "branch", "feature/finished");
  sandbox.git(repo.path, "push", "-u", "origin", "feature/finished");
  sandbox.git(repo.path, "push", "origin", "--delete", "feature/finished");
  writeFileSync(join(repo.path, "local-notes.txt"), "Keep this local work\n");
  const refs = sandbox.git(repo.path, "show-ref");
  const dirty = sandbox.git(repo.path, "status", "--porcelain");

  handle = await launchApp({
    identity: { name: "Demo Developer", email: "demo@example.test" }
  });
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "atlas-client");
  await window
    .getByRole("button", { name: "Repository maintenance…", exact: true })
    .click();
  const dialog = window.getByRole("dialog", { name: "Repository maintenance" });
  await dialog.getByRole("button", { name: "Garbage collection", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /Standard/ })).toBeChecked();
  await dialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("maintenance-options.png")
  });
  await dialog
    .getByRole("button", { name: "Run garbage collection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Finished", {
    timeout: 30_000
  });
  await expect(dialog).toContainText("2 succeeded");
  // Fixture repositories reclaim kilobytes, so both fold into the quiet line.
  await expect(dialog.locator(".maintenance__quiet")).toContainText(
    "2 repositories with less than 1 MiB to reclaim"
  );
  await dialog
    .locator(".maintenance__quiet")
    .getByRole("button", { name: "Show", exact: true })
    .click();
  await expect(dialog.locator(".bulk-sync__repo")).toHaveCount(2);
  await expect(dialog.locator(".bulk-sync__repo").first()).toContainText(
    "Object storage:"
  );
  expect(sandbox.git(repo.path, "show-ref")).toBe(refs);
  expect(sandbox.git(repo.path, "status", "--porcelain")).toBe(dirty);
  await dialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("maintenance-results.png")
  });

  await dialog
    .getByRole("button", { name: "Local branches", exact: true })
    .click();
  await expect(dialog).toContainText("Fetch all repos first");
  await dialog
    .getByRole("button", { name: "Review local branches", exact: true })
    .click();
  // The branch was made seconds ago, so the default week-long age guard
  // keeps it and says so rather than offering it.
  await dialog.locator(".maintenance__quiet").getByRole("button", { name: "Show" }).click();
  await expect(dialog).toContainText("1 touched in the last 7 days");
  await expect(
    dialog.getByRole("button", { name: "Delete 0 selected local branches" })
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Change", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "Keep branches touched in the last" })
    .uncheck();
  await dialog
    .getByRole("button", { name: /^Review (local branches|again)$/ })
    .click();
  await expect(dialog).toContainText("1 finished branch");
  // Offered branches arrive selected; the review is the confirmation.
  await expect(
    dialog.getByRole("checkbox", { name: /feature\/finished.*Already in HEAD/ })
  ).toBeChecked();
  await dialog.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("maintenance-branches.png")
  });
  await dialog
    .getByRole("button", { name: "Delete 1 selected local branch" })
    .click();
  await expect(dialog).toContainText("1 local branch deleted; 0 retained");
  await expect(
    dialog.getByRole("button", { name: /^Restore feature\/finished at / })
  ).toBeVisible();
  expect(sandbox.git(repo.path, "branch", "--list", "feature/finished")).toBe(
    ""
  );
  expect(sandbox.git(repo.path, "status", "--porcelain")).toBe(dirty);
});

for (const [width, height] of [
  [1360, 860],
  [1000, 650]
]) {
  test(`maintenance keeps its geometry across repository handoffs at ${width}x${height}`, async ({}, testInfo) => {
    handle = await launchApp({
      theme: "light",
      identity: { name: "Demo Developer", email: "demo@example.test" }
    });
    const { app, window } = handle;
    await window.emulateMedia({ reducedMotion: "reduce" });
    const nativeWindow = await app.browserWindow(window);
    await nativeWindow.evaluate(
      (win, size) => win.setSize(size[0]!, size[1]!),
      [width!, height!]
    );
    await window
      .getByRole("button", { name: "Repository maintenance…", exact: true })
      .click();
    const dialog = window.getByRole("dialog", {
      name: "Repository maintenance"
    });
    await dialog.getByRole("button", { name: "Garbage collection", exact: true }).click();
    // Script IPC progress at the real renderer boundary so both the brief
    // between-repo gap and overlapping workers are deterministic on every CPU.
    const fixture = await app.evaluateHandle(({ ipcMain }) => {
      let send: ((event: object) => void) | undefined;
      let finish: (() => void) | undefined;
      ipcMain.removeHandler("pwrgit:dispatch");
      ipcMain.handle("pwrgit:dispatch", (event, name, req) => {
        if (name === "maintenance:cancel")
          return { ok: true, value: { cancelled: true } };
        if (name !== "maintenance:run")
          return {
            ok: false,
            error: { kind: "repo", code: "fixture", message: "Layout fixture" }
          };
        send = (progress) =>
          event.sender.send("pwrgit:event", "maintenance:progress", {
            ...progress,
            operationId: req.operationId,
            profileId: req.profileId
          });
        return new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              value: {
                operationId: req.operationId,
                startedAt: "2026-09-26T12:00:00Z",
                finishedAt: "2026-09-26T12:00:02Z",
                cancelled: true,
                results: []
              }
            });
        });
      });
      return { send: (event: object) => send!(event), finish: () => finish!() };
    });
    const geometry = () =>
      dialog.evaluate((node) => {
        const rect = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          dialog: rect(node),
          footer: rect(node.querySelector(".modal__actions")!),
          status: node.querySelector(".bulk-sync__status")
            ? rect(node.querySelector(".bulk-sync__status")!)
            : null,
          body: rect(node.querySelector(".maintenance__body")!)
        };
      });
    const initial = await geometry();
    await dialog
      .getByRole("button", { name: "Run garbage collection", exact: true })
      .click();
    const repos = ["atlas-client", "beacon-api", "cedar-tools"].map((name) => ({
      id: name,
      name,
      path: `/demo/projects/${name}`,
      profileId: "demo",
      profileName: "Demo"
    }));
    await fixture.evaluate(
      (f, repos) => f.send({ phase: "starting", repos }),
      repos
    );
    await fixture.evaluate(
      (f, repo) => f.send({ phase: "repo_started", repo }),
      repos[0]
    );
    await expect(dialog.getByRole("status")).toContainText(
      "Collecting atlas-client"
    );
    const running = await geometry();
    await dialog.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("maintenance-running.png")
    });
    await fixture.evaluate(
      (f, repo) =>
        f.send({
          phase: "repo_completed",
          repo,
          result: {
            repo,
            outcome: "success",
            message: "Garbage collection completed."
          }
        }),
      repos[0]
    );
    await expect(dialog.getByRole("status")).toContainText(
      "Waiting for the next repository"
    );
    await dialog.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("maintenance-waiting.png")
    });
    const finished = await geometry();
    expect(finished.dialog).toEqual(running.dialog);
    expect(finished.footer).toEqual(running.footer);
    expect(running.dialog).toEqual(initial.dialog);
    expect(running.footer).toEqual(initial.footer);

    await fixture.evaluate((f, repos) => {
      f.send({ phase: "repo_started", repo: repos[1] });
      f.send({ phase: "repo_started", repo: repos[2] });
    }, repos);
    await expect(dialog.getByRole("status")).toContainText(
      "Collecting 2 repositories"
    );
    await expect(dialog).toContainText("2 in flight · 0 queued");
    expect(await geometry()).toEqual(running);
    await dialog.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("maintenance-parallel.png")
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText(
      "Stopping after active repository operations"
    );
    expect(await geometry()).toEqual(running);
    await fixture.evaluate((f) => f.finish());
    await expect(dialog.getByRole("status")).toContainText("Cancelled");
    expect((await geometry()).dialog).toEqual(running.dialog);
    expect((await geometry()).footer).toEqual(running.footer);
    await dialog
      .getByRole("button", { name: "Local branches", exact: true })
      .click();
    expect((await geometry()).dialog).toEqual(initial.dialog);
    expect((await geometry()).footer).toEqual(initial.footer);
  });
}
