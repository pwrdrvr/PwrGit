import { expect, type Locator, type Page } from "@playwright/test";
import type { AppHandle } from "./electron-app";
import type { GitSandbox } from "./git-sandbox";

// Every step below is bounded, and the bounds are sized as a budget against
// playwright.config.ts's 60s per-test timeout. The caller has already spent
// time on launchApp() and the Add-folders/lens clicks, and waiting for a
// freshly added repo to be indexed can take the 20s below on its own. The
// expand dance therefore caps itself at
// ATTEMPTS * (READ + CLICK + SETTLE) + FINAL ≈ 23s, so that when a group
// genuinely refuses to open the final assertion still gets to run and name it
// — rather than the test being cut off at 60s with an opaque timeout pointing
// at whatever line happened to be executing.
const EXPAND_READ_MS = 1_000;
const EXPAND_CLICK_MS = 3_000;
const EXPAND_SETTLE_MS = 2_000;
const EXPAND_FINAL_MS = 5_000;
/** Odd on purpose. A disclosure click is a *toggle*, so if every click lands
    but the renders lag past SETTLE_MS, the retries alternate open/closed: an
    even count ends collapsed and the final assertion can never pass, while an
    odd count ends expanded. */
const EXPAND_ATTEMPTS = 3;
/** How long a repo row may take to appear once its root is added — this is the
    indexing wait, and it dwarfs everything else here. */
const ROW_VISIBLE_MS = 20_000;

/** Read `aria-expanded`, or null when the control can't be resolved in time.
    Never throws: a row that vanishes mid-re-render is a reason to look again,
    not to abort the loop that exists to survive re-renders. */
async function expandedState(control: Locator): Promise<string | null> {
  try {
    return await control.getAttribute("aria-expanded", {
      timeout: EXPAND_READ_MS
    });
  } catch {
    return null;
  }
}

/** Poll `aria-expanded` for up to `ms`; false if it never reads "true". */
async function opensWithin(control: Locator, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await expandedState(control)) === "true") return true;
    if (Date.now() >= deadline) return false;
    await control.page().waitForTimeout(50);
  }
}

/** Click `trigger` until `control` reports itself expanded.

    Expanding used to be one unchecked click, and specs would stall 20-30s
    later on a `.wt-row` that could not exist because the group was still
    closed. The first expand click after a root is added really does get
    dropped — instrumenting this retry showed it firing on roughly half of
    idle-machine runs, in a test that was not rigging the click — so the second
    click here is load-bearing, not belt-and-braces. Keep the `console.warn`:
    it is the only signal that distinguishes a dropped click from the other
    candidate (worktree indexing latency), which would show up as a stall with
    no retry logged. */
async function clickToExpand(
  control: Locator,
  trigger: Locator,
  what: string
): Promise<void> {
  let clicks = 0;
  for (let attempt = 0; attempt < EXPAND_ATTEMPTS; attempt += 1) {
    if ((await expandedState(control)) === "true") return;
    if (clicks > 0) {
      // Whether the dropped-click theory is real is only answerable if the
      // recovery is visible when it happens. Keep this loud.
      console.warn(`[steps] ${what}: click ${clicks} did not take — retrying`);
    }
    try {
      await trigger.click({ timeout: EXPAND_CLICK_MS });
      clicks += 1;
    } catch {
      // Not clickable right now (mid-re-render, or covered). Fall through to
      // the settle poll and look again on the next pass.
    }
    if (await opensWithin(control, EXPAND_SETTLE_MS)) return;
  }
  // Out of attempts: assert, so the failure names the collapsed disclosure
  // instead of surfacing as a missing row somewhere downstream.
  await expect(
    control,
    `${what} stayed collapsed after ${clicks} of ${EXPAND_ATTEMPTS} attempted clicks`
  ).toHaveAttribute("aria-expanded", "true", { timeout: EXPAND_FINAL_MS });
}

/** The sidebar row for `repoName`: a level-1 `treeitem` whose `aria-expanded`
    is the source of truth for whether its worktrees are showing. */
export const repoGroup = (window: Page, repoName: string): Locator =>
  window.getByRole("treeitem", { name: repoName, exact: true });

/** Wait for `repoName`'s row and make sure its group is open. Cheap to call
    when it already is — the state read short-circuits before any click. */
export async function expandRepoGroup(
  window: Page,
  repoName: string
): Promise<Locator> {
  const group = repoGroup(window, repoName);
  await expect(group).toBeVisible({ timeout: ROW_VISIBLE_MS });
  await clickToExpand(
    group,
    group.locator(".repo-row__name"),
    `Repo group "${repoName}"`
  );
  return group;
}

/** Add the sandbox as a repo folder (via the stubbed picker), switch to the All
    lens so nothing is filtered out, then wait for `repoName` and expand it. */
export async function addRootAndExpand(
  window: Page,
  app: AppHandle,
  box: GitSandbox,
  repoName: string
): Promise<void> {
  await app.setPickDirectory(box.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expandRepoGroup(window, repoName);
}

/** Open the nested "Worktrees N" disclosure inside `repoName`'s group, and
    return its toggle. The section is usually already open — it defaults closed
    only when the repo has a pinned worktree, or when an earlier click in the
    same test closed it — but reading `aria-expanded` back means a spec that
    needs the unpinned rows doesn't have to guess. */
export async function expandWorktrees(
  window: Page,
  repoName: string
): Promise<Locator> {
  // The section only renders while the repo group is open, so a collapsed
  // group would otherwise show up here as a long wait for a toggle that cannot
  // exist. Re-assert the group first; it is a no-op when it is already open.
  const group = await expandRepoGroup(window, repoName);
  const toggle = window
    .locator(".repo-block", { has: group })
    .locator(".wt-section__toggle");
  await expect(toggle).toBeVisible({ timeout: ROW_VISIBLE_MS });
  await clickToExpand(toggle, toggle, `Worktrees section of "${repoName}"`);
  return toggle;
}

export const branchRow = (window: Page, branch: string): Locator =>
  window.locator(".wt-row").filter({ hasText: branch });
