import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandRepoGroup,
  lensChip
} from "./fixtures/steps";

/**
 * WCAG 2.1 AA behaviours that only exist in a real DOM.
 *
 * Contrast is measured from the token blocks in
 * `src/renderer/src/styles/sidebar-contrast.test.ts` — it needs no browser and
 * belongs in the unit suite. What lands here is everything that does need one:
 * whether a target is actually hit-testable at 24px, whether a key press
 * reaches the control it looks like it should reach, and whether the layout
 * survives its narrowest supported width.
 */

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
 * The rendered size of a control's pointer target.
 *
 * Sidebar controls are drawn under 24px on purpose — a 24px in-flow child
 * becomes the row's height driver (see app.css and lens-row.spec.ts) — and
 * they reach a 24px TARGET one of two ways: most are a real 24px box pulled
 * back to their drawn footprint by a negative margin, where `boundingBox()`
 * is the answer; `.wt-section__toggle` and `.wt-selbar__btn` instead grow a
 * positioned ::after, which contributes no layout and is what the browser
 * hit-tests. Take whichever is larger so the assertion is blind to which
 * mechanism a given control uses.
 */
async function targetSize(
  control: Locator
): Promise<{ width: number; height: number }> {
  return control.evaluate((el) => {
    const own = el.getBoundingClientRect();
    const after = getComputedStyle(el, "::after");
    const parse = (v: string): number => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    // `content: none` means there is no pseudo-element to widen the target.
    const hasAfter = after.content !== "none";
    return {
      width: Math.max(own.width, hasAfter ? parse(after.width) : 0),
      height: Math.max(own.height, hasAfter ? parse(after.height) : 0)
    };
  });
}

/** Does a point land on `control` (or something inside it)? */
async function hitsControl(
  window: Page,
  control: Locator,
  dx: number,
  dy: number
): Promise<boolean> {
  const box = await control.boundingBox();
  if (box === null) throw new Error("control has no box");
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  return control.evaluate(
    (el, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && (hit === el || el.contains(hit));
    },
    { x, y }
  );
}

test("sub-24px sidebar controls still expose a 24×24 pointer target", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  // Two different mechanisms reach 24px here and the assertion covers both, on
  // purpose: most of these are a real 24px box pulled back to their drawn size
  // by a negative margin, while `.wt-section__toggle` grows a ::after instead
  // (see app.css for why it can't take the margin). `targetSize` measures
  // whichever one the control actually uses.
  const repoRow = window.locator(".repo-row", { hasText: "alpha" });
  const cases: [string, Locator][] = [
    // Occupies 16×16 so it does not drive the repo row's height.
    ["repo pin", repoRow.locator(".pin")],
    // Occupy 20px in the Worktrees section head, for the same reason.
    ["worktrees refresh", window.locator(".wt-refresh").first()],
    ["sort cycle", window.locator(".sort-cycle").first()],
    // An inline-flex button around a 9px eyebrow — barely 11px drawn.
    ["worktrees toggle", window.locator(".wt-section__toggle").first()]
  ];

  for (const [what, control] of cases) {
    await expect(control, what).toBeVisible();
    const { width, height } = await targetSize(control);
    expect(Math.round(width), `${what} target width`).toBeGreaterThanOrEqual(24);
    expect(Math.round(height), `${what} target height`).toBeGreaterThanOrEqual(
      24
    );
  }

  // Measuring the box proves it is 24px; this proves the browser actually
  // routes a click there. Probe the four edge midpoints, not the corners: the
  // pin has a 6px border-radius, and hit-testing honours it — a diagonal probe
  // at ±11 lands 7.07px from the corner arc's centre and misses a 6px radius,
  // which says nothing about the target's real extent.
  const pin = repoRow.locator(".pin");
  for (const [dx, dy] of [
    [-11, 0],
    [11, 0],
    [0, -11],
    [0, 11]
  ] as const) {
    expect(
      await hitsControl(window, pin, dx, dy),
      `pin hit at ${dx},${dy}`
    ).toBe(true);
  }

  // The other half of the constraint: the targets grew, the ROWS did not.
  // lens-row.spec.ts owns these bounds; repeating them here is what makes a
  // "just make the row taller" fix fail in the spec that forbids it rather
  // than three files away.
  const repoHeight = await repoRow.evaluate(
    (el) => el.getBoundingClientRect().height
  );
  expect(repoHeight, "repo row height").toBeLessThanOrEqual(28);
  const wtHeight = await window
    .locator(".wt-row")
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(wtHeight, "worktree row height").toBeLessThanOrEqual(24);
});

