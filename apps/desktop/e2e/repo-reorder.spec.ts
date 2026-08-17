import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";
import {
  addRootAndExpand,
  branchRow,
  expandRepoGroup,
  lensChip
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

const repoNames = (window: Page): Promise<string[]> =>
  window.locator(".repo-row__name").allTextContents();

/** Three pinned repos, shown in the Pinned lens in name order. */
async function pinnedSandbox(): Promise<Page> {
  sandbox = createGitSandbox();
  for (const name of ["alpha", "bravo", "charlie"]) sandbox.makeRepo(name);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3, {
    timeout: 20_000
  });

  // Pin all three from the All lens, where the star is always shown.
  for (const name of ["alpha", "bravo", "charlie"]) {
    await window
      .locator(".repo-row", { hasText: name })
      .locator(".pin")
      .click();
  }
  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);
  expect(await repoNames(window)).toEqual(["alpha", "bravo", "charlie"]);
  return window;
}

test("dragging a pinned repo to the end of the list reorders it", async () => {
  const window = await pinnedSandbox();

  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  const charlie = window.locator(".repo-row", { hasText: "charlie" });
  const box = await charlie.boundingBox();
  if (box === null) throw new Error("charlie row has no box");

  // Aim at charlie's LOWER half — the "after" position. Before the drop
  // gained a position, no gesture could put a row past the last one.
  await alpha.hover();
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 12
  });

  // Mid-drag: the source is dimmed and the insertion line is under charlie.
  await expect(alpha).toHaveClass(/is-dragging/);
  await expect(charlie).toHaveClass(/is-drop-after/);
  await window
    .locator(".sidebar__list")
    .screenshot({ path: test.info().outputPath("mid-drag-insertion-line.png") });

  await window.mouse.up();

  expect(await repoNames(window)).toEqual(["bravo", "charlie", "alpha"]);

  // The pinned state remains visible after the drag; wait for that state before
  // capturing so the screenshot also covers the persistent star treatment.
  const charliePin = window
    .locator(".repo-row", { hasText: "charlie" })
    .locator(".pin");
  await expect(charliePin).toHaveCSS("opacity", "1");
  await expect(charliePin).toHaveAttribute("aria-pressed", "true");
  await window
    .locator(".sidebar__list")
    .screenshot({ path: test.info().outputPath("after-drop.png") });
});

test("dragging a repo row selects no text", async () => {
  const window = await pinnedSandbox();

  // The original complaint: a drag in the sidebar painted a text selection
  // across every row it crossed instead of moving anything.
  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  const charlie = window.locator(".repo-row", { hasText: "charlie" });
  const box = await charlie.boundingBox();
  if (box === null) throw new Error("charlie row has no box");

  await alpha.hover();
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 12
  });
  // `document.getSelection`, not `window.getSelection` — `window` here is the
  // Playwright Page, not the page's global object.
  const selected = await window.evaluate(() =>
    (document.getSelection()?.toString() ?? "").trim()
  );
  await window.mouse.up();

  expect(selected).toBe("");
});

test("⌘⇧↓ moves a pinned repo without the mouse", async () => {
  const window = await pinnedSandbox();

  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  await alpha.focus();
  await window.keyboard.press("Meta+Shift+ArrowDown");

  expect(await repoNames(window)).toEqual(["bravo", "alpha", "charlie"]);

  // And the row keeps focus, so a second press keeps moving the same repo
  // rather than whatever slid into the vacated slot.
  await window.keyboard.press("Meta+Shift+ArrowDown");
  expect(await repoNames(window)).toEqual(["bravo", "charlie", "alpha"]);
});

test("the computed lenses stay computed — no drag handle outside Pinned", async () => {
  const window = await pinnedSandbox();
  await expect(
    window.locator(".repo-row").first()
  ).toHaveClass(/is-arrangeable/);

  await lensChip(window, "All").click();
  await expect(window.locator(".repo-row__name")).toHaveCount(3);
  await expect(window.locator(".repo-row.is-arrangeable")).toHaveCount(0);
  await expect(window.locator(".repo-row__handle")).toHaveCount(0);
});

