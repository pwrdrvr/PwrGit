import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import { expandRepoGroup, expandWorktrees, lensChip } from "./fixtures/steps";

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
 * Does the lens row fit inside the sidebar?
 *
 * This replaces a per-chip glyph-clipping measurement. The old row was five
 * text chips in a fixed five-track grid, and the failure mode was a label
 * losing glyphs off both edges — so the guard had to measure content vs. track
 * with a Range. Icons are fixed-size, so the only thing that can go wrong now
 * is the ROW overflowing its container, which is one measurement.
 */
async function lensRowOverflow(window: Page): Promise<number> {
  return window.locator(".lens-filter").evaluate((el) => {
    const parent = el.parentElement;
    if (parent === null) return 0;
    return Math.round(
      (el.getBoundingClientRect().right - parent.getBoundingClientRect().right) *
        100
    ) / 100;
  });
}

test("the lens row fits, and names every lens for the keyboard", async () => {
  sandbox = createGitSandbox();
  // A three-digit "All" and a real "Behind" count — the pairing that used to
  // overrun the equal-width tracks.
  for (let i = 0; i < 12; i += 1) {
    sandbox.makeRepo(`repo-${String(i).padStart(2, "0")}`);
  }
  for (const name of ["behind-a", "behind-b", "behind-c"]) {
    sandbox.makeRepoBehindRemote(name, { behindBy: 2 });
  }

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(15, {
    timeout: 20_000
  });

  // Icons carry no text, so the count each label used to show has to survive in
  // the accessible name — otherwise the information is simply gone. "All" is
  // the count to assert on: it's just repos.length, whereas Behind/Stale read
  // per-worktree state that is computed lazily when a repo is expanded, so
  // they are legitimately 0 on a list nobody has opened yet.
  await expect(lensChip(window, "All")).toHaveAttribute(
    "aria-label",
    /^All \(15\)$/
  );
  // The other branch of the same logic: a lens with nothing in it carries no
  // parenthetical and no dot, so neither is decoration. Stale is the empty one
  // here — Recent now reports the full list like All, since it holds every repo
  // and was previously the only lens showing rows under no count at all.
  await expect(lensChip(window, "Stale")).toHaveAttribute("aria-label", "Stale");
  await expect(lensChip(window, "Stale").locator(".lens-chip__dot")).toHaveCount(0);
  await expect(lensChip(window, "Recent")).toHaveAttribute(
    "aria-label",
    /^Recent \(15\)$/
  );
  await expect(lensChip(window, "All").locator(".lens-chip__dot")).toHaveCount(1);
  // The active lens still spells its count out.
  await expect(window.locator(".lens-filter__count")).toHaveText("15");

  expect(await lensRowOverflow(window)).toBeLessThanOrEqual(0);
});

test("the lens row survives the narrowest sidebar at the largest text size", async () => {
  sandbox = createGitSandbox();
  for (let i = 0; i < 12; i += 1) {
    sandbox.makeRepo(`repo-${String(i).padStart(2, "0")}`);
  }

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(12, {
    timeout: 20_000
  });

  // 240 is useColumnResize's floor. Combined with the largest text notch this
  // is the case the OLD row could not survive at all: its own CSS note recorded
  // "Pinned 13" clearing by ~0.5px at 320px, so one notch overflowed it. Icons
  // don't read the type scale, which is the whole point of the change.
  await window.evaluate(() => {
    window.localStorage.setItem("pwrgit.sidebarWidth", "240");
    document.documentElement.setAttribute("data-sidebar-text", "xl");
  });
  await window.reload();
  await window.evaluate(() =>
    document.documentElement.setAttribute("data-sidebar-text", "xl")
  );
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(12, {
    timeout: 20_000
  });

  // The names did grow — otherwise this asserts nothing about the notch.
  const nameSize = await window
    .locator(".repo-row__name")
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(nameSize).toBe("15px");

  expect(await lensRowOverflow(window)).toBeLessThanOrEqual(0);
});

