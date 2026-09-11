import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { addRootAndExpand, branchRow, repoGroup } from "./fixtures/steps";

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

/**
 * Panes whose descendants poke out of them, plus which panes were actually
 * measured. `scrollHeight` on a box that is not a scroll container still
 * reports the scrollable overflow its descendants produced, which is exactly
 * what an escaped `.a11y-sr-only` span inflated.
 *
 * A pane that is not on screen (the rail, when it is collapsed) is skipped
 * rather than reported: a missing box is not an overflowing one. `measured`
 * is returned so a caller can still fail on a selector that has rotted away.
 */
async function paneOverflow(
  page: Page
): Promise<{ overflowing: string[]; measured: string[] }> {
  return page.evaluate(() => {
    const overflowing: string[] = [];
    const measured: string[] = [];
    for (const sel of [
      ".pane--sidebar",
      ".pane--main",
      ".pane--rail",
      ".app-body"
    ]) {
      const el = document.querySelector(sel);
      if (el === null) continue;
      measured.push(sel);
      const over = el.scrollHeight - el.clientHeight;
      if (over > 0) overflowing.push(`${sel}: +${over}px`);
    }
    return { overflowing, measured };
  });
}

/**
 * The shell is chrome, not a document: nothing may scroll it.
 *
 * The bug this pins down: `body` kept `overflow: hidden`, which refuses the
 * *user* but obeys the *script*. Anything that poked past the app's 100vh —
 * a popover placed near the bottom edge, a pane that briefly could not shrink
 * — gave it somewhere to scroll to, and the next reveal (`scrollIntoView`
 * from the sidebar or the graph, or a plain `focus()`) rode the titlebar up
 * under the traffic lights and left a band of bare <body> along the bottom,
 * with no way to scroll back. #214 clipped `<html>`, which only moved the
 * scroll box down a level — an explicit root overflow stops `body`'s value
 * propagating to the viewport, so `hidden` became body's own.
 *
 * So the assertion is about the box, not about any one popover: inject the
 * overflow, then try every way the app moves things, and require the chrome
 * to sit still. A future pane that overflows is a layout bug on its own
 * terms; it must not also be able to drag the window chrome off-screen.
 */
test("nothing can scroll the window chrome, whatever overflows a pane", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("aaa-park");
  // Dirty, so every third row wears a ●N badge — and a badge carries an
  // `.a11y-sr-only` span. The sidebar's spans are contained today (`.wt-row`
  // is positioned, so they never reach the pane); stocking the list with them
  // is what keeps the pane check below honest as these rows change.
  for (let i = 0; i < 20; i += 1) {
    repo.addWorktree(`wt/pad-${String(i).padStart(2, "0")}`, {
      dirty: i % 3 === 0
    });
  }

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "aaa-park");

  const result = await window.evaluate(() => {
    const titleTop = (): number =>
      document.querySelector(".titlebar")!.getBoundingClientRect().top;
    const appBody = document.querySelector(".app-body")!;
    // Stand in for whatever overflows: 200px of positioned box past the
    // bottom of the app, the same shape as a card placed near the window's
    // lower edge.
    const spike = document.createElement("div");
    spike.style.cssText =
      "position:absolute;left:0;top:0;width:4px;height:calc(100% + 200px);pointer-events:none";
    appBody.appendChild(spike);

    const rows = document.querySelectorAll(".wt-row");
    // Chromium scrolls a newly focused element into view too, and the last
    // row's controls are the ones below the fold.
    const controls = document.querySelectorAll<HTMLElement>(".wt-row button");
    // Each attempt starts from an un-scrolled chrome and is measured on its
    // own: leaving the previous one's offset in place would report the same
    // displacement for every mechanism after the first, and the failure would
    // name whichever ran first rather than the one that actually scrolled.
    const moved: Record<string, number> = {};
    const attempt = (name: string, act: () => void): void => {
      act();
      moved[name] = Math.max(
        Math.abs(titleTop()),
        // Read the offset while the overflow still exists: it is what the
        // titlebar's displacement is made of.
        Math.abs(document.body.scrollTop)
      );
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    attempt("spikeAlone", () => {});
    attempt("htmlScrollTop", () => {
      document.documentElement.scrollTop = 400;
    });
    attempt("bodyScrollTop", () => {
      document.body.scrollTop = 400;
    });
    // `globalThis`, not `window`: inside evaluate() the spec's own `window`
    // (the Playwright Page) shadows the browser global.
    attempt("windowScrollTo", () => globalThis.scrollTo(0, 400));
    // A reveal: the sidebar uses "nearest", the graph's locate uses "center",
    // and "center" is the one that scrolls every scrollable ancestor whether
    // the target is visible or not.
    attempt("scrollIntoView", () =>
      rows[rows.length - 1]?.scrollIntoView({ block: "center" })
    );
    attempt("focus", () => controls[controls.length - 1]?.focus());

    spike.remove();
    return {
      moved,
      // Guard against a vacuous pass: both reveals need something to act on,
      // and the hidden spans need to be on screen to be worth checking.
      reached: {
        rows: rows.length,
        controls: controls.length,
        hidden: document.querySelectorAll(".sidebar__list .a11y-sr-only").length
      },
      // The inner scrollers must still scroll — clipping the chrome is only
      // correct if the panes keep their own overflow.
      sidebarScrolls: (() => {
        const list = document.querySelector(".sidebar__list");
        if (list === null) return "missing";
        return list.scrollHeight > list.clientHeight ? "yes" : "not-overflowing";
      })()
    };
  });

  for (const [attempt, offset] of Object.entries(result.moved)) {
    expect(offset, `${attempt} scrolled the chrome`).toBe(0);
  }
  expect(result.sidebarScrolls).toBe("yes");
  expect(result.reached.rows).toBeGreaterThan(1);
  expect(result.reached.controls).toBeGreaterThan(0);
  expect(result.reached.hidden).toBeGreaterThan(0);

  // Nothing may hang out of a pane either. With the chrome clipped an escaped
  // box no longer shows itself — no symptom, no bug report — so a long,
  // hidden-span-heavy sidebar gets the same check the graph gets below.
  const panes = await paneOverflow(window);
  expect(panes.overflowing, "boxes hanging out of a pane").toEqual([]);
  expect(panes.measured).toContain(".pane--sidebar");
});