test("a repo row describes the counts its label hides", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one", "feature/two"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  // `aria-label` pins the name to the repo name, which every step helper
  // depends on — but a label REPLACES the name built from contents, so the
  // "2 wts" the row also shows reached nobody. It comes back as a description.
  const repoRow = window.locator(".repo-row", { hasText: "alpha" });
  await expect(repoRow).toHaveAttribute("aria-label", "alpha");
  const describedBy = await repoRow.getAttribute("aria-describedby");
  expect(describedBy, "a repo with worktrees owes a description").not.toBeNull();
  // Linked worktrees only, matching the visible count exactly — the primary
  // checkout is the repo's own, not one of them.
  await expect(window.locator(`#${describedBy}`)).toHaveText(
    "2 linked worktrees"
  );
});

test("row keys never swallow the buttons inside the row", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  const repoRow = window.locator(".repo-row", { hasText: "alpha" });
  const pin = repoRow.getByRole("button", { name: "Pin repo" });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  const expandedBefore = await repoRow.getAttribute("aria-expanded");

  // The regression: the row's own onKeyDown ran for keydowns that bubbled up
  // from the pin, and `preventDefault()` on Enter's keydown cancels a
  // button's activation outright — so this pressed the row's disclosure and
  // the pin never fired at all.
  await pin.focus();
  await window.keyboard.press("Enter");
  await expect(
    repoRow.getByRole("button", { name: "Unpin repo" })
  ).toHaveAttribute("aria-pressed", "true");
  // ...and the row it sits in must not have toggled behind it.
  expect(await repoRow.getAttribute("aria-expanded")).toBe(expandedBefore);

  // Space activates a button on keyup, through the same cancelled-keydown
  // path, so it is a genuinely separate case rather than a rephrasing.
  await repoRow.getByRole("button", { name: "Unpin repo" }).focus();
  await window.keyboard.press(" ");
  await expect(
    repoRow.getByRole("button", { name: "Pin repo" })
  ).toHaveAttribute("aria-pressed", "false");
  expect(await repoRow.getAttribute("aria-expanded")).toBe(expandedBefore);

  // The row itself still answers those keys — the fix scopes the handler, it
  // does not remove it.
  await repoRow.focus();
  await window.keyboard.press("Enter");
  await expect(repoRow).toHaveAttribute(
    "aria-expanded",
    expandedBefore === "true" ? "false" : "true"
  );
});

