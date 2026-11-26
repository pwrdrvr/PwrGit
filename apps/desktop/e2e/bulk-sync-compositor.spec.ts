import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron, expect, test as base, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = join(HERE, "..", "src", "renderer", "src", "styles", "app.css");

const test = base.extend<{ harnessPage: Page }>({
  harnessPage: async ({}, use) => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-bulk-sync-compositor-"));
    try {
      const repoRows = Array.from({ length: 20 }, (_, i) => {
        const wtRows =
          i === 0
            ? Array.from(
                { length: 8 },
                (_, j) =>
                  `<div class="wt-row${j === 0 ? " is-selected" : ""}"><span>branch-${j}</span></div>`
              ).join("")
            : "";
        return `<div class="repo-block"><div class="repo-row" data-repo-id="repo-${i}"><span class="repo-row__name">repo-${i}</span></div>${wtRows}</div>`;
      }).join("");

      const html = join(out, "index.html");
      writeFileSync(
        html,
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${pathToFileURL(APP_CSS).href}" />
    <style>
      body { margin: 0; background: var(--bg-app); }
      .shell { display: flex; height: 100vh; width: 100vw; }
      .pane--sidebar { width: 320px; height: 100%; }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="pane pane--sidebar">
        <div class="sidebar-toolbar" role="group">
          <div class="sidebar-toolbar__split">
            <button type="button" class="sidebar-toolbar__btn sidebar-toolbar__sync" aria-busy="true">
              <span class="sidebar-toolbar__label">Pull all</span>
              <span class="sidebar-toolbar__count" data-fit-text-columns="4">0/30</span>
            </button>
            <button type="button" class="sidebar-toolbar__btn sidebar-toolbar__chevron"></button>
            <span class="bulk-sync__bar sidebar-toolbar__progress" aria-hidden="true">
              <i class="is-success is-empty" style="flex-grow: 0"></i>
              <i class="is-in-flight" style="flex-grow: 3"></i>
              <i class="is-queued" style="flex-grow: 27"></i>
            </span>
          </div>
        </div>
        <div class="sidebar__body">
          <div class="sidebar__tree-pane">
            <div class="sidebar__list">
              <div class="sidebar__tree" role="tree">${repoRows}</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
    <div class="overlay-backdrop bulk-sync-backdrop" style="display:none">
      <section class="modal bulk-sync" role="dialog" aria-modal="true">
        <div class="bulk-sync__status is-live">
          <div class="bulk-sync__bar" role="progressbar">
            <i class="is-success" style="flex-grow: 4"></i>
            <i class="is-in-flight" style="flex-grow: 6"></i>
            <i class="is-queued" style="flex-grow: 20"></i>
          </div>
        </div>
      </section>
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
          PWRGIT_HARNESS_WIDTH: "900",
          PWRGIT_HARNESS_HEIGHT: "640"
        })
      });
      try {
        const page = await app.firstWindow();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await use(page);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("expanded bulk-sync stripes composite via transform and toolbar count updates repaint zero sticky repo rows", async ({
  harnessPage: page
}) => {
  const session = await page.context().newCDPSession(page);
  let layers: { backendNodeId?: number; layerId: string }[] = [];
  session.on("LayerTree.layerTreeDidChange", (event) => {
    layers = event.layers ?? [];
  });
  await session.send("LayerTree.enable");

  // Show the expanded bulk-sync dialog after LayerTree.enable so the compositor
  // emits the new layer tree, settle the 120ms backdrop entrance fade, and
  // commit a real frame so hidden windows on Linux/Windows/--disable-gpu paint
  // initial state before tracing starts.
  await page.evaluate(async () => {
    const backdrop = document.querySelector<HTMLElement>(".bulk-sync-backdrop")!;
    backdrop.style.display = "flex";
    for (const a of backdrop.getAnimations({ subtree: true })) {
      if (a instanceof CSSAnimation && a.animationName !== "bulk-sync-stripes") {
        a.finish();
      }
    }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  await session.send("Page.captureScreenshot");

  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".modal.bulk-sync .bulk-sync__bar > .is-in-flight"
  });
  const { node } = await session.send("DOM.describeNode", { nodeId, depth: 1 });
  const beforePseudo = node.pseudoElements?.find((p) => p.pseudoType === "before");
  expect(beforePseudo).toBeDefined();

  const transformLayerReasons = async (backendNodeId: number) => {
    const layer = layers.find((item) => item.backendNodeId === backendNodeId);
    if (layer === undefined) return [];
    const reasons = await session.send("LayerTree.compositingReasons", {
      layerId: layer.layerId
    });
    return reasons.compositingReasonIds;
  };
  await expect
    .poll(() => transformLayerReasons(beforePseudo!.backendNodeId))
    .toContain("ActiveTransformAnimation");

  // Resolve backendNodeIds so Paint events match Chromium's nodeId (plus
  // nodeName when present) and cannot pass vacuously if nodeName is omitted.
  const resolveBackendIds = async (selector: string): Promise<Set<number>> => {
    const { nodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector
    });
    const ids = new Set<number>();
    for (const id of nodeIds) {
      const described = await session.send("DOM.describeNode", { nodeId: id, depth: 0 });
      ids.add(described.node.backendNodeId);
    }
    return ids;
  };
  const backdropIds = await resolveBackendIds(".bulk-sync-backdrop");
  const barIds = await resolveBackendIds(".modal.bulk-sync .bulk-sync__bar");
  const toolbarIds = await resolveBackendIds(".sidebar-toolbar, .sidebar-toolbar__split, .sidebar-toolbar__count");
  const repoRowIds = await resolveBackendIds(".repo-row");
  const wtRowIds = await resolveBackendIds(".wt-row");
  expect(backdropIds.size).toBe(1);
  expect(barIds.size).toBe(1);
  expect(repoRowIds.size).toBe(20);
  expect(wtRowIds.size).toBe(8);

  type TraceEvent = {
    name: string;
    ph?: string;
    args?: { data?: { nodeId?: number; nodeName?: string } };
  };
  const traceEvents: TraceEvent[] = [];
  session.on("Tracing.dataCollected", (chunk: { value?: unknown[] }) => {
    for (const item of chunk.value ?? []) {
      traceEvents.push(item as TraceEvent);
    }
  });
  await session.send("Tracing.start", { categories: "devtools.timeline" });

  // Update the expanded progress bar once and tick the toolbar count 5 times,
  // committing each frame via Page.captureScreenshot so hidden windows on
  // Linux/Windows/--disable-gpu cannot skip Blink layout+paint commits.
  await page.evaluate(() => {
    const success = document.querySelector<HTMLElement>(".modal.bulk-sync .bulk-sync__bar > .is-success")!;
    const queued = document.querySelector<HTMLElement>(".modal.bulk-sync .bulk-sync__bar > .is-queued")!;
    success.style.flexGrow = "10";
    queued.style.flexGrow = "14";
  });
  await session.send("Page.captureScreenshot");

  for (let i = 1; i <= 5; i++) {
    await page.evaluate((countValue) => {
      document.querySelector<HTMLElement>(".sidebar-toolbar__count")!.textContent = `${countValue}/30`;
    }, i);
    await session.send("Page.captureScreenshot");
  }
  await page.waitForTimeout(250);
  await session.send("Page.captureScreenshot");

  const done = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()));
  await session.send("Tracing.end");
  await done;

  const paintEvents = traceEvents.filter((e) => e.name === "Paint" && e.ph === "X");
  const layouts = traceEvents.filter((e) => e.name === "Layout" && e.ph === "X");
  const matchesTarget = (event: TraceEvent, ids: Set<number>, needle: string): boolean => {
    const id = event.args?.data?.nodeId;
    const name = event.args?.data?.nodeName ?? "";
    return (id !== undefined && ids.has(id)) || name.includes(needle);
  };

  // Positive assertions prevent vacuous passes if Chromium skipped Paint.
  expect(paintEvents.length).toBeGreaterThan(0);
  expect(paintEvents.filter((e) => matchesTarget(e, barIds, "bulk-sync__bar")).length).toBeGreaterThan(0);
  expect(
    paintEvents.filter((e) => matchesTarget(e, toolbarIds, "sidebar-toolbar") || e.args?.data?.nodeName === "#document")
      .length
  ).toBeGreaterThan(0);
  expect(layouts.length).toBeGreaterThan(0);

  // Isolation assertions: neither bar updates nor toolbar count ticks may
  // repaint the backdrop or cascade into sticky .repo-row / .wt-row layers.
  expect(paintEvents.filter((e) => matchesTarget(e, backdropIds, "overlay-backdrop"))).toHaveLength(0);
  expect(paintEvents.filter((e) => matchesTarget(e, repoRowIds, "repo-row"))).toHaveLength(0);
  expect(paintEvents.filter((e) => matchesTarget(e, wtRowIds, "wt-row"))).toHaveLength(0);
  // 5 discrete toolbar count updates + 1 bar update must not spin a continuous
  // 60/120fps flex-grow transition layout loop (~20-40 layouts on 0c748a9d).
  expect(layouts.length).toBeLessThanOrEqual(8);

  // Reduced motion must stop the ::before stripe travel while keeping the
  // striped pattern visible.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedBefore = await page.evaluate(() => {
    const style = getComputedStyle(
      document.querySelector(".modal.bulk-sync .bulk-sync__bar > .is-in-flight")!,
      "::before"
    );
    return {
      animationName: style.animationName,
      backgroundImage: style.backgroundImage
    };
  });
  expect(reducedBefore.animationName).toBe("none");
  expect(reducedBefore.backgroundImage).toMatch(/^repeating-linear-gradient\(/);
});
