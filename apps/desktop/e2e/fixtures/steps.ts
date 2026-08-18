import { expect, type Locator, type Page } from "@playwright/test";
import type { AppHandle } from "./electron-app";
import type { GitSandbox } from "./git-sandbox";

// Every step below is bounded, and the bounds are a budget against
// playwright.config.ts's 60s per-test timeout: launchApp() and the
// Add-folders/lens clicks are already charged to it before any of this runs.
// One disclosure dance costs at most
//   MAX_PASSES * (READ + CLICK + SETTLE + READ) + FINAL
//   = 4 * (1 + 3 + 1.5 + 1) + 5 = 31s
// — the trailing READ is the one `settlesWithin` performs on its last poll, and
// it is easy to forget when re-tuning these. Staying under the test timeout is
// what lets a disclosure that genuinely refuses to open reach the assertion
// that names it, instead of the run being cut off with an opaque timeout
// pointing at whatever line happened to be executing.
const EXPAND_READ_MS = 1_000;
const EXPAND_CLICK_MS = 3_000;
const EXPAND_SETTLE_MS = 1_500;
const EXPAND_FINAL_MS = 5_000;
/** Odd on purpose. A disclosure click is a *toggle*, so if every click lands
    but the renders lag past SETTLE_MS the clicks alternate open/closed: an even
    count ends on the wrong state and the final assertion can never pass, while
    an odd count ends on the one we want. This counts clicks that actually
    landed — bounding the loop on passes instead would let a swallowed click
    flip the parity. */
const EXPAND_CLICKS = 3;
/** Safety valve for the click budget above: a trigger that is never clickable
    must not spin. Passes beyond this are almost certainly a broken selector
    rather than a dropped click, and the failure message says so. */
const EXPAND_MAX_PASSES = 4;
/** How long a repo row may take to appear once its root is added — this is the
    indexing wait, and it dwarfs everything else here. */
const ROW_VISIBLE_MS = 20_000;
/** The worktree section renders in the same React commit as its repo group, so
    once the group reads expanded this only has to cover a render. Deliberately
    not ROW_VISIBLE_MS: two 20s waits in one helper would overrun the test
    timeout that the budget above exists to respect. */
const SECTION_VISIBLE_MS = 5_000;

/** Playwright raises `TimeoutError` when a locator can't be resolved in time,
    and a plain `Error` for a strict-mode violation. Only the former is worth
    retrying. */
const isTimeout = (err: unknown): boolean =>
  err instanceof Error && err.name === "TimeoutError";

/** Read `aria-expanded`, or null when the control can't be resolved in time.
    A row that vanishes mid-re-render is a reason to look again — but an
    ambiguous locator is a real test bug, so strict-mode violations propagate
    instead of being laundered into "not expanded". */
async function expandedState(control: Locator): Promise<string | null> {
  try {
    return await control.getAttribute("aria-expanded", {
      timeout: EXPAND_READ_MS
    });
  } catch (err) {
    if (!isTimeout(err)) throw err;
    return null;
  }
}

/** Poll `aria-expanded` for up to `ms`; false if it never reads `target`. */
async function settlesWithin(
  control: Locator,
  target: string,
  ms: number
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await expandedState(control)) === target) return true;
    if (Date.now() >= deadline) return false;
    await control.page().waitForTimeout(50);
  }
}

/** Click `trigger` until `control` reports `aria-expanded` matching `want`.

    Expanding used to be one unchecked click, and specs would stall 20-30s
    later on a `.wt-row` that could not exist because the group was still
    closed. This retry is what caught why: its `console.warn` fired on about
    half of idle-machine runs, which led to `useListReorder` suppressing every
    row click for the first 250ms of the window's life. That is fixed at the
    source now, so this loop should be silent — keep the log, because a line
    from any spec that isn't deliberately dropping a click is the signal that
    something has regressed. */