test("the drag grip clears the caret, and stays inside the scrollport", async () => {
  const window = await pinnedSandbox();

  const row = window.locator(".repo-row", { hasText: "alpha" });
  await row.hover();
  await expect(row.locator(".repo-row__handle")).toHaveCSS("opacity", "1");

  // Measure the DOTS, not the <svg> box: the box carries ~0.7px of slack each
  // side, and what a reader sees collide is the ink. `.chev` needs no such care
  // — it is a 0×0 border triangle, so its border box IS the caret.
  type Geom = {
    gap: number;
    inkLeft: number;
    rowLeft: number;
    listLeft: number;
    /* The rotation's sine: 0 collapsed, 1 open, anything between means the
       140ms transition is still running. */
    rotation: number;
    /* The borrow-and-give-back pair, read off the cascade rather than assumed. */
    padLeft: number;
    padRight: number;
    chevMargin: number;
    /* The caret's centre against the spine `.wt-section` drops beneath it. */
    chevCentre: number;
  };
  const measure = async (): Promise<Geom> =>
    row.evaluate((el) => {
      const grip = el.querySelector(".repo-row__handle svg");
      if (grip === null) throw new Error("row has no grip");
      const chev = el.querySelector(".chev");
      if (chev === null) throw new Error("row has no caret");
      const list = el.closest(".sidebar__list");
      if (list === null) throw new Error("row is outside the scrollport");
      const box = grip.getBoundingClientRect();
      // getBBox is the union of the circles in viewBox units; the glyph is
      // rendered 1:1, but scale anyway so a resized grip still measures true.
      const ink = (grip as SVGSVGElement).getBBox();
      const units = (grip as SVGSVGElement).viewBox.baseVal.width;
      if (units === 0) throw new Error("grip svg has no viewBox to scale by");
      const scale = box.width / units;
      const chevBox = chev.getBoundingClientRect();
      const chevStyle = getComputedStyle(chev);
      const rowStyle = getComputedStyle(el);
      return {
        gap: chevBox.left - (box.left + (ink.x + ink.width) * scale),
        inkLeft: box.left + ink.x * scale,
        rowLeft: el.getBoundingClientRect().left,
        // The scrollport clips: `overflow-y: auto` makes overflow-x `auto` too,
        // so anything left of its padding box is cut off rather than drawn.
        listLeft: list.getBoundingClientRect().left,
        // matrix(a, b, c, d, …) — `b` is sin(angle), so 90° reads 1.
        rotation: Math.abs(
          Number.parseFloat(
            (chevStyle.transform.match(/matrix\(([^,]+),\s*([^,]+)/)?.[2] ??
              "0").trim()
          )
        ),
        padLeft: Number.parseFloat(rowStyle.paddingLeft),
        padRight: Number.parseFloat(rowStyle.paddingRight),
        chevMargin: Number.parseFloat(chevStyle.marginRight),
        chevCentre: chevBox.left + chevBox.width / 2
      };
    });

  // The caret rotates over 140ms, and mid-flight its axis-aligned box is WIDER
  // than at either end — a tilted rectangle bounds larger than a square-on one.
  // Measuring during the transition reads a collision that is not there.
  const settled = async (): Promise<Geom> => {
    let previous = await measure();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await window.waitForTimeout(50);
      const next = await measure();
      if (Math.abs(next.gap - previous.gap) < 0.01) return next;
      previous = next;
    }
    throw new Error("the caret never stopped moving");
  };

  // The bug: a 9px grip seated in 8px of padding put its right dot column on
  // top of the caret's left edge. 1px is the floor, not the target — the CSS
  // aims for 2.7px here, so this fails on a re-collision, not on a nudge.
  const collapsed = await settled();
  expect(collapsed.gap).toBeGreaterThanOrEqual(1);

  // The invariant the whole fix rests on, and the one no other spec can see:
  // lens-row.spec.ts only compares the name's edge BETWEEN lenses, and both
  // rules here apply to every lens, so a uniform shift passes it. The caret's
  // negative margin has to return exactly what the grip column borrowed —
  // i.e. the name lands where a symmetrically-padded row would put it.
  expect(collapsed.padLeft + collapsed.chevMargin).toBeCloseTo(
    collapsed.padRight,
    1
  );

  // Open, the caret is that triangle rotated 90°, so its box grows 1.5px to the
  // LEFT: the tighter of the two states, and the one a fix measured against the
  // collapsed row would miss.
  await expandRepoGroup(window, "alpha");
  await row.hover();
  await expect(row.locator(".repo-row__handle")).toHaveCSS("opacity", "1");
  const open = await settled();
  // Proves the settled read caught the OPEN state rather than a pre-transition
  // frame. Asserted on the rotation itself: comparing the two gaps instead
  // would encode that `.chev` is taller than it is wide, which is incidental.
  expect(open.rotation).toBeCloseTo(1, 2);
  expect(open.gap).toBeGreaterThanOrEqual(1);

  // It must not have been shoved out of the scrollport to clear the caret.
  expect(open.inkLeft).toBeGreaterThanOrEqual(open.listLeft);

  // Expanded, `.wt-section` drops a 1px spine that should descend from the
  // caret that opened it — the alignment the grip column was tuned around.
  const spineCentre = await window
    .locator(".wt-section")
    .first()
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return (
        rect.left + Number.parseFloat(getComputedStyle(el).borderLeftWidth) / 2
      );
    });
  expect(open.chevCentre).toBeCloseTo(spineCentre, 0);

  // The column's other bound, and it can only be measured with the ring
  // actually painted. `:focus-visible` keys off the last input modality, so a
  // bare focus() after a pointer-driven setup leaves `outline-width` computing
  // to 0px and every bound below reads as trivially satisfied — the trap
  // lens-row.spec.ts documents. Arrow down and back is how that spec gets a
  // real ring, and it lands focus through the roving tabindex besides.
  await row.focus();
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("ArrowUp");
  await expect(row).toBeFocused();
  const focused = await row.evaluate((el) => {
    const grip = el.querySelector(".repo-row__handle svg");
    if (grip === null) throw new Error("row has no grip");
    const style = getComputedStyle(el);
    const ink = (grip as SVGSVGElement).getBBox();
    const box = grip.getBoundingClientRect();
    const scale = box.width / (grip as SVGSVGElement).viewBox.baseVal.width;
    return {
      // A solid outline at offset -width paints flush INSIDE the border box,
      // so this is exactly how far into the row the ring reaches.
      ring: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
      inkLeft: box.left + ink.x * scale,
      rowLeft: el.getBoundingClientRect().left
    };
  });
  // If the ring is not actually painted the bound below proves nothing, so
  // assert the state before asserting against it.
  expect(focused.ring).toBeGreaterThan(0);
  expect(focused.offset).toBeCloseTo(-focused.ring, 1);
  expect(focused.inkLeft).toBeGreaterThanOrEqual(
    focused.rowLeft + focused.ring
  );
});

