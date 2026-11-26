import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test as base, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = join(HERE, "..", "src", "renderer", "src", "styles", "app.css");

const test = base.extend<{ harnessPage: Page }>({
  harnessPage: async ({}, use) => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-nav-flash-"));
    try {
      const html = join(out, "index.html");
      writeFileSync(
        html,
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="file://${APP_CSS}" />
    <style>
      body { margin: 0; background: var(--bg-sidebar); }
      .stage { width: 320px; padding: 12px; }
    </style>
  </head>
  <body>
    <div class="stage">
      <div class="repo-row" data-repo-id="repo-1"><span>copper-ledger</span></div>
      <div class="repo-row" data-repo-id="repo-2"><span>amber-vault</span></div>
    </div>
    <div class="overlay-backdrop bulk-sync-backdrop" style="display:none">
      <div class="modal bulk-sync">
        <div class="bulk-sync__status">
          <div class="bulk-sync__bar">
            <i class="is-success" style="flex-grow: 4"></i>
            <i class="is-in-flight" style="flex-grow: 6"></i>
            <i class="is-queued" style="flex-grow: 10"></i>
          </div>
        </div>
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
          PWRGIT_HARNESS_WIDTH: "640",
          PWRGIT_HARNESS_HEIGHT: "360"
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

test("nav-flash animates on a compositor opacity layer and bulk-sync bar isolates backdrop paints", async ({
  harnessPage: page
}) => {
  const row = page.locator('.repo-row[data-repo-id="repo-1"]');
  const session = await page.context().newCDPSession(page);
  let layers: { backendNodeId?: number; layerId: string }[] = [];
  session.on("LayerTree.layerTreeDidChange", (event) => {
    layers = event.layers ?? [];
  });
  await session.send("LayerTree.enable");

  const opacityLayerReasons = async (backendNodeId: number) => {
    const layer = layers.find((item) => item.backendNodeId === backendNodeId);
    if (layer === undefined) return [];
    const reasons = await session.send("LayerTree.compositingReasons", {
      layerId: layer.layerId
    });
    return reasons.compositingReasonIds;
  };

  await row.evaluate((element) => {
    element.classList.add("is-nav-flash");
    const anim = element
      .getAnimations({ subtree: true })
      .find((a) => a instanceof CSSAnimation && a.animationName === "nav-flash");
    anim?.updatePlaybackRate(0.1);
  });

  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: '.repo-row[data-repo-id="repo-1"]'
  });
  const { node } = await session.send("DOM.describeNode", { nodeId, depth: 1 });
  const beforePseudo = node.pseudoElements?.find((p) => p.pseudoType === "before");
  expect(beforePseudo).toBeDefined();
  await expect
    .poll(() => opacityLayerReasons(beforePseudo!.backendNodeId))
    .toContain("ActiveOpacityAnimation");

  await row.evaluate((element) => {
    for (const a of element.getAnimations({ subtree: true })) a.finish();
    element.classList.remove("is-nav-flash");
  });

  // Now show the expanded bulk-sync dialog and settle its 120ms pg-fade entrance
  // animation before tracing Paint roots while the bar updates.
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

  // Resolve backendNodeIds for the backdrop and progress bar so Paint events
  // are matched by Chromium's nodeId (plus nodeName when present), and verify
  // that Paint events actually fire for the bar update rather than passing vacuously.
  const { root: modalRoot } = await session.send("DOM.getDocument");
  const { nodeId: backdropNodeId } = await session.send("DOM.querySelector", {
    nodeId: modalRoot.nodeId,
    selector: ".bulk-sync-backdrop"
  });
  const { node: backdropNode } = await session.send("DOM.describeNode", {
    nodeId: backdropNodeId,
    depth: 0
  });
  const { nodeId: barNodeId } = await session.send("DOM.querySelector", {
    nodeId: modalRoot.nodeId,
    selector: ".bulk-sync__bar"
  });
  const { node: barNode } = await session.send("DOM.describeNode", {
    nodeId: barNodeId,
    depth: 0
  });

  type PaintTraceEvent = {
    name: string;
    args?: { data?: { nodeId?: number; nodeName?: string } };
  };
  const traceEvents: PaintTraceEvent[] = [];
  session.on("Tracing.dataCollected", (chunk: { value?: unknown[] }) => {
    for (const item of chunk.value ?? []) {
      traceEvents.push(item as PaintTraceEvent);
    }
  });
  await session.send("Tracing.start", { categories: "devtools.timeline" });
  await page.evaluate(() => {
    const success = document.querySelector<HTMLElement>(".bulk-sync__bar > .is-success")!;
    const inFlight = document.querySelector<HTMLElement>(".bulk-sync__bar > .is-in-flight")!;
    success.style.flexGrow = "9";
    inFlight.style.flexGrow = "3";
  });
  await page.waitForTimeout(350);
  const done = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()));
  await session.send("Tracing.end");
  await done;

  // Verify the expanded dialog progress bar actually painted during the update
  // AND contained its layout/paint so the backdrop behind it never repainted.
  const paintEvents = traceEvents.filter((e) => e.name === "Paint");
  expect(paintEvents.length).toBeGreaterThan(0);
  const barPaints = paintEvents.filter(
    (e) =>
      e.args?.data?.nodeId === barNode.backendNodeId ||
      (e.args?.data?.nodeName ?? "").includes("bulk-sync__bar")
  );
  expect(barPaints.length).toBeGreaterThan(0);
  const backdropPaints = paintEvents.filter(
    (e) =>
      e.args?.data?.nodeId === backdropNode.backendNodeId ||
      (e.args?.data?.nodeName ?? "").includes("overlay-backdrop")
  );
  expect(backdropPaints).toHaveLength(0);
});
