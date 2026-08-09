import { expect, test, type Page } from "@playwright/test";
import { launchApp, type AppHandle } from "./fixtures/electron-app";
import { createGitSandbox, type GitSandbox } from "./fixtures/git-sandbox";

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
 * Widest rendered content vs. the space the chip actually has.
 *
 * `scrollWidth` is not enough here. `.lens-chip` centers its content, so an
 * overrun spills off BOTH edges, and overflow past the *start* edge doesn't
 * show up in `scrollWidth` — a chip clipped symmetrically can report
 * `scrollWidth === clientWidth` while visibly missing glyphs. A Range over the
 * chip's contents measures the laid-out content box instead: `overflow: hidden`
 * clips painting, not layout, so the rect still reports the true width.
 */
async function chipOverflows(window: Page): Promise<{ label: string; over: number }[]> {
  return window.locator(".lens-chip").evaluateAll((els) =>
    els
      .map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const content = range.getBoundingClientRect().width;
        range.detach();
        return {
          label: (el.textContent ?? "").trim(),
          over: Math.round((content - el.clientWidth) * 100) / 100
        };
      })
      // 1px of slack. Grid track sizes round to layout units while the Range
      // rect is fractional, so a chip that fits exactly still measures a few
      // tenths over — the fixed layout sits at +0.38px on "Behind 3". The bug
      // this guards against is far larger: the equal-track layout overran by
      // 6.5px and 1.4px. Anything past 1px is a real glyph, not rounding.
      .filter((r) => r.over > 1)
  );
}

test("lens chips never clip their labels or counts", async () => {
  sandbox = createGitSandbox();
  // Enough repos for a three-digit "All", and several genuinely behind so the
  // "Behind" chip carries a count too — "Behind 3" is the pairing that used to
  // overrun its equal-width track and lose glyphs off both ends.
  for (let i = 0; i < 12; i += 1) sandbox.makeRepo(`repo-${String(i).padStart(2, "0")}`);
  for (const name of ["behind-a", "behind-b", "behind-c"]) {
    sandbox.makeRepoBehindRemote(name, { behindBy: 2 });
  }

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(15, {
    timeout: 20_000
  });

  // Counts must actually be on screen, or this test would pass against the
  // very layout it exists to catch.
  await expect(window.locator(".lens-chip__count").first()).toBeVisible();

  expect(await chipOverflows(window)).toEqual([]);
});

test("lens chips never clip at the minimum sidebar width", async () => {
  sandbox = createGitSandbox();
  for (let i = 0; i < 12; i += 1) sandbox.makeRepo(`repo-${String(i).padStart(2, "0")}`);

  handle = await launchApp();
  const { window } = handle;
  await handle.setPickDirectory(sandbox.reposDir);
  await window.getByRole("button", { name: /Add folders/i }).click();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(12, {
    timeout: 20_000
  });

  // 240 is useColumnResize's floor for the sidebar. Below 310 the compact
  // container-query block takes over — a different track template, so it needs
  // its own coverage.
  await window.evaluate(() =>
    window.localStorage.setItem("pwrgit.sidebarWidth", "240")
  );
  await window.reload();
  await window.locator(".lens-chip", { hasText: "All" }).click();
  await expect(window.locator(".repo-row__name")).toHaveCount(12, {
    timeout: 20_000
  });

  expect(await chipOverflows(window)).toEqual([]);
});
