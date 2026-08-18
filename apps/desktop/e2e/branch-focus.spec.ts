import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandBranchesSection,
  refBranchRow
} from "./fixtures/steps";

/**
 * The sidebar's paired focus: the selected worktree is the working target, and
 * the repo-wide branch list marks the branch that target sits on. Activating a
 * branch row means "make this the branch I am working on", which resolves to a
 * checkout, a focus move, or nothing — see
 * docs/plans/2026-08-18-002-design-paired-worktree-branch-focus.md.
 */

let sandbox: GitSandbox | null = null;
let handle: AppHandle | null = null;

const SETTLE_MS = 20_000;

/**
 * Wait for the branch list to stop moving before acting on a row.
 *
 * The list is not stable the moment it renders: rows arrive when `repo:refs`
 * resolves, and then the working target's branch is pinned to the top once the
 * selection resolves. A double-click whose two clicks straddle that reorder
 * lands on two different rows, so no `dblclick` fires at all — which is exactly
 * how this flaked on the slower Windows runner. The current-branch marker is
 * the signal that refs, selection and pinning have all settled.
 */
async function settledBranchList(
  window: AppHandle["window"],
  repoName: string,
  currentBranch: string
): Promise<void> {
  await expandBranchesSection(window, repoName);
  await expect(refBranchRow(window, currentBranch)).toHaveClass(/is-current/, {
    timeout: SETTLE_MS
  });
}

test.afterEach(async () => {
  if (handle !== null) {
    await handle.cleanup();
    handle = null;
  }
  sandbox?.cleanup();
  sandbox = null;
});

test("the branch list marks the branch the selected worktree is on", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("pairedfocus");
  repo.createBranch("develop");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "pairedfocus");
  await branchRow(window, "main").first().click();
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main", {
    timeout: SETTLE_MS
  });

  // Visible while the section is still collapsed — the cheap half of the pair.
  await expect(
    window.locator(".ref-section__on", { hasText: "on main" })
  ).toBeVisible({ timeout: SETTLE_MS });

  await expandBranchesSection(window, "pairedfocus");

  // main is current: it carries the marker, and aria-current is what makes the
  // state survive without color.
  const current = refBranchRow(window, "main");
  await expect(current).toHaveClass(/is-current/, { timeout: SETTLE_MS });
  await expect(current).toHaveAttribute("aria-current", "true");
  // Its chip is the filled "here" variant. It carries no folder name: the
  // primary lives in the repo's own folder, which the header above shows.
  await expect(current.locator(".ref-checkout-chip.is-here")).toBeVisible();
  await expect(current.locator(".ref-checkout-chip__name")).toHaveCount(0);

  // develop has no worktree, so it is free — no marker, no chip.
  const free = refBranchRow(window, "develop");
  await expect(free).toHaveClass(/is-free/);
  await expect(free.locator(".ref-checkout-chip")).toHaveCount(0);
});

test("an occupied branch names the worktree holding it", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("occupied");
  // Deliberately NOT the branch's own slug: a folder named after its branch
  // would only repeat the row, and the chip drops it. This one adds something.
  repo.createBranch("feature/x");
  const elsewhere = `${repo.path}-scratch-checkout`;
  box.git(repo.path, "worktree", "add", elsewhere, "feature/x");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "occupied");
  await branchRow(window, "main").first().click();
  await settledBranchList(window, "occupied", "main");

  // Occupied, not current: an outlined chip naming that worktree's folder.
  const occupied = refBranchRow(window, "feature/x");
  await expect(occupied).toHaveClass(/is-occupied/, { timeout: SETTLE_MS });
  await expect(occupied.locator(".ref-checkout-chip")).not.toHaveClass(
    /is-here/
  );
  await expect(occupied.locator(".ref-checkout-chip__name")).toHaveText(
    "occupied-scratch-checkout"
  );

  // Activating it is a focus move, not a checkout — git refuses a second
  // checkout of one branch, so the app goes to the worktree instead.
  await occupied.dblclick();
  await expect(window.locator(".titlebar__branch-name")).toHaveText(
    "feature/x",
    { timeout: SETTLE_MS }
  );
  await expect(window.locator(".modal--dialog")).toHaveCount(0);
});

test("double-clicking a free branch switches the selected worktree to it", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("dblswitch");
  repo.createBranch("develop");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "dblswitch");
  await branchRow(window, "main").first().click();
  const headerBranch = window.locator(".titlebar__branch-name");
  await expect(headerBranch).toHaveText("main", { timeout: SETTLE_MS });

  await settledBranchList(window, "dblswitch", "main");
  await refBranchRow(window, "develop").dblclick();

  // The checkout moved: the header, and the marker, both follow.
  await expect(headerBranch).toHaveText("develop", { timeout: SETTLE_MS });
  await expect(refBranchRow(window, "develop")).toHaveClass(/is-current/, {
    timeout: SETTLE_MS
  });
  await expect(
    window.locator(".ref-section__on", { hasText: "on develop" })
  ).toBeVisible({ timeout: SETTLE_MS });
});

// A clean tree switches with no dialog at all — the common case, where a
// confirm would make the gesture feel expensive.
test("a clean switch asks nothing", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("noprompt");
  repo.createBranch("develop");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "noprompt");
  await branchRow(window, "main").first().click();
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main", {
    timeout: SETTLE_MS
  });

  await settledBranchList(window, "noprompt", "main");
  await refBranchRow(window, "develop").dblclick();

  await expect(window.locator(".titlebar__branch-name")).toHaveText("develop", {
    timeout: SETTLE_MS
  });
  await expect(window.locator(".modal--dialog")).toHaveCount(0);
});

// Enter is the keyboard half of double-click. Without it the row would be
// pointer-only, which fails SC 2.1.1.
test("Enter on a focused branch row activates it", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("keyboardswitch");
  repo.createBranch("develop");

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "keyboardswitch");
  await branchRow(window, "main").first().click();
  await expect(window.locator(".titlebar__branch-name")).toHaveText("main", {
    timeout: SETTLE_MS
  });

  await settledBranchList(window, "keyboardswitch", "main");
  const row = refBranchRow(window, "develop");
  await row.focus();
  await row.press("Enter");

  await expect(window.locator(".titlebar__branch-name")).toHaveText("develop", {
    timeout: SETTLE_MS
  });
});
