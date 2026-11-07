import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fc from "fast-check";
import { cleanEnv } from "./fixtures/electron-app";
import { worktreeRow } from "./fixtures/steps";

let app: ElectronApplication;
let page: Page;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pwrgit-row-locator-"));
  const html = join(dir, "index.html");
  writeFileSync(html, "<!doctype html><html><body></body></html>");
  app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      fileURLToPath(new URL("./harness/electron-main.cjs", import.meta.url))
    ],
    env: cleanEnv({ PWRGIT_HARNESS_HTML: html })
  });
  page = await app.firstWindow();
  await page.waitForLoadState();
});

test.afterAll(async () => {
  await app?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

async function renderRows(branches: string[]): Promise<void> {
  await page.evaluate((names) => {
    document.body.replaceChildren(...names.map((name) => {
      const row = document.createElement("div");
      row.className = "wt-row";
      row.dataset["wtId"] = name;
      const branch = document.createElement("span");
      branch.className = "wt-row__branch";
      branch.textContent = name;
      row.append(branch);
      return row;
    }));
  }, branches);
}

test("a worktree locator keeps its branch identity across arbitrary row orders", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 99 }),
    fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
    async (index, order) => {
      const branch = `feature/w-${index}`;
      const siblings = [branch, `${branch}0`, `${branch}1`];
      const row = worktreeRow(page, branch);
      await renderRows(siblings);
      expect(await row.getAttribute("data-wt-id")).toBe(branch);
      // Git status can move rows into different sections between locator reads.
      await renderRows(order.map((i) => siblings[i]!));
      expect(await row.getAttribute("data-wt-id")).toBe(branch);
    }
  ));
});

for (const branch of ["feature/w-0", "feature/w-1"]) {
  test(`${branch}0 moving before ${branch} does not change the target`, async () => {
    const row = worktreeRow(page, branch);
    await renderRows([branch, `${branch}0`, `${branch}1`]);
    expect(await row.getAttribute("data-wt-id")).toBe(branch);
    await renderRows([`${branch}0`, branch, `${branch}1`]);
    expect(await row.getAttribute("data-wt-id")).toBe(branch);
  });
}
