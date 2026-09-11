import { expect, test } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandRepoGroup
} from "./fixtures/steps";

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
  for (let i = 0; i < 20; i += 1) {
    repo.addWorktree(`wt/pad-${String(i).padStart(2, "0")}`);
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

    const tops: Record<string, number> = { spiked: titleTop() };
    document.documentElement.scrollTop = 400;
    tops["htmlScrollTop"] = titleTop();
    document.body.scrollTop = 400;
    tops["bodyScrollTop"] = titleTop();
    // `globalThis`, not `window`: inside evaluate() the spec's own `window`
    // (the Playwright Page) shadows the browser global.
    globalThis.scrollTo(0, 400);
    tops["windowScrollTo"] = titleTop();
    // A reveal: the sidebar uses "nearest", the graph's locate uses "center",
    // and "center" is the one that scrolls every scrollable ancestor whether
    // the target is visible or not.
    const rows = document.querySelectorAll(".wt-row");
    rows[rows.length - 1]?.scrollIntoView({ block: "center" });
    tops["scrollIntoView"] = titleTop();
    // Chromium scrolls a newly focused element into view too, and the last
    // row's controls are the ones below the fold.
    const controls = document.querySelectorAll<HTMLElement>(".wt-row button");
    controls[controls.length - 1]?.focus();
    tops["focus"] = titleTop();

    // Read the offset while the overflow still exists: removing the spike
    // clamps it, which would make a scrolled chrome look innocent.
    const bodyScrollTop = document.body.scrollTop;
    spike.remove();
    return {
      tops,
      bodyScrollTop,
      // Guard against a vacuous pass: both reveals need something to act on.
      reached: { rows: rows.length, controls: controls.length },
      // The inner scrollers must still scroll — clipping the chrome is only
      // correct if the panes keep their own overflow.
      sidebarScrolls: (() => {
        const list = document.querySelector(".sidebar__list");
        if (list === null) return "missing";
        return list.scrollHeight > list.clientHeight ? "yes" : "not-overflowing";
      })()
    };
  });

  for (const [attempt, top] of Object.entries(result.tops)) {
    expect(top, `${attempt} moved the titlebar`).toBe(0);
  }
  expect(result.bodyScrollTop).toBe(0);
  expect(result.sidebarScrolls).toBe("yes");
  expect(result.reached.rows).toBeGreaterThan(1);
  expect(result.reached.controls).toBeGreaterThan(0);
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
  test.setTimeout(90_000);
  sandbox = createGitSandbox();
  const box = sandbox;
  const repo = box.makeRepo("release-history");
  const target = box.git(repo.path, "rev-parse", "HEAD");
  box.git(repo.path, "tag", "v1.0", target);
  // Bury the tagged commit: its row is ~150 rows down the graph, which is
  // exactly how far below the window the hidden span used to sit.
  for (let i = 0; i < 150; i += 1) {
    box.git(repo.path, "commit", "--allow-empty", "-m", `Development ${i + 1}`);
  }

  handle = await launchApp({ worktreeRoot: box.worktreeRoot });
  const { window } = handle;
  await addRootAndExpand(window, handle, box, "release-history");
  await branchRow(window, "main").click();
  await expect(window.locator(".graph-row").first()).toBeVisible({
    timeout: 20_000
  });

  const group = await expandRepoGroup(window, "release-history");
  const block = window.locator(".repo-block", { has: group });
  const tags = block.getByRole("button", { name: /^Tags 1/ });
  await tags.click();
  await block
    .getByRole("button", { name: "Locate tag v1.0 in lineage", exact: true })
    .click();
  const row = window.locator(`.graph-row[data-hash="${target}"]`);
  await expect(row).toBeInViewport();
  await expect(row.locator(".commit-tag--tag")).toHaveCount(1);
  // `behavior: smooth` — let the scroll it asked for finish before reading.
  await window.waitForTimeout(700);

  const after = await window.evaluate(() => ({
    titleTop: document.querySelector(".titlebar")!.getBoundingClientRect().top,
    bodyScrollTop: document.body.scrollTop,
    // Nothing may hang out of a pane: `scrollHeight` on a box that is not a
    // scroll container still reports the scrollable overflow its descendants
    // produced, which is precisely what the escaped span inflated.
    escaped: [".pane--sidebar", ".pane--main", ".pane--rail", ".app-body"]
      .map((sel) => {
        const el = document.querySelector(sel);
        if (el === null) return `${sel}: missing`;
        const over = el.scrollHeight - el.clientHeight;
        return over > 0 ? `${sel}: +${over}px` : "";
      })
      .filter((entry) => entry !== "")
  }));

  expect(after.escaped, "boxes hanging out of a pane").toEqual([]);
  expect(after.titleTop, "the titlebar rode up out of the window").toBe(0);
  expect(after.bodyScrollTop).toBe(0);
});
