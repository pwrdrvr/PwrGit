import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from "@playwright/test";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { SceneReport } from "./harness/section-headings/main";

/**
 * The sidebar's section headings at the widths a sidebar gives them.
 *
 * Not the app: a Vite build of the real `RepoRow` and its sections against a
 * fake preload bridge (`harness/section-headings`), in a hidden Electron
 * window, so the stylesheet, the bundled fonts and the ladder are the
 * shipping ones and the data is contrived. Section rows of 270, 222, 194 and
 * 170px; each repository block takes its own step. Design: Sidebar Section
 * Headings - UX Review, 2c and 3.
 *
 * `PWRGIT_HARNESS_SHOTS=<dir>` also writes the grid as a PNG there.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "harness", "electron-main.cjs");
const STEPS = ["fit-short", "fit-glyphs", "fit-fold-1", "fit-fold-2", "fit-fold-3"];

let out: string;
let app: ElectronApplication;
let page: Page;
let scenes: SceneReport[];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  out = mkdtempSync(join(tmpdir(), "pwrgit-headings-"));
  const html = await buildHarness("section-headings", join(out, "dist"));
  app = await electron.launch({
    args: [
      // As `launchApp` does: hardware codecs leak VideoToolbox clients in the
      // Tart guests even with the GPU off (e2e/AGENTS.md).
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      MAIN
    ],
    env: cleanEnv({
      PWRGIT_HARNESS_HTML: html,
      PWRGIT_HARNESS_WIDTH: "1240",
      PWRGIT_HARNESS_HEIGHT: "1100"
    })
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => "__harness" in window);
  await page.evaluate(() => (window as unknown as { __harness: { ready: Promise<void> } }).__harness.ready);
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  if (shots !== undefined && shots !== "") {
    mkdirSync(shots, { recursive: true });
    await page.locator(".harness-grid").screenshot({ path: join(shots, "section-headings.png") });
  }
  scenes = await readScenes();
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

const readScenes = (): Promise<SceneReport[]> =>
  page.evaluate(() =>
    (window as unknown as { __harness: { report: () => SceneReport[] } }).__harness.report()
  );

const scene = (repo: string, row: number): SceneReport => {
  const found = scenes.find((s) => s.repo === repo && s.row === row);
  if (found === undefined) throw new Error(`no scene ${repo} @ ${row}`);
  return found;
};

const depth = (s: SceneReport): number => s.sectionSteps.length;

test("each scene is measured at its section-row width", () => {
  for (const s of scenes) expect(s.measured, `${s.repo} @ ${s.row}`).toBeCloseTo(s.row, 0);
});

test("no heading overlaps, wraps or cuts a label or chip at any width", () => {
  for (const s of scenes) {
    expect(s.problems, `${s.repo} @ ${s.row}: ${s.sectionSteps.join(" ")}`).toEqual([]);
  }
});

test("steps are taken in order and only deepen as the row narrows", () => {
  for (const s of scenes) {
    // Cumulative: a step is present only with every step before it.
    expect(s.sectionSteps).toEqual(STEPS.slice(0, depth(s)));
  }
  for (const repo of ["atlas", "beacon", "cinder"]) {
    const ladder = [270, 222, 194, 170].map((row) => depth(scene(repo, row)));
    expect(ladder, repo).toEqual([...ladder].sort((a, b) => a - b));
  }
});

test("a quiet repository keeps its words where a busy one steps down", () => {
  expect(depth(scene("cinder", 270))).toBe(0);
  expect(depth(scene("cinder", 222))).toBe(0);
  expect(depth(scene("atlas", 222))).toBeGreaterThan(0);
  for (const row of [270, 222, 194, 170]) {
    expect(depth(scene("cinder", row))).toBeLessThanOrEqual(depth(scene("atlas", row)));
  }
});

test("the busiest repository reaches glyphs and folds before it would overflow", () => {
  const narrow = scene("atlas", 170);
  expect(narrow.sectionSteps).toContain("fit-glyphs");
  expect(narrow.sectionSteps).toContain("fit-fold-1");
  // The +N chip names what it holds, and its name contains the visible +N.
  const more = narrow.names.find((name) => name.includes(" more: "));
  expect(more).toMatch(/^\+\d more: .*gone\. Show branches$/);
});

test("labels that leave the screen stay in the headings' names", () => {
  for (const s of scenes) {
    const names = s.names.join(" | ");
    for (const word of ["Worktrees", "Branches", "Tags", "Remotes"]) {
      expect(names, `${s.repo} @ ${s.row}`).toContain(word);
    }
    expect(names, `${s.repo} @ ${s.row}`).toContain("Pull requests");
  }
});

test("the repository row drops marks, then its count's word, before its name", () => {
  for (const s of scenes) {
    if (s.rowSteps.includes("rr-short-count")) {
      expect(s.rowSteps).toContain("rr-no-marks");
    }
  }
});

test("a block re-steps when its tree is resized in place", async () => {
  const before = depth(scene("atlas", 270));
  await page.evaluate(() =>
    (window as unknown as { __harness: { resize: (r: string, w: number, t: number) => void } })
      .__harness.resize("atlas", 270, 200)
  );
  await expect
    .poll(async () => depth((await readScenes()).find((s) => s.repo === "atlas" && s.row === 270)!))
    .toBeGreaterThan(before);
  const after = (await readScenes()).find((s) => s.repo === "atlas" && s.row === 270)!;
  expect(after.problems).toEqual([]);
});

// The sections unmount with the disclosure. A block expanded after its row
// mounted must still hear its tree being resized.
test("a block re-expanded after mount still re-steps on resize", async () => {
  type Api = {
    setExpanded: (r: string, w: number, open: boolean) => void;
    resize: (r: string, w: number, t: number) => void;
  };
  await page.evaluate(() =>
    (window as unknown as { __harness: Api }).__harness.setExpanded("atlas", 194, false)
  );
  await expect(page.locator('.harness-scene[data-repo="atlas"][data-row="194"] .repo-sections')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __harness: Api }).__harness.setExpanded("atlas", 194, true)
  );
  await expect(page.locator('.harness-scene[data-repo="atlas"][data-row="194"] .repo-sections')).toHaveCount(1);
  const narrow = (await readScenes()).find((s) => s.repo === "atlas" && s.row === 194)!;
  expect(depth(narrow)).toBeGreaterThan(0);
  await page.evaluate(() =>
    (window as unknown as { __harness: Api }).__harness.resize("atlas", 194, 520)
  );
  await expect
    .poll(async () => depth((await readScenes()).find((s) => s.repo === "atlas" && s.row === 194)!))
    .toBe(0);
});