/**
 * And the overflow that started it.
 *
 * `.a11y-sr-only` is absolutely positioned with `auto` offsets, so it renders
 * at its STATIC position against the nearest positioned ancestor — and for a
 * commit's tag chip that ancestor is the pane, not the graph's scroller. The
 * hidden span therefore escaped the scroller's clip and parked itself as far
 * below the window as its commit is down the list (9,000px in the repo that
 * first showed this), and the document grew to match. Locating a tag scrolls
 * with `block: "center"`, which scrolls EVERY scrollable ancestor — so the
 * window chrome went with it.
 */
test("locating a tag deep in history leaves nothing hanging out of a pane", async () => {
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("release-history");
  const target = box.git(repo.path, "rev-parse", "HEAD");
  box.git(repo.path, "tag", "v1.0", target);
  // Bury the tagged commit: ~60 rows puts it thousands of pixels below the
  // fold, which is all the escaped span needed to inflate the document.
  for (let i = 0; i < 60; i += 1) {
    box.git(repo.path, "commit", "--allow-empty", "-m", `Development ${i + 1}`);
  }

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "release-history");
  await branchRow(window, "main").click();
  await expect(window.locator(".graph-row").first()).toBeVisible({
    timeout: 20_000
  });

  // Already expanded by addRootAndExpand above — this only needs the locator.
  const block = window.locator(".repo-block", {
    has: repoGroup(window, "release-history")
  });
  // Exact, not a prefix: /^Tags 1/ would also take "Tags 12" if the fixture
  // ever grows tags. And read the state back — e2e/AGENTS.md: sidebar
  // disclosure clicks get dropped, and without this the failure surfaces much
  // later as a missing Locate button.
  const tags = block.getByRole("button", { name: "Tags 1", exact: true });
  await tags.click();
  await expect(tags).toHaveAttribute("aria-expanded", "true");
  await block
    .getByRole("button", { name: "Locate tag v1.0 in lineage", exact: true })
    .click();
  const row = window.locator(`.graph-row[data-hash="${target}"]`);
  await expect(row).toBeInViewport();
  await expect(row.locator(".commit-tag--tag")).toHaveCount(1);
  // `behavior: smooth` — let the scroll it asked for finish before reading.
  await window.waitForTimeout(700);

  const panes = await paneOverflow(window);
  expect(panes.overflowing, "boxes hanging out of a pane").toEqual([]);
  expect(panes.measured).toContain(".pane--main");

  const after = await window.evaluate(() => ({
    titleTop: document.querySelector(".titlebar")!.getBoundingClientRect().top,
    bodyScrollTop: document.body.scrollTop
  }));
  expect(after.titleTop, "the titlebar rode up out of the window").toBe(0);
  expect(after.bodyScrollTop).toBe(0);
});