test("sidebar rows are sized by their content, not by a fixed box", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("dense", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  const repoRow = window.locator(".repo-row", { hasText: "dense" });
  await expect(repoRow).toBeVisible({ timeout: 20_000 });

  // The point of content-sizing is that the row tracks its type. Guarding the
  // rendered height is the only way to catch the failure that actually
  // happened: `height` was removed, but a fixed 24px pin button silently
  // became the new floor, so the row stayed ~32px and the density work bought
  // nothing. Shrinking it to 20px still left the pin in charge at 30px.
  //
  // The floor here is arithmetic, not taste: a 13px name at line-height 1.25
  // is 16.25px, plus 4px padding top and bottom and a 1px border, so ~26px is
  // as short as Comfortable goes at the default notch. 28 leaves room for host
  // font rounding while still catching a fixed-size child (pin, badge, kebab)
  // taking the row over — the first two cuts of this change stalled at 32px
  // and 30px exactly that way, and a looser bound waved one of them through.
  const repoHeight = await repoRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(repoHeight).toBeLessThanOrEqual(28);

  // Worktree rows have the same trap in a different child — the 24px kebab —
  // so guard them too. 11px mono at 1.25 is 13.75, + 3px padding each side + 2
  // border ≈ 22; 24 is the rounding allowance.
  await expandRepoGroup(window, "dense");
  await expandWorktrees(window, "dense");
  const wtRow = window.locator(".wt-row").first();
  await expect(wtRow).toBeVisible();
  const wtHeight = await wtRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(wtHeight).toBeLessThanOrEqual(24);

  // Compact is the tight setting; Comfortable is not. Both must move.
  await window.evaluate(() =>
    document.documentElement.setAttribute("data-density", "compact")
  );
  const compactRepo = await repoRow.evaluate((el) => el.getBoundingClientRect().height);
  const compactWt = await wtRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(compactRepo).toBeLessThan(repoHeight);
  expect(compactWt).toBeLessThan(wtHeight);
  await window.evaluate(() =>
    document.documentElement.removeAttribute("data-density")
  );

  // And it must actually GROW with the axis — a row that ignores the notch
  // would also pass the bound above.
  await window.evaluate(() =>
    document.documentElement.setAttribute("data-sidebar-text", "xl")
  );
  const grown = await repoRow.evaluate((el) => el.getBoundingClientRect().height);
  expect(grown).toBeGreaterThan(repoHeight);
});

test("every lens shares one left edge — the Pinned grip must not indent its rows", async () => {
  sandbox = createGitSandbox();
  for (const name of ["alpha", "bravo"]) sandbox.makeRepo(name);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(2, {
    timeout: 20_000
  });
  const nameLeft = async (): Promise<number> =>
    window
      .locator(".repo-row__name", { hasText: "alpha" })
      .evaluate((el) => el.getBoundingClientRect().left);
  const allLeft = await nameLeft();

  // Pin both and switch lens. The Pinned lens renders a drag grip that the
  // others don't; it is invisible at rest, but it used to be an in-flow flex
  // child, so it shifted every Pinned row's content right by its width and the
  // list read as indented next to Recent. Out of flow, the edges agree.
  for (const name of ["alpha", "bravo"]) {
    await window.locator(".repo-row", { hasText: name }).locator(".pin").click();
  }
  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(2);
  const pinnedLeft = await nameLeft();
  expect(Math.abs(pinnedLeft - allLeft)).toBeLessThanOrEqual(0.5);
});

test("a long ref-list branch name ellipsises instead of hard-clipping", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("refs-overflow");
  repo.createBranch("feature/a-branch-name-far-wider-than-the-sidebar-can-show");

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, "refs-overflow");
  await window.getByRole("button", { name: /^Branches/ }).first().click();

  // The name span is a child of an inline-FLEX wrapper (it sits beside the
  // hover-revealed copy glyph). `text-overflow` does nothing on a flex
  // container, so when the name was a bare text node it clipped mid-glyph into
  // the status label — no ellipsis, no gutter. The fix gives the text its own
  // flex item; assert on the item, since that is where the property has to land.
  const name = window
    .locator(".ref-branch-row__name .refs-copyable-name__text")
    .filter({ hasText: "a-branch-name-far-wider" });
  await expect(name).toBeVisible({ timeout: 15_000 });

  const box = await name.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      display: style.display,
      textOverflow: style.textOverflow,
      overflows: el.scrollWidth > el.clientWidth
    };
  });
  // If it does not overflow, the test proves nothing — widen the branch name.
  expect(box.overflows).toBe(true);
  expect(box.textOverflow).toBe("ellipsis");
  // `flex`/`inline-flex` here is the regression: the property would be inert.
  expect(box.display).not.toContain("flex");
});

