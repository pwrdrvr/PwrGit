import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { forgeProduct } from "@pwrgit/shared";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandBranchesSection,
  refBranchRow
} from "./fixtures/steps";

/**
 * Captures design-bundle artwork for the repo's PRs and `design/**` artboards.
 *
 * Opt-in only — it writes artifacts into a repo that publishes them, and a
 * caption changing is not a regression:
 *
 *   PWRGIT_DESIGN_SHOTS=1 npx playwright test -c playwright.config.ts design-shots.spec.ts
 *
 * The host estate is **100% contrived**. `fixtures/forge-cli-stubs/` goes on
 * `PATH` ahead of any real `gh`/`glab`, so no real account, instance or token
 * can reach an image that ships in a public repo — the rule `design/SOURCE.md`
 * states for anything under `design/assets/`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const STUBS = join(HERE, "fixtures", "forge-cli-stubs");
const OUT =
  process.env["PWRGIT_DESIGN_SHOTS_DIR"] ??
  join(HERE, "..", "..", "..", "design", "assets");
const WINDOW = { width: 1180, height: 860 };

let handle: AppHandle | null = null;
let sandbox: GitSandbox | null = null;
let realPath: string | undefined;

test.skip(
  process.env["PWRGIT_DESIGN_SHOTS"] !== "1",
  "design captures are opt-in"
);

test.beforeEach(() => {
  // `launchApp` builds the child env from `process.env`, so prepending here is
  // what puts the stubs in front of a real CLI for the app under test.
  realPath = process.env["PATH"];
  process.env["PATH"] = `${STUBS}${delimiter}${realPath ?? ""}`;
});

test.afterEach(async () => {
  if (realPath !== undefined) process.env["PATH"] = realPath;
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

async function openSettings(app: AppHandle["app"]): Promise<Page> {
  const opened = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      for (const item of top.submenu?.items ?? []) {
        if (item.label === "Settings…") {
          item.click();
          return;
        }
      }
    }
    throw new Error("Settings… menu item not found");
  });
  const settings = await opened;
  await settings.waitForSelector(".settings-screen");
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("#settings")
    );
    if (win === undefined) throw new Error("no settings window to size");
    win.setBounds({ x: 0, y: 0, ...size });
  }, WINDOW);
  return settings;
}

test("Settings → Forges, on a contrived estate", async () => {
  mkdirSync(OUT, { recursive: true });
  handle = await launchApp({ theme: "dark" });
  const settings = await openSettings(handle.app);

  await settings.locator(".settings-nav__button", { hasText: "Forges" }).click();
  await settings.waitForSelector("section[aria-label='GitHub']");

  // A host somebody added by hand — the row that carries a sign-in command and
  // a Remove button. Added through the real dialog, so it is a real write.
  await settings
    .getByRole("button", { name: forgeProduct("gitlab").addHost.button })
    .click();
  await settings.locator(".modal__input").fill("gitlab.contoso-labs.test");
  await settings.getByRole("button", { name: "Add host" }).click();
  await settings.waitForSelector("[role='dialog']", { state: "detached" });

  // One host deliberately switched off, so the neutral "Off" state is on screen
  // beside the ones that are on.
  await settings
    .getByLabel("Read GitHub status from ghe.contoso-labs.test")
    .click();
  await settings.waitForTimeout(1200);

  // Back to the top before the shutter: toggling a row scrolls the pane, and
  // the first section's header — the thing this change is about — is what
  // scrolls off.
  await settings.locator(".settings-content").evaluate((el) => {
    el.scrollTop = 0;
  });
  await settings.waitForTimeout(200);

  await settings.screenshot({ path: join(OUT, "forges-after.png") });

  // Folded: what the disclosure is for, and the state that proves each header
  // still says which product it is, how it is doing, and from where.
  await settings.getByRole("button", { name: "Collapse all" }).click();
  await settings.waitForTimeout(300);
  await settings.screenshot({ path: join(OUT, "forges-collapsed.png") });
});


/**
 * The branch-switching surfaces, for `design/Branch Switching and Ref Relevance
 * - UX Review.dc.html` and its PR.
 *
 * Runs identically against the code before and after the change, so it uses no
 * selector the old build lacks — capture "before" by checking the renderer
 * sources out at the base commit, building, and running this with
 * `PWRGIT_DESIGN_SHOTS_DIR` pointed somewhere else.
 *
 * The repository is **100% contrived**: `git-sandbox.ts` builds it under a temp
 * dir with `GIT_CONFIG_GLOBAL=/dev/null`, the profile is the seeded default,
 * and every branch name here is invented. Nothing in the frame came from a real
 * account or a real repository — the rule `design/SOURCE.md` states for
 * anything that ships under `design/assets/`.
 */
test("branch lists and the refs browser, on a contrived repository", async () => {
  mkdirSync(OUT, { recursive: true });
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepoBehindRemote("northwind-labs");

  // Two branches whose remote was deleted — finished work, which is what fills
  // a short list on a repository that has been shipping for a while.
  for (const merged of ["fix/tray-chord-dismiss", "feat/editor-blur-styles"]) {
    repo.createBranch(merged);
    box.git(repo.path, "push", "-u", "origin", merged);
    box.git(repo.path, "push", "origin", "--delete", merged);
  }
  // One branch still in flight, and four more that exist only on the remote.
  repo.createBranch("feat/headless-capture");
  box.git(repo.path, "push", "-u", "origin", "feat/headless-capture");
  // More remote-only branches than the six-row preview can hold, so which six
  // it picks is a visible choice rather than "all of them".
  for (const remoteOnly of [
    "fix/recording-permission",
    "codex/video-audio-selector",
    "deps/bump-app-server-protocol",
    "feat/lineage-scope",
    "fix/window-chrome-decision",
    "chore/regenerate-licenses",
    "feat/tray-audio-toggles",
    "fix/keychain-prompt"
  ]) {
    repo.createBranch(remoteOnly);
    box.git(repo.path, "push", "origin", remoteOnly);
    box.git(repo.path, "branch", "-D", remoteOnly);
  }
  box.git(repo.path, "fetch", "--prune", "origin");

  handle = await launchApp({ theme: "dark", worktreeRoot: box.worktreeRoot });
  const { app, window } = handle;
  await app.evaluate(async ({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size });
  }, WINDOW);

  await addRootAndExpand(window, handle, box, "northwind-labs");
  await branchRow(window, "main").first().click();
  await expandBranchesSection(window, "northwind-labs");
  await window.getByRole("button", { name: /^Remotes/ }).click();
  await window.locator(".ref-remote__main", { hasText: "origin" }).click();

  // The repository, not the masthead above it.
  const block = window.locator(".repo-block").first();
  await block.scrollIntoViewIfNeeded();

  // Resting on a row, because that is when the sidebar shows what a row can do
  // — but on its right-hand end, NOT on the name: the name is a copy target
  // whose hover card would cover the two rows under it.
  const row = refBranchRow(window, "feat/headless-capture");
  const box2 = await row.boundingBox();
  await row.hover({
    position: { x: Math.max(0, (box2?.width ?? 200) - 78), y: 14 }
  });
  await window.waitForTimeout(400);
  await window
    .getByTestId("sidebar")
    .screenshot({ path: join(OUT, "branch-switch-sidebar.png") });

  await window
    .getByRole("button", { name: /^View all \d+ branches…$/ })
    .click();
  const browser = window.getByRole("dialog", {
    name: "northwind-labs branches, tags, and remotes"
  });
  await browser.waitFor();
  await window.waitForTimeout(500);
  await browser.screenshot({ path: join(OUT, "branch-switch-browser.png") });
});