async function clickUntilExpanded(
  control: Locator,
  trigger: Locator,
  want: boolean,
  what: string
): Promise<void> {
  const target = want ? "true" : "false";
  const verb = want ? "open" : "close";
  let clicks = 0;
  let passes = 0;
  let lastClickError: string | null = null;
  while (clicks < EXPAND_CLICKS && passes < EXPAND_MAX_PASSES) {
    passes += 1;
    if ((await expandedState(control)) === target) return;
    if (clicks > 0) {
      // Whether the dropped-click theory holds is only answerable if the
      // recovery is visible when it happens. Keep this loud.
      console.warn(`[steps] ${what}: click ${clicks} did not take — retrying`);
    }
    try {
      await trigger.click({ timeout: EXPAND_CLICK_MS });
      clicks += 1;
    } catch (err) {
      // Not clickable right now (mid-re-render, or covered). Keep the reason:
      // a stale selector fails here every pass, and reporting only "stayed
      // closed" would send the reader to the wrong place entirely.
      lastClickError = String(err).split("\n")[0] ?? String(err);
    }
    if (await settlesWithin(control, target, EXPAND_SETTLE_MS)) return;
  }
  // Out of budget: assert, so the failure names the stuck disclosure instead
  // of surfacing as a missing row somewhere downstream.
  const detail =
    lastClickError === null ? "" : `; last click error: ${lastClickError}`;
  await expect(
    control,
    `${what} did not ${verb}: ${clicks} of ${passes} clicks landed${detail}`
  ).toHaveAttribute("aria-expanded", target, { timeout: EXPAND_FINAL_MS });
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
  await clickUntilExpanded(
    group,
    group.locator(".repo-row__name"),
    true,
    `Repo group "${repoName}"`
  );
  return group;
}

/** Add the sandbox as a repo folder (via the stubbed picker), switch to the All
    lens so nothing is filtered out, then open its repo and Worktrees groups.
    The explicit Worktrees step keeps specs that need a row focused on their
    behavior instead of the default disclosure state. */
/**
 * A lens button by name. The switch is icon-only, so there is no text to match
 * — the lens name lives in the accessible name, which also carries the count
 * ("Pinned (14)"), hence the prefix match.
 */
export const lensChip = (window: Page, lens: string): Locator =>
  window.getByRole("tab", { name: new RegExp(`^${lens}\\b`) });

export async function addRootAndExpand(
  window: Page,
  app: AppHandle,
  box: GitSandbox,
  repoName: string
): Promise<void> {
  await app.setPickDirectory(box.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, repoName);
  await expandWorktrees(window, repoName);
}

/** The nested "Worktrees N" disclosure inside `repoName`'s group. Only exists
    while the group is open, which is why both helpers below re-assert that
    first. */
async function worktreesToggle(
  window: Page,
  repoName: string
): Promise<Locator> {
  const group = await expandRepoGroup(window, repoName);
  const toggle = window
    .locator(".repo-block", { has: group })
    .locator(".wt-section__toggle");
  await expect(toggle).toBeVisible({ timeout: SECTION_VISIBLE_MS });
  return toggle;
}

/** Open the nested "Worktrees N" disclosure and return its toggle. Reading
    `aria-expanded` back means a spec that needs its rows never has to depend
    on the current default or an earlier click in the same test. */
export async function expandWorktrees(
  window: Page,
  repoName: string
): Promise<Locator> {
  const toggle = await worktreesToggle(window, repoName);
  await clickUntilExpanded(
    toggle,
    toggle,
    true,
    `Worktrees section of "${repoName}"`
  );
  return toggle;
}

/** Close the nested "Worktrees N" disclosure and return its toggle. Closing is
    exposed to the same dropped click as opening, so it gets the same read-back
    rather than a bare `click()`. */
export async function collapseWorktrees(
  window: Page,
  repoName: string
): Promise<Locator> {
  const toggle = await worktreesToggle(window, repoName);
  await clickUntilExpanded(
    toggle,
    toggle,
    false,
    `Worktrees section of "${repoName}"`
  );
  return toggle;
}

export const branchRow = (window: Page, branch: string): Locator =>
  window.locator(".wt-row").filter({ hasText: branch });

/** Open the repo-wide "Branches N" disclosure and return its group. Uses the
    same read-back-`aria-expanded` loop as the Worktrees section, so a dropped
    click surfaces as a stuck disclosure rather than a missing row. */
export async function expandBranchesSection(
  window: Page,
  repoName: string
): Promise<Locator> {
  const group = await expandRepoGroup(window, repoName);
  const block = window.locator(".repo-block", { has: group });
  const toggle = block.locator(".ref-section__head", { hasText: "Branches" });
  await expect(toggle).toBeVisible({ timeout: SECTION_VISIBLE_MS });
  await clickUntilExpanded(
    toggle,
    toggle,
    true,
    `Branches section of "${repoName}"`
  );
  return block.locator(".ref-branch-list");
}

/** One row in the repo-wide branch list — the paired-focus surface, distinct
    from `branchRow`, which is a worktree row that happens to show a branch. */
export const refBranchRow = (window: Page, branch: string): Locator =>
  window.locator(".ref-branch-row").filter({
    has: window.locator(".refs-copyable-name__text", { hasText: branch })
  });
