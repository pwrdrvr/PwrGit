import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
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

test("the Pinned lens keeps pinned stars visible", async () => {
  sandbox = createGitSandbox();
  for (const name of ["alpha", "bravo", "charlie"]) sandbox.makeRepo(name);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3, {
    timeout: 20_000
  });
  for (const name of ["alpha", "bravo", "charlie"]) {
    await window
      .locator(".repo-row", { hasText: name })
      .locator(".pin")
      .click();
  }
  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);

  // Park the pointer well clear of the list and drop focus to the body. The
  // stars communicate pin state even when the rows are idle.
  await window.mouse.move(2000, 2000);
  await window.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

  const pins = window.locator(".repo-row .pin");
  await expect(pins).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await expect(pins.nth(i)).toHaveCSS("opacity", "1");
    await expect(pins.nth(i)).toHaveAttribute("aria-pressed", "true");
  }

  // The visible star remains the unpin action, so the row leaves this lens.
  await window
    .locator(".repo-row", { hasText: "bravo" })
    .getByRole("button", { name: "Unpin repo" })
    .click();
  await expect(window.locator(".repo-row__name")).toHaveCount(2);
  await expect(
    window.locator(".repo-row", { hasText: "bravo" })
  ).toHaveCount(0);
});

test("a drag keeps stars visible but lets the grip hide again", async () => {
  sandbox = createGitSandbox();
  for (const name of ["alpha", "bravo", "charlie"]) sandbox.makeRepo(name);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3, {
    timeout: 20_000
  });
  for (const name of ["alpha", "bravo", "charlie"]) {
    await window
      .locator(".repo-row", { hasText: name })
      .locator(".pin")
      .click();
  }
  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);

  // Drag, which focuses the source row: a `draggable` element with a tab stop
  // takes focus on mousedown. The pin stays visible because it represents
  // state; the transient drag grip should still disappear with the pointer.
  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  const charlie = window.locator(".repo-row", { hasText: "charlie" });
  const box = await charlie.boundingBox();
  if (box === null) throw new Error("charlie row has no box");
  await alpha.hover();
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 12
  });
  await window.mouse.up();

  // Deliberately no blur() here so the retained drag focus is covered.
  await window.mouse.move(2000, 2000);
  const pins = window.locator(".repo-row .pin");
  await expect(pins).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await expect(pins.nth(i)).toHaveCSS("opacity", "1");
    await expect(pins.nth(i)).toHaveAttribute("aria-pressed", "true");
  }

  const handles = window.locator(".repo-row__handle");
  await expect(handles).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await expect(handles.nth(i)).toHaveCSS("opacity", "0");
  }
});