test("the worktree row's hover-gated actions are reachable and visible from the keyboard", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  const row = branchRow(window, "feature/one");
  await expect(row).toBeVisible();

  // The pin cluster is `opacity: 0; pointer-events: none` at rest and is
  // revealed by `:has(:focus-visible)`. Tabbing from the row is what makes the
  // focus keyboard-originated, so the pseudo-class actually matches —
  // a programmatic focus() would not necessarily match it.
  await row.focus();
  await window.keyboard.press("Tab");

  const focused = await window.evaluate(() => {
    const el = document.activeElement;
    return el === null ? null : el.getAttribute("aria-label");
  });
  expect(focused, "Tab from a worktree row lands on its pin").toBe(
    "Pin worktree"
  );

  // Reachable is not enough — SC 2.4.7 wants it seen. The cluster must be
  // opaque while it holds focus, not invisible-but-focusable.
  await expect(row.locator(".wt-row__hoveracts")).toHaveCSS("opacity", "1");

  // And it must operate, through the same bubbled-keydown path as the repo pin.
  await window.keyboard.press("Enter");
  await expect(
    row.getByRole("button", { name: "Unpin worktree" })
  ).toBeVisible();

  // The pin and the kebab float over the same right edge, and the pin's hit
  // area is wider than the glyph it draws. The kebab renders after the strip
  // and so hit-tests above it, which means any overlap is silently won by the
  // kebab and taken out of the pin's 24px — the failure mode that left the pin
  // a 19px target once before. Assert the two boxes are disjoint.
  //
  // `getBoundingClientRect` is the whole measurement here: the pin is a real
  // 24×24 button pulled back to a 16px footprint by a negative margin, so its
  // border box IS its target. (Sibling controls in tighter rows grow a ::after
  // instead; `targetSize` above covers that shape.)
  const boxes = await row.evaluate((el) => {
    const pin = el.querySelector(".wt-row__hoveracts .pin");
    const kebab = el.querySelector(".wt-row__menu");
    if (pin === null || kebab === null) return null;
    const pinBox = pin.getBoundingClientRect();
    return {
      pinWidth: pinBox.width,
      pinRight: pinBox.right,
      kebabLeft: kebab.getBoundingClientRect().left
    };
  });
  expect(boxes, "worktree row must have both a pin and a kebab").not.toBeNull();
  expect(
    Math.round(boxes!.pinWidth),
    "the pin's own box is its target"
  ).toBeGreaterThanOrEqual(24);
  expect(
    boxes!.pinRight,
    "the pin's hit area must not run under the kebab"
  ).toBeLessThanOrEqual(boxes!.kebabLeft + 0.5);
});

test("focused rows and chips carry a real focus indicator", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  // These three suppressed the UA outline and drew an --accent-border (42%
  // accent) hairline instead: 2.27:1 against the sidebar in dark, under
  // SC 1.4.11's 3:1 for a focus state. The ratio itself is asserted in
  // sidebar-contrast.test.ts; what a browser is needed for is that an outline
  // is rendered at all, and at a width that can be seen.
  const targets: [string, Locator][] = [
    ["repo row", window.locator(".repo-row", { hasText: "alpha" })],
    ["worktree row", branchRow(window, "feature/one")],
    ["lens chip", lensChip(window, "All")]
  ];

  // `:focus-visible` is modality-sensitive: getting here took mouse clicks, and
  // after a click Chromium does not match it for a programmatic focus(). One
  // real key press flips the heuristic to keyboard for the rest of the test.
  await window.keyboard.press("Tab");

  for (const [what, target] of targets) {
    await target.focus();
    const outline = await target.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(outline.style, `${what} outline-style`).not.toBe("none");
    expect(
      Number.parseFloat(outline.width),
      `${what} outline-width`
    ).toBeGreaterThanOrEqual(2);
  }
});

test("refreshing a worktree list does not throw focus away", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  const refresh = window
    .locator(".wt-section__head")
    .getByRole("button", { name: "Refresh worktrees for alpha" });
  await expect(refresh).toBeVisible();

  // The button used to take `disabled` the instant it was activated, and
  // Chromium blurs an element the moment it becomes disabled — so activating
  // it from the keyboard dropped the user back to <body> mid-refresh. It now
  // says aria-disabled and stays focusable. Asserting the attribute is the
  // durable half: a fast refresh could finish before any focus check runs, but
  // a reintroduced `disabled` would fail this outright.
  await expect(refresh).toHaveAttribute("aria-disabled", "false");
  expect(
    await refresh.evaluate((el) => (el as HTMLButtonElement).disabled),
    "the refresh button must never use the disabled property"
  ).toBe(false);

  await refresh.focus();
  await window.keyboard.press("Enter");
  const stillFocused = await window.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? null
  );
  expect(stillFocused).toBe("Refresh worktrees for alpha");
});

