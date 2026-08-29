import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import {
  createDocsWorld,
  DOCS_AUTHOR,
  shotsDir,
  type DocsWorld
} from "./fixtures/docs-world";
import {
  addRootAndExpand,
  branchRow,
  lensChip,
  primaryShortcut
} from "./fixtures/steps";

/**
 * Captures the screenshots published on docs.pwrgit.com and pwrgit.com.
 *
 * Not part of the normal e2e run: it is slow, it writes artifacts, and a
 * caption changing is not a regression. Opt in explicitly.
 *
 *   PWRGIT_DOCS_SHOTS=1 pnpm --filter @pwrgit/desktop test:docs-shots
 *
 * These are real captures of the real app driven through its real UI — which
 * is the entire point. The marketing site shipped a hand-drawn CSS mockup of
 * the three-pane layout, captioned as though it were the product; anything
 * here is by construction the thing the reader will actually install.
 *
 * Determinism is deliberate and load-bearing, because the output is committed
 * to another repo and re-committed on every refresh:
 *   - one fixed window size, so images don't reflow between runs;
 *   - the dark theme pinned, never the runner's system preference;
 *   - a fixed repository world (see docs-world.ts).
 * Anything still varying between runs (relative timestamps, most obviously)
 * shows up as pixel churn in the docs repo, which is what
 * scripts/filter-noise-screenshots.mjs over there exists to absorb.
 */

// 16:10, matching the docs site's figure column and the marketing hero.
const WINDOW = { width: 1440, height: 900 };

let world: DocsWorld | null = null;
let handle: AppHandle | null = null;

const shots = shotsDir();

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
});

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  world?.cleanup();
  world = null;
});

/** Resize the real BrowserWindow — Electron ignores setViewportSize. */
async function sizeWindow(app: AppHandle["app"]): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) throw new Error("no window to size");
    win.setBounds({ x: 0, y: 0, ...size });
  }, WINDOW);
}

async function shoot(window: Page, name: string): Promise<void> {
  // Let layout settle after whatever interaction preceded this; a capture
  // mid-transition is the classic source of a blurry or half-drawn figure.
  await window.waitForTimeout(400);
  await window.screenshot({ path: join(shots, `${name}.png`) });
}

/** Open the world with the docs identity as the active profile. Passed as
 *  `identity` rather than appended via `gitConfig`: the app reads the FIRST
 *  name/email in the file, so a trailing [user] block is silently ignored and
 *  the profile chip would still read the test fixture's address. */
async function openDocsApp(): Promise<AppHandle> {
  const w = createDocsWorld();
  world = w;
  const h = await launchApp({
    theme: "dark",
    worktreeRoot: w.box.worktreeRoot,
    identity: DOCS_AUTHOR
  });
  handle = h;
  await sizeWindow(h.app);
  return h;
}

test.describe("documentation screenshots", () => {
  test.skip(
    process.env.PWRGIT_DOCS_SHOTS !== "1",
    "opt-in: set PWRGIT_DOCS_SHOTS=1"
  );

  test("sidebar, lineage, changes and search", async () => {
    const h = await openDocsApp();
    const { window } = h;
    const w = world;
    if (w === null) throw new Error("world not built");

    await addRootAndExpand(window, h, w.box, w.primary);

    // Select before capturing anything. Expanding a repo group also selects
    // it, so whichever repo was expanded last would otherwise own the graph —
    // and the neighbours are one-commit repos whose lineage says nothing.
    await branchRow(window, "feat/checkout-redesign").first().click();
    // .first(): the branch now has an upstream, so both the local chip and
    // `origin/feat/checkout-redesign` match — which is the point of pushing it.
    await expect(
      window.locator(".ref-chip", { hasText: "feat/checkout-redesign" }).first()
    ).toBeVisible({ timeout: 20_000 });

    // 1. The sidebar: the whole working set. Only the focus repo is expanded,
    //    so every repository stays above the fold — a list that scrolls its
    //    own rows out of frame is a worse advertisement for handling hundreds
    //    of them than a short one.
    await expect(window.getByRole("treeitem", { name: "openclaw" })).toBeVisible();
    await shoot(window, "sidebar");

    // 2. The lineage graph for a branch with work in flight. This is also the
    //    hero: three panes, populated, in one window.
    await shoot(window, "lineage");
    await shoot(window, "hero");

    // 3. The Changes rail, on the worktree that has uncommitted work.
    await branchRow(window, "fix/session-timeout").first().click();
    await expect(window.getByTestId("rail")).toBeVisible();
    await expect(window.locator(".file-row").first()).toBeVisible({
      timeout: 20_000
    });
    await shoot(window, "changes");

    // 4. The search overlay, mid-query, so results are on screen.
    await window.keyboard.press(primaryShortcut("k"));
    await expect(window.locator(".overlay-panel")).toBeVisible();
    await window.locator(".overlay-search input").fill("acme");
    await expect(window.locator(".overlay-result").first()).toBeVisible({
      timeout: 20_000
    });
    await shoot(window, "search");
    await window.keyboard.press("Escape");
    await expect(window.locator(".overlay-panel")).toBeHidden();

    // 5. The Stale lens — the answer to "which of these can I delete?".
    await lensChip(window, "Stale").click();
    await shoot(window, "stale-lens");
  });
});
