import { expect, type Locator, type Page } from "@playwright/test";
import type { AppHandle } from "./electron-app";
import type { GitSandbox } from "./git-sandbox";

/** How long one expand click gets to show up as `aria-expanded="true"` before
    we treat it as lost and click again. Long enough that a slow render isn't
    mistaken for a dropped click, short enough that the retry still lands well
    inside the caller's first assertion. */
const EXPAND_SETTLE_MS = 3_000;
/** A click is only ever lost to a render already in flight, so two or three
    attempts always suffice; the cap exists to fail loudly rather than spin. */
const EXPAND_ATTEMPTS = 4;

/** Poll `aria-expanded` for up to `ms`. Returns false instead of throwing so
    the caller can decide to click again. */
async function opensWithin(control: Locator, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await control.getAttribute("aria-expanded", { timeout: ms });
    if (state === "true") return true;
    if (Date.now() >= deadline) return false;
    await control.page().waitForTimeout(50);
  }
}

/** Click `trigger` until `control` reports itself expanded.

    One click is not enough. The sidebar re-renders while a freshly added root
    is indexed, and a click that lands mid-render is dropped — the group stays
    closed, and the spec then waits out a full timeout on a `.wt-row` that
    cannot exist yet, 20-30s later in an assertion that has nothing to do with
    expansion. Reading the disclosure state back turns that into a retry. */
async function clickToExpand(
  control: Locator,
  trigger: Locator,
  what: string
): Promise<void> {
  for (let attempt = 0; attempt < EXPAND_ATTEMPTS; attempt += 1) {
    if ((await control.getAttribute("aria-expanded")) === "true") return;
    await trigger.click();
    if (await opensWithin(control, EXPAND_SETTLE_MS)) return;
  }
  // Out of retries: assert, so the failure names the collapsed disclosure
  // instead of surfacing as a missing row somewhere downstream.
  await expect(
    control,
    `${what} stayed collapsed after ${EXPAND_ATTEMPTS} clicks`
  ).toHaveAttribute("aria-expanded", "true");
}

/** The sidebar row for `repoName`: a level-1 `treeitem` whose `aria-expanded`
    is the source of truth for whether its worktrees are showing. */
export const repoGroup = (window: Page, repoName: string): Locator =>
  window.getByRole("treeitem", { name: repoName, exact: true });

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
  const group = repoGroup(window, repoName);
  await expect(group).toBeVisible({ timeout: 20_000 });
  await clickToExpand(
    group,
    group.locator(".repo-row__name"),
    `Repo group "${repoName}"`
  );
}

/** Open the nested "Worktrees N" disclosure inside `repoName`'s group, and
    return its toggle. Usually already open — it only defaults closed when the
    repo has a pinned worktree — but reading `aria-expanded` back means a spec
    that needs the unpinned rows doesn't have to guess. */
export async function expandWorktrees(
  window: Page,
  repoName: string
): Promise<Locator> {
  const toggle = window
    .locator(".repo-block", { has: repoGroup(window, repoName) })
    .locator(".wt-section__toggle");
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await clickToExpand(toggle, toggle, `Worktrees section of "${repoName}"`);
  return toggle;
}

export const branchRow = (window: Page, branch: string): Locator =>
  window.locator(".wt-row").filter({ hasText: branch });