test("the sidebar tree exposes valid, nested roles", async () => {
  const window = await pinnedSandbox();

  // Repo rows are treeitems at level 1 inside the tree — not `option`, which
  // only means anything inside a listbox.
  //
  // The tree is `.sidebar__tree`, INSIDE the `.sidebar__list` scrollport
  // rather than being it. A `tree` may only own `treeitem` and `group`
  // children, and the scrollport also holds the empty state — so while the
  // role sat on the scrollport, non-treeitem content was a direct child of the
  // tree and the structure was invalid.
  const tree = window.locator('.sidebar__tree[role="tree"]');
  await expect(tree).toHaveCount(1);
  await expect(tree.locator('.repo-row[role="treeitem"]')).toHaveCount(3);
  await expect(window.locator('[role="option"]')).toHaveCount(0);

  // Nothing but rows and folder groups may be a child of the tree. Asserted
  // structurally rather than by naming the controls that used to sit there:
  // "Add folders…" has since moved up beside Clone, and the next thing added
  // to the scrollport should fail this without needing the test edited.
  const strayChildren = await tree.evaluate((el) =>
    [...el.children]
      .filter((child) => {
        const role = child.getAttribute("role");
        return role !== "group" && !child.classList.contains("repo-block");
      })
      .map((child) => child.className)
  );
  expect(strayChildren, "only rows and groups belong inside the tree").toEqual(
    []
  );

  // Position is stated rather than left to be inferred: folder buckets wrap
  // rows in groups, and every expanded repo drops a sibling section between
  // two rows that `aria-owns` then re-parents.
  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  await expect(alpha).toHaveAttribute("aria-posinset", "1");
  await expect(alpha).toHaveAttribute("aria-setsize", "3");
  await expect(
    window.locator(".repo-row", { hasText: "charlie" })
  ).toHaveAttribute("aria-posinset", "3");

  // The row's name stays the repo name — every step helper resolves rows by it.
  await expect(alpha).toHaveAttribute("aria-label", "alpha");
  // These sandbox repos have no linked worktrees, are not behind, and are
  // pinned in their own right, so there is nothing the row shows that its name
  // does not already say. It must then carry no description at all rather than
  // pointing at an empty one. (The populated case is covered in
  // a11y-sidebar.spec.ts, on a repo that actually has worktrees.)
  expect(await alpha.getAttribute("aria-describedby")).toBeNull();

  // Expanding a repo adds a group of level-2 treeitems, owned by the repo row
  // (the section is a DOM sibling, so ownership is explicit via aria-owns).
  await alpha.click();
  const group = window.locator('.wt-section[role="group"]');
  await expect(group).toHaveCount(1);
  const worktrees = group.locator('.wt-row[role="treeitem"]');
  await expect(worktrees).not.toHaveCount(0);
  const owns = await alpha.getAttribute("aria-owns");
  expect(owns).toBe(await group.getAttribute("id"));

  // Level-2 rows carry their own position within that group.
  await expect(worktrees.first()).toHaveAttribute("aria-posinset", "1");
  await expect(worktrees.first()).toHaveAttribute(
    "aria-setsize",
    String(await worktrees.count())
  );

  // The refs disclosures inside the group are buttons that open and close, so
  // they have to say which they are — these two carried a rotating caret and
  // nothing else.
  for (const section of ["Branches", "Remotes"]) {
    await expect(
      window.getByRole("button", { name: new RegExp(`^${section}`) }).first()
    ).toHaveAttribute("aria-expanded", "false");
  }
});