test("the selected worktree row clears BOTH sticky bars when grouped", async () => {
  sandbox = createGitSandbox();
  const repo = sandbox.makeRepo("grouped");
  for (let i = 0; i < 12; i += 1) repo.addWorktree(`feature/w-${i}`);
  // A second root is what turns group-by-folder on (it needs roots.length > 1),
  // and it is on by default from there.
  const otherRoot = sandbox.worktreeRoot;
  sandbox.git(otherRoot, "init", "-b", "main", "elsewhere");
  sandbox.commit(join(otherRoot, "elsewhere"), "README.md", "# elsewhere");

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectories([sandbox.reposDir, otherRoot]);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-group__head")).not.toHaveCount(0, {
    timeout: 20_000
  });
  await expandRepoGroup(window, "grouped");
  await expandWorktrees(window, "grouped");

  const row = window.locator(".wt-row", { hasText: "feature/w-1" }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(row).toHaveClass(/is-selected/);

  // Scroll far enough that the row would have left the viewport unaided. The
  // selected row is sticky so the active worktree stays reachable down a long
  // list — but the offset only cleared the repo header, and grouped there is a
  // 28px folder heading above THAT. The row parked at the header's top edge and
  // both opaque bars (z-index 4 and 5, against the row's 2) painted straight
  // over it: it vanished completely rather than staying put.
  await window.locator(".sidebar__list").evaluate((el) => {
    el.scrollTop = 300;
  });
  await window.waitForTimeout(300);

  const geom = await window.evaluate(() => {
    const rect = (s: string): DOMRect | null =>
      document.querySelector(s)?.getBoundingClientRect() ?? null;
    return {
      repoRow: rect(".repo-group .repo-row"),
      selected: rect(".wt-row.is-selected")
    };
  });
  expect(geom.repoRow).not.toBeNull();
  expect(geom.selected).not.toBeNull();
  const repoRow = geom.repoRow as DOMRect;
  const selected = geom.selected as DOMRect;
  // The whole point: it sits BELOW the repo header, not under it.
  expect(selected.top).toBeGreaterThanOrEqual(repoRow.bottom - 0.5);
});

test("the repo row counts linked worktrees only, and hides a zero", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("bare-checkout");
  sandbox.makeRepo("has-two", { worktrees: ["feature/a", "feature/b"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(2, {
    timeout: 20_000
  });

  // The primary checkout is the repo's own directory, not a worktree someone
  // added — counting it made every repo claim one more than it has.
  const bare = window.locator(".repo-row", { hasText: "bare-checkout" });
  await expect(bare.locator(".repo-row__wtcount")).toHaveCount(0);

  const two = window.locator(".repo-row", { hasText: "has-two" });
  await expect(two.locator(".repo-row__wtcount")).toHaveText("2 wts");
});

test("the section headings account for every worktree the repo row claims", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("split", {
    worktrees: ["feature/pinned-one", "feature/plain-one", "feature/plain-two"]
  });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, "split");
  await expandWorktrees(window, "split");

  const row = window.locator(".repo-row", { hasText: "split" });
  await expect(row.locator(".repo-row__wtcount")).toHaveText("3 wts");
  // Nothing pinned yet, so the single disclosure holds all three and matches.
  await expect(
    window.getByRole("button", { name: /^Worktrees 3/ })
  ).toBeVisible();
  await expect(window.locator(".wt-subhead")).toHaveCount(0);

  // Pin one. It moves into the elevated block, which now names itself — the
  // regression this guards is the old "Worktrees 0" sitting under visible rows.
  const pinned = window.locator(".wt-row", { hasText: "feature/pinned-one" });
  await expect(async () => {
    await pinned.hover();
    await pinned
      .getByRole("button", { name: "Pin worktree" })
      .click({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  await expect(window.locator(".wt-subhead")).toHaveCount(1);
  await expect(window.locator(".wt-subhead")).toContainText("Pinned");
  await expect(window.locator(".wt-subhead .ref-section__count")).toHaveText("1");
  await expect(
    window.getByRole("button", { name: /^Other worktrees 2/ })
  ).toBeVisible();
  // 1 + 2 = the 3 the repo row still claims.
  await expect(row.locator(".repo-row__wtcount")).toHaveText("3 wts");
});

test("the worktree row reserves no lane for the kebab", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("roomy", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, "roomy");
  await expandWorktrees(window, "roomy");

  const row = window.locator(".wt-row", { hasText: "feature/one" });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // 31px of every row was held for a kebab that is invisible at rest — 13% of
  // the row at the 240px minimum, taken from the only field that shrinks. The
  // actions float over the row's tail on hover instead, so the resting reserve
  // should now be single-digit.
  const padRight = await row.evaluate((el) =>
    parseFloat(getComputedStyle(el).paddingRight)
  );
  expect(padRight).toBeLessThanOrEqual(10);

  // And the strip that replaced it must actually be opaque, or the branch name
  // reads straight through the buttons floating over it.
  const backdrop = await row
    .locator(".wt-row__hoveracts")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(backdrop).toContain("gradient");

  // The strip spans the row's whole right edge now, so it must stay
  // click-through: only the button inside it takes pointer events. Otherwise it
  // swallows clicks meant for what it floats over — the PR chip is a real
  // role="button" sitting in exactly that slot.
  await row.hover();
  const events = await row.evaluate((el) => ({
    strip: getComputedStyle(
      el.querySelector(".wt-row__hoveracts") as Element
    ).pointerEvents,
    pin: getComputedStyle(
      el.querySelector(".wt-row__hoveracts .pin") as Element
    ).pointerEvents
  }));
  expect(events.strip).toBe("none");
  expect(events.pin).toBe("auto");
});

test("the worktree row's pin keeps a full target under the kebab", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("targets-wt", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, "targets-wt");
  await expandWorktrees(window, "targets-wt");

  const row = window.locator(".wt-row", { hasText: "feature/one" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();

  // The pin's border box bleeds 4px right of its margin box (that negative
  // margin is how a 24px target occupies 16px), and the kebab hit-tests above
  // it as a later absolutely-positioned sibling. If the strip's right padding
  // does not clear the kebab's lane, the kebab silently eats part of the pin —
  // which is how the WCAG 2.5.8 fix would end up not applying to this row.
  const geom = await row.evaluate((el) => {
    const pin = el
      .querySelector(".wt-row__hoveracts .pin")!
      .getBoundingClientRect();
    const kebab = el.querySelector(".wt-row__menu")!.getBoundingClientRect();
    return { pinW: pin.width, pinH: pin.height, pinRight: pin.right, kebabLeft: kebab.left };
  });
  expect(geom.pinW).toBeGreaterThanOrEqual(24);
  expect(geom.pinH).toBeGreaterThanOrEqual(24);
  expect(geom.pinRight).toBeLessThanOrEqual(geom.kebabLeft + 0.5);
});

test("row focus is a solid ring, not a 12%-alpha whisper", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("focusable", { worktrees: ["feature/one"] });
  sandbox.makeRepo("neighbour");

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  const row = window.locator(".repo-row", { hasText: "focusable" });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // These rows carry the roving tabindex, so they are the primary keyboard
  // target — and they had the weakest indicator in the sidebar (≈2.27:1,
  // under WCAG 2.4.11's 3:1) while small chrome buttons got a solid one.
  //
  // Arrow down and back rather than just calling focus(): `:focus-visible`
  // keys off the last INPUT MODALITY, and a bare programmatic focus with no
  // preceding key press leaves it at "pointer", so the rule under test simply
  // does not apply and every assertion below reads the unfocused values. The
  // round trip also lands focus through the roving tabindex, which is how a
  // user actually gets here.
  await row.focus();
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("ArrowUp");
  await expect(row).toBeFocused();

  const ring = await row.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor };
  });
  expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  expect(ring.style).toBe("solid");
  // --focus-ring is --accent at full strength; a transparent-ish ring is the
  // regression.
  expect(ring.color).not.toContain("rgba(0, 0, 0, 0)");
});

