import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test as base, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = join(HERE, "..", "src", "renderer", "src", "styles", "app.css");
const CONTRIBUTIONS_CSS = join(
  HERE,
  "..",
  "src",
  "renderer",
  "src",
  "features",
  "contributions",
  "contributions.css"
);

type TraceEvent = {
  name: string;
  ph?: string;
  args?: {
    data?: {
      nodeName?: string;
      reason?: string;
    };
  };
};

const test = base.extend<{ harnessPage: Page }>({
  harnessPage: async ({}, use) => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-pointer-travel-"));
    try {
      const html = join(out, "index.html");
      const wtRows = Array.from({ length: 8 }, (_, i) => `
        <div class="wt-row${i === 0 ? " is-selected" : ""}" data-wt-id="wt-${i}" tabindex="0">
          <span class="wt-row__handle" aria-hidden="true">::</span>
          <span class="wt-row__branch">feature/perf-${i}</span>
          <span class="pr-chip pr-chip--passing" role="button" tabindex="0">
            <span class="pr-chip__dot"></span>
            <span class="pr-chip__label">#${400 + i}</span>
          </span>
          <span class="wt-age">${i + 1}h</span>
          <div class="wt-row__hoveracts">
            <button type="button" class="pin" aria-label="Pin worktree">*</button>
          </div>
          <div class="kebab wt-row__menu">
            <button type="button" class="kebab__btn" aria-label="Worktree actions">...</button>
          </div>
        </div>`).join("\n");

      const otherRepos = Array.from({ length: 24 }, (_, i) => `
        <div class="repo-block">
          <div class="repo-row is-arrangeable" data-repo-id="repo-${i + 2}" tabindex="0">
            <span class="repo-row__handle" aria-hidden="true">::</span>
            <span class="repo-row__name">widget-${String(i + 2).padStart(2, "0")}</span>
            <div class="kebab repo-row__menu">
              <button type="button" class="kebab__btn" aria-label="Repo actions">...</button>
            </div>
          </div>
        </div>`).join("\n");

      const graphRows = Array.from({ length: 6 }, (_, i) => `
        <div class="graph-row" data-commit="${i}">
          <span class="commit-body">Commit subject ${i}</span>
          <button type="button" class="commit-sha-chip">abc000${i}</button>
        </div>`).join("\n");

      writeFileSync(
        html,
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="file://${APP_CSS}" />
    <link rel="stylesheet" href="file://${CONTRIBUTIONS_CSS}" />
  </head>
  <body>
    <div class="app">
      <div class="titlebar">
        <div class="history-nav">
          <button type="button" class="history-nav__chip" aria-label="Back">&lt;</button>
        </div>
        <button type="button" class="titlebar__branch"><span class="titlebar__branch-name">main</span></button>
        <span class="titlebar__pathchip">~/widgets/widget-01</span>
        <div class="titlebar__spacer"></div>
        <button type="button" class="titlebar-jump"><span class="titlebar-jump__label">Jump to repo…</span></button>
        <button type="button" class="contributions-nav" aria-label="Contributions">C</button>
      </div>
      <div class="app-body" style="grid-template-columns: 320px 1fr;">
        <aside class="pane pane--sidebar">
          <div class="sidebar-toolbar">
            <button type="button" class="sidebar-toolbar__btn">Add</button>
            <div class="sidebar-toolbar__split">
              <button type="button" class="sidebar-toolbar__btn sidebar-toolbar__sync">Pull</button>
              <button type="button" class="sidebar-toolbar__btn sidebar-toolbar__chevron">v</button>
            </div>
          </div>
          <div class="sidebar__body">
            <div class="sidebar__tree-pane">
              <div class="sidebar__list">
                <div class="repo-block">
                  <div class="repo-row holds-selection is-arrangeable" data-repo-id="repo-1" tabindex="0">
                    <span class="repo-row__handle" aria-hidden="true">::</span>
                    <span class="repo-row__name">widget-01</span>
                    <div class="kebab repo-row__menu">
                      <button type="button" class="kebab__btn" aria-label="Repo actions">...</button>
                    </div>
                  </div>
                  <div class="wt-section">${wtRows}</div>
                </div>
                ${otherRepos}
              </div>
            </div>
          </div>
        </aside>
        <main class="pane pane--main">
          <div class="graph-toolbar">
            <button type="button" class="graph-locate">Locate HEAD</button>
            <button type="button" class="graph-branches">Branches</button>
          </div>
          <div class="graph-scroll">
            <div class="graph-card">${graphRows}</div>
          </div>
        </main>
      </div>
    </div>
  </body>
</html>`
      );

      const app = await electron.launch({
        args: [
          "--disable-accelerated-video-decode",
          "--disable-accelerated-video-encode",
          ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
          join(HERE, "harness", "electron-main.cjs")
        ],
        env: cleanEnv({
          PWRGIT_HARNESS_HTML: html,
          PWRGIT_HARNESS_WIDTH: "1024",
          PWRGIT_HARNESS_HEIGHT: "680"
        })
      });
      try {
        const page = await app.firstWindow();
        await page.waitForLoadState("load");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.mouse.move(4, 4);
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (const anim of document.getAnimations()) {
            if (anim instanceof CSSAnimation) anim.finish();
          }
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          );
        });
        await use(page);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("pointer travel across worktree rows triggers zero hover transitions, zero layouts, and zero sticky repo-row repaint cascades", async ({
  harnessPage: page
}) => {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const item of value) events.push(item as unknown as TraceEvent);
  });

  await cdp.send("Tracing.start", {
    categories:
      "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking"
  });

  // Sweep across non-selected worktree rows, their right-hand hover actions,
  // and PR chips — without hovering any .repo-row.
  const wtTargets = await page.evaluate(() => {
    const pts: Array<{ x: number; y: number }> = [];
    document.querySelectorAll<HTMLElement>(".wt-row").forEach((row, i) => {
      if (i === 0 || i > 5) return;
      const r = row.getBoundingClientRect();
      pts.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      pts.push({ x: Math.round(r.right - 22), y: Math.round(r.top + r.height / 2) });
      const pr = row.querySelector<HTMLElement>(".pr-chip");
      if (pr) {
        const prRect = pr.getBoundingClientRect();
        pts.push({
          x: Math.round(prRect.left + prRect.width / 2),
          y: Math.round(prRect.top + prRect.height / 2)
        });
      }
    });
    return pts;
  });

  let maxActiveTransitions = 0;
  for (const pt of wtTargets) {
    await page.mouse.move(pt.x, pt.y);
    const active = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition).length
    );
    maxActiveTransitions = Math.max(maxActiveTransitions, active);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    );
  }
  await page.mouse.move(4, 4);
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      )
  );

  const done = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve())
  );
  await cdp.send("Tracing.end");
  await done;
  await cdp.detach();

  // 1. No CSS hover transitions run on worktree rows, PR chips, or row controls.
  expect(maxActiveTransitions).toBe(0);

  // 2. Hovering worktree rows must not trigger any Layout or scrollbar/style
  //    layout invalidations on .sidebar__list, .wt-age, or hover controls.
  const layouts = events.filter((e) => e.name === "Layout" && e.ph === "X");
  expect(layouts).toHaveLength(0);

  const layoutInvalidations = events.filter(
    (e) => e.name === "LayoutInvalidationTracking"
  );
  expect(layoutInvalidations).toHaveLength(0);

  // 3. Non-hovered sticky .repo-row headers must not cascade-repaint when
  //    hovering worktree rows inside .sidebar__list.
  const stickyRepoPaints = events.filter(
    (e) =>
      e.name === "Paint" &&
      e.ph === "X" &&
      (e.args?.data?.nodeName ?? "").includes("repo-row")
  );
  expect(stickyRepoPaints).toHaveLength(0);

  // 4. Visual and keyboard contracts remain intact on hover and focus.
  const row = page.locator('.wt-row[data-wt-id="wt-2"]');
  await row.hover();
  await expect(row.locator(".wt-row__hoveracts")).toHaveCSS("opacity", "1");
  await expect(row.locator(".wt-row__menu")).toHaveCSS("opacity", "1");
  await expect(row.locator(".wt-row__handle")).toHaveCSS("opacity", "1");
  await expect(row.locator(".wt-age")).toHaveCSS("visibility", "hidden");

  await row.locator(".pr-chip").focus();
  await expect(row.locator(".wt-row__hoveracts")).toHaveCSS("opacity", "0");
  await expect(row.locator(".wt-age")).toHaveCSS("visibility", "visible");
});

test("pointer travel across titlebar, sidebar toolbar, and lineage rows schedules zero hover transitions", async ({
  harnessPage: page
}) => {
  const selectors = [
    ".titlebar-jump",
    ".history-nav__chip",
    ".titlebar__branch",
    ".titlebar__pathchip",
    ".contributions-nav",
    ".sidebar-toolbar__btn",
    ".repo-row[data-repo-id='repo-2']",
    ".graph-locate",
    ".graph-branches",
    ".graph-row[data-commit='0']",
    ".graph-row[data-commit='0'] .commit-sha-chip"
  ];

  for (const selector of selectors) {
    await page.locator(selector).first().hover();
    const transitions = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => (a as CSSTransition).transitionProperty)
    );
    expect(
      transitions,
      `unexpected CSSTransition when hovering ${selector}`
    ).toEqual([]);
  }
});
