import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { StickyReport } from "./harness/sticky-heads/main";

/**
 * A diff's sticky file head, in every scroll container that hosts a diff.
 *
 * The rule, as a property over every sticky element the harness finds: once
 * stuck, a head's top edge IS the scrollport's top edge. Chromium pins
 * `top: N` at the scroll container's padding edge, so a host with 14px of top
 * padding left a 14px band above `top: 0` heads where rows scrolled past —
 * content vanished under the head, then reappeared above it.
 *
 * Not the app: a Vite build of the real `DiffViewer` and `app.css`
 * (`harness/sticky-heads`) in a hidden Electron window, with contrived data.
 * `PWRGIT_HARNESS_SHOTS=<dir>` writes the scrolled grid as a PNG there.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "harness", "electron-main.cjs");
const HOSTS = ["cr-view", "diff-pane", "file-insight"];

let out: string;
let app: ElectronApplication;
let page: Page;
let reports: StickyReport[];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  out = mkdtempSync(join(tmpdir(), "pwrgit-sticky-"));
  const html = await buildHarness("sticky-heads", join(out, "dist"));
  app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      MAIN
    ],
    env: cleanEnv({
      PWRGIT_HARNESS_HTML: html,
      PWRGIT_HARNESS_WIDTH: "1500",
      PWRGIT_HARNESS_HEIGHT: "560"
    })
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => "__harness" in window);
  await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
  reports = await page.evaluate(() =>
    (window as unknown as { __harness: { report: () => Promise<StickyReport[]> } }).__harness.report()
  );
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots !== undefined && shots !== "") {
    mkdirSync(shots, { recursive: true });
    await page.evaluate(() => (window as unknown as { __harness: { park: () => Promise<void> } }).__harness.park());
    await page.locator(".harness-grid").screenshot({ path: join(shots, "sticky-heads.png") });
  }
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

const reportFor = (host: string): StickyReport => {
  const found = reports.find((r) => r.host === host);
  if (found === undefined) throw new Error(`no host ${host}`);
  return found;
};

for (const host of HOSTS) {
  test(`${host}: a stuck head sits flush with the top of the scrollport`, () => {
    const r = reportFor(host);
    // The harness found the heads it is meant to check: one per file.
    expect(r.stickies).toBe(3);
    // Guards the premise: the host pads its top, which is what opens the gap.
    expect(r.paddingTop).toBeGreaterThan(0);
    for (const { what, gap } of r.stuckGaps) {
      expect(Math.abs(gap), `${what} stuck ${gap}px below the scrollport top`).toBeLessThanOrEqual(0.5);
    }
  });

  test(`${host}: at rest the first head still sits below the host's padding`, () => {
    const r = reportFor(host);
    // Never stuck at scrollTop 0, so the fix must not move it: it starts
    // after the host's top padding (plus, in file history, the commit strip).
    expect(r.restOffset).toBeGreaterThanOrEqual(r.paddingTop);
  });
}