test("the row controls clear the 24px pointer-target floor", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("targets", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, "targets");

  // WCAG 2.5.8. Each of these is a 24px button collapsed by negative margins so
  // layout still sees a small box — measure the BORDER box, which is what the
  // pointer hits, not the space it occupies.
  for (const selector of [".repo-row .pin", ".wt-refresh", ".sort-cycle"]) {
    const box = await window
      .locator(selector)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
    expect(box.w, `${selector} width`).toBeGreaterThanOrEqual(24);
    expect(box.h, `${selector} height`).toBeGreaterThanOrEqual(24);
  }

  // …and collapsing them must not have grown the rows the density pass tuned.
  const repoHeight = await window
    .locator(".repo-row", { hasText: "targets" })
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(repoHeight).toBeLessThanOrEqual(28);
});

test("Recent and All are no longer the same list", async () => {
  sandbox = createGitSandbox();
  // Alphabetically zulu is last; by activity it is first.
  const zulu = sandbox.makeRepo("zulu");
  sandbox.makeRepo("alpha");
  sandbox.makeRepo("mike");
  sandbox.commitEmptyAt(zulu.path, "recent work", 1_800_000_000);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3, {
    timeout: 20_000
  });

  // All is the index: position follows name, and pinning must not move it.
  expect(await window.locator(".repo-row__name").allTextContents()).toEqual([
    "alpha",
    "mike",
    "zulu"
  ]);
  await window.locator(".repo-row", { hasText: "zulu" }).locator(".pin").click();
  expect(await window.locator(".repo-row__name").allTextContents()).toEqual([
    "alpha",
    "mike",
    "zulu"
  ]);
});

test("selecting a worktree row does not move it", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("steady", { worktrees: ["feature/one"] });

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expandRepoGroup(window, "steady");
  await expandWorktrees(window, "steady");

  // The selected row is `position: sticky` so it stays visible under the repo
  // header while a long list scrolls. Its `top` used to be a literal 36px —
  // the header's OLD fixed height. Once the header became content-sized, a
  // row that sat closer than 36px to the scrollport was shoved down to 36 the
  // moment it was selected, so the row (and its icon) visibly jumped. The
  // offset now derives from the header token; this pins that.
  const row = window.locator(".wt-row", { hasText: "feature/one" });
  await expect(row).toBeVisible();
  const before = await row.evaluate((el) => el.getBoundingClientRect().top);
  await row.click();
  await expect(row).toHaveClass(/is-selected/);
  const after = await row.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(0.5);
});