test("status badges keep their glyph visible and their meaning readable", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepoBehindRemote("svc", { behindBy: 2 });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "svc");

  // ↓2 alone reached a screen reader as "2", jammed onto the end of the branch
  // name — a count whose meaning lived entirely in an arrow and a colour.
  await expect(
    window.getByRole("treeitem", { name: /2 behind upstream/ })
  ).toHaveCount(1, { timeout: 20_000 });

  // ...and the badge itself still paints exactly "↓2". The first cut of this
  // put the words INSIDE the badge, which made its textContent
  // "↓2 2 behind upstream" and broke the sync specs that read the visible
  // badge. A badge is a visual element; its text is what is painted.
  await expect(
    branchRow(window, "main").locator(".badge-text--warn")
  ).toHaveText("↓2");

  // The words are out of flow, so they must cost the row no height either —
  // the row bound lens-row.spec.ts owns still has to hold.
  const wtHeight = await branchRow(window, "main").evaluate(
    (el) => el.getBoundingClientRect().height
  );
  expect(wtHeight, "worktree row height").toBeLessThanOrEqual(24);
});

test("a worktree reorder announces the same position the row reports", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("alpha", { worktrees: ["feature/one", "feature/two"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "alpha");

  const row = branchRow(window, "feature/one");
  await expect(row).toBeVisible();
  await row.focus();
  await window.keyboard.press("Meta+Shift+ArrowDown");

  // The announcement and `aria-posinset` have to agree. They are computed from
  // two different lists — the reorder works over the reorderable worktrees,
  // which excludes the fixed primary checkout, while posinset counts every
  // treeitem in the group including it. Announcing a raw index into the former
  // told the user "2 of 3" about a row reporting "3 of 4".
  const live = window.locator("#pwrgit-live-region");
  await expect(live).toHaveText(/feature\/one moved to \d+ of \d+\./);
  const spoken = (await live.textContent()) ?? "";
  const match = /moved to (\d+) of (\d+)\./.exec(spoken);
  expect(match, `unparseable announcement: ${spoken}`).not.toBeNull();

  await expect(row).toHaveAttribute("aria-posinset", match![1]!);
  await expect(row).toHaveAttribute("aria-setsize", match![2]!);
  // And the primary is counted, so the total is more than the two rows that
  // can actually move — otherwise this passes while both sides are wrong.
  expect(Number(match![2])).toBe(3);
});

test("the sidebar reflows at its narrowest width and largest text notch", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("a-repo-with-a-genuinely-long-name", {
    worktrees: ["feature/a-long-branch-name-that-will-not-fit"]
  });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "a-repo-with-a-genuinely-long-name");

  // 240 is useColumnResize's floor; xl is the top of the text axis. SC 1.4.10
  // asks for no two-dimensional scrolling, so the list must fit its scrollport
  // horizontally however long the names are.
  await window.evaluate(() => {
    window.localStorage.setItem("pwrgit.sidebarWidth", "240");
    document.documentElement.setAttribute("data-sidebar-text", "xl");
  });
  await window.reload();
  await window.evaluate(() =>
    document.documentElement.setAttribute("data-sidebar-text", "xl")
  );
  await lensChip(window, "All").click();
  await expect(
    window.locator(".repo-row__name")
  ).toHaveCount(1, { timeout: 20_000 });
  // Expand it: the worktree rows carry the longest strings in the sidebar, so
  // a collapsed list would be the easy half of this measurement.
  await expandRepoGroup(window, "a-repo-with-a-genuinely-long-name");
  await expect(
    branchRow(window, "feature/a-long-branch-name-that-will-not-fit")
  ).toBeVisible();

  const overflow = await window.locator(".sidebar__list").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth
  }));
  expect(
    overflow.scrollWidth,
    "the sidebar list must not scroll horizontally"
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);

  // Truncation is fine; losing the text is not. The name ellipsises here, so
  // the full string has to remain available (SC 1.4.4's intent).
  await expect(window.locator(".repo-row__name")).toHaveAttribute(
    "title",
    "a-repo-with-a-genuinely-long-name"
  );
});