test("a dragged row is marked without its text being dimmed", async () => {
  const window = await pinnedSandbox();

  const alpha = window.locator(".repo-row", { hasText: "alpha" });
  const charlie = window.locator(".repo-row", { hasText: "charlie" });
  const box = await charlie.boundingBox();
  if (box === null) throw new Error("charlie row has no box");

  await alpha.hover();
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, {
    steps: 12
  });
  await expect(alpha).toHaveClass(/is-dragging/);

  // The source row used to be painted at `opacity: 0.4`, which took its own
  // text to 2.29:1 (branch) and 1.48:1 (count) — SC 1.4.3 does not exempt a
  // state for being transient, and no opacity that still reads as a fade
  // clears 4.5:1 for the quiet tier. It is marked on its own surface instead.
  const dragged = await alpha.evaluate((el) => {
    const s = getComputedStyle(el);
    return { opacity: s.opacity, borderStyle: s.borderTopStyle };
  });
  expect(dragged.opacity, "the drag source must not be faded").toBe("1");
  expect(dragged.borderStyle).toBe("dashed");

  await window.mouse.up();
});

test("⌘⇧↓ announces where the row landed", async () => {
  const window = await pinnedSandbox();

  // The region has to be in the DOM and EMPTY before anything is said: a
  // screen reader registers a live region when it lands in the accessibility
  // tree, and a region that appears and speaks in the same breath routinely
  // goes unheard — which would have made the first reorder of a session the
  // one that got no feedback.
  const live = window.locator("#pwrgit-live-region");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveText("");

  // The gesture deliberately keeps focus on the row that moved, so nothing is
  // re-announced on its own and the reorder is silent to a screen reader
  // (SC 4.1.3). The region is what says what happened.
  await window.locator(".repo-row", { hasText: "alpha" }).focus();
  await window.keyboard.press("Meta+Shift+ArrowDown");

  await expect(live).toHaveText("alpha moved to 2 of 3.");
});

test("the via-wt marker appears only in the lens whose claim it makes", async () => {
  sandbox = createGitSandbox();
  sandbox.makeRepo("solo", { worktrees: ["feature/login"] });

  handle = await launchApp();
  const { window } = handle;
  await addRootAndExpand(window, handle, sandbox, "solo");

  // Pin a WORKTREE, not the repo: that pulls the repo into the Pinned lens
  // while the repo's own star stays unlit, which is what the marker explains.
  // The pin lives in the hover-gated action cluster (`pointer-events: none` at
  // rest), so the row has to be hovered before the click is actionable — and
  // re-hovered inside the retry, since a background repo refresh can re-render
  // the row and eat the :hover state.
  const wtRow = branchRow(window, "feature/login");
  await expect(async () => {
    await wtRow.hover();
    await wtRow
      .getByRole("button", { name: "Pin worktree" })
      .click({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(wtRow.getByRole("button", { name: "Unpin worktree" })).toHaveCount(1);

  // In All, the repo is not "in Pinned", so the marker must not claim it is.
  await expect(window.locator(".repo-row__pin-via")).toHaveCount(0);

  await lensChip(window, "Pinned").click();
  await expect(window.locator(".repo-row__pin-via")).toHaveCount(1);
});
