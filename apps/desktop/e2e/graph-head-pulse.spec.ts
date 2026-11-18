import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test as base, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";

const HERE = dirname(fileURLToPath(import.meta.url));

const test = base.extend<{ harnessPage: Page }>({
  harnessPage: async ({}, use) => {
    const out = mkdtempSync(join(tmpdir(), "pwrgit-head-pulse-"));
    try {
      const html = await buildHarness("graph-head-pulse", join(out, "dist"));
      const app = await electron.launch({
        args: [
          "--disable-accelerated-video-decode",
          "--disable-accelerated-video-encode",
          ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
          join(HERE, "harness", "electron-main.cjs")
        ],
        env: cleanEnv({
          PWRGIT_HARNESS_HTML: html,
          PWRGIT_HARNESS_WIDTH: "580",
          PWRGIT_HARNESS_HEIGHT: "180"
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

// This also runs with the base stylesheet, where the flash repaints the row.
const shots = process.env["PWRGIT_HARNESS_SHOTS"];
if (shots) {
  test("captures the locate flash", async ({ harnessPage: page }) => {
    const graph = page.locator(".graph-harness");
    const row = graph.locator(".graph-row--head");
    await row.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await row.evaluate((element) => {
      element.querySelector(".head-ring")!.setAttribute("data-run-pulse", "");
      element.classList.add("is-flash");
      for (const animation of element.getAnimations({ subtree: true })) {
        if (!(animation instanceof CSSAnimation)) continue;
        animation.pause();
        animation.currentTime = animation.animationName === "head-flash" ? 140 : 1_300;
      }
    });
    mkdirSync(shots, { recursive: true });
    await graph.screenshot({ path: join(shots, "head-flash.png") });
  });
}

test("HEAD's ring and locate flash animate on compositor layers and return to rest", async ({ harnessPage: page }) => {
  const row = page.locator(".graph-row--head");
  const ring = row.locator(".head-ring");
  const session = await page.context().newCDPSession(page);
  let layers: { backendNodeId?: number; layerId: string }[] = [];
  session.on("LayerTree.layerTreeDidChange", (event) => {
    layers = event.layers ?? [];
  });
  await session.send("LayerTree.enable");

  const describeNode = async (selector: string) => {
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { node } = await session.send("DOM.describeNode", { nodeId, depth: 1 });
    return node;
  };
  // Chromium's layer tree is the oracle: the animated node must carry
  // an active opacity animation, even if the raster backend is software.
  const opacityLayerReasons = async (backendNodeId: number) => {
    const layer = layers.find((item) => item.backendNodeId === backendNodeId);
    if (layer === undefined) return [];
    const reasons = await session.send("LayerTree.compositingReasons", { layerId: layer.layerId });
    return reasons.compositingReasonIds;
  };

  await expect(ring).toHaveCSS("animation-name", "none");
  const ringNode = await describeNode(".head-ring");
  // Start after the observer is ready, and keep each animation active for
  // the duration of the compositor check even on a slow runner.
  await ring.evaluate((element) => {
    element.setAttribute("data-run-pulse", "");
    element.getAnimations()[0]!.updatePlaybackRate(0.1);
  });
  await expect.poll(() => opacityLayerReasons(ringNode.backendNodeId)).toContain("ActiveOpacityAnimation");

  await row.evaluate((element) => {
    element.classList.add("is-flash");
    const flash = element.getAnimations({ subtree: true })
      .find((animation) => animation instanceof CSSAnimation && animation.animationName === "head-flash")!;
    flash.updatePlaybackRate(0.1);
  });
  const rowNode = await describeNode(".graph-row--head");
  const flashNode = rowNode.pseudoElements?.find((node) => node.pseudoType === "before") ?? rowNode;
  await expect.poll(() => opacityLayerReasons(flashNode.backendNodeId)).toContain("ActiveOpacityAnimation");

  await row.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) animation.finish();
  });
  await expect(ring).toHaveCSS("opacity", "0.9");
  expect(await row.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await ring.evaluate((element) => element.setAttribute("data-run-pulse", ""));
  await row.evaluate((element) => element.classList.add("is-flash"));
  await expect(ring).toHaveCSS("opacity", "0.9");
  expect(await row.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
});
