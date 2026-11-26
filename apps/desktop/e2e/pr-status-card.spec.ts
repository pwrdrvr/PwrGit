import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { StackPosition } from "@pwrgit/shared";
import { cleanEnv } from "./fixtures/electron-app";
import { buildHarness } from "./harness/build";
import type { CardMeasurement, CardScene } from "./harness/pr-status-card/main";

const HARNESS_NOW = Date.parse("2026-11-26T18:00:00Z");

type Harness = {
  ready: Promise<void>;
  mountShowcase: (theme: "dark" | "light") => void;
  mountCases: (theme: "dark" | "light", scenes: CardScene[]) => CardMeasurement[];
  measureShowcase: () => CardMeasurement[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "harness", "electron-main.cjs");

let out: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  out = mkdtempSync(join(tmpdir(), "pwrgit-pr-card-"));
  const html = await buildHarness("pr-status-card", join(out, "dist"));
  app = await electron.launch({
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      ...(process.env["PWRGIT_E2E_DISABLE_GPU"] === "1" ? ["--disable-gpu"] : []),
      MAIN
    ],
    env: cleanEnv({
      PWRGIT_HARNESS_HTML: html,
      PWRGIT_HARNESS_WIDTH: "1280",
      PWRGIT_HARNESS_HEIGHT: "820"
    })
  });
  page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => "__harness" in window);
  await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.ready);
});

test.afterAll(async () => {
  await app?.close();
  if (out !== undefined) rmSync(out, { recursive: true, force: true });
});

function assertHealthyCard(m: CardMeasurement, context: string, expectUntruncatedChip = true) {
  expect(m.hasNumberChip, `${context}: has PR number chip`).toBe(true);
  expect(m.numberChipVisible, `${context}: number chip visible inside card`).toBe(true);
  if (expectUntruncatedChip) {
    expect(m.numberChipTruncated, `${context}: number chip not truncated`).toBe(false);
  }
  expect(m.eyebrowLines, `${context}: eyebrow stays single-line`).toBe(1);
  expect(m.headerOverlap, `${context}: header has no overlap`).toBe(false);
  expect(m.cardScrollWidth, `${context}: card has no horizontal overflow`).toBeLessThanOrEqual(
    m.cardClientWidth + 0.5
  );
  expect(m.descendantOverflow, `${context}: no descendant overflows content box`).toEqual([]);
  expect(m.overlappingPairs, `${context}: no overlapping sibling elements`).toEqual([]);
  expect(m.statusDotAligned, `${context}: status dot aligns with first line`).toBe(true);
  expect(m.chipContrast, `${context}: number chip clears WCAG AA contrast`).toBeGreaterThanOrEqual(4.5);
}

test("PR status card shows a prominent, unclipped PR number chip without overflow across themes", async () => {
  const shots = process.env["PWRGIT_HARNESS_SHOTS"];
  const prefix = process.env["PWRGIT_HARNESS_SHOT_PREFIX"] ?? "pr-status-card";
  if (shots) mkdirSync(shots, { recursive: true });

  const byTheme = new Map<"light" | "dark", CardMeasurement[]>();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(
      (t) => (window as unknown as { __harness: Harness }).__harness.mountShowcase(t),
      theme
    );
    await expect(page.locator(".pr-card-harness section")).toHaveCount(4);
    if (shots) {
      await page.locator(".pr-card-harness").screenshot({
        path: join(shots, `${prefix}-${theme}.png`)
      });
    }
    byTheme.set(
      theme,
      await page.evaluate(() =>
        (window as unknown as { __harness: Harness }).__harness.measureShowcase()
      )
    );
  }

  for (const [theme, measurements] of byTheme) {
    for (const m of measurements) {
      assertHealthyCard(m, `${theme}/${m.id}`);
    }
    const merged = measurements.find((m) => m.id === "lineage-dot-merged")!;
    expect(merged.numberChipText).toBe("#4524");
    expect(merged.baseTruncated).toBe(false);

    const gitlab = measurements.find((m) => m.id === "gitlab-nested-path")!;
    expect(gitlab.numberChipText).toBe("!874");
    expect(gitlab.baseTruncated).toBe(false);

    const stress = measurements.find((m) => m.id === "stress-long-fields")!;
    expect(stress.numberChipText).toBe("#1234567");
    expect(stress.headWidth).toBeGreaterThan(40);
    expect(stress.baseWidth).toBeGreaterThan(40);
    expect(stress.arrowVisible).toBe(true);
  }
});

function makeDeepStack(height: number, trunkBranch: string): StackPosition {
  const health = {
    inSync: true,
    needsRestack: false,
    parentMerged: false,
    needsPush: false,
    drift: false,
    remoteAhead: false
  };
  const layers = Array.from({ length: height }, (_, idx) => ({
    branch: `feat/layer-${idx + 1}-long-branch`,
    parent: idx === 0 ? trunkBranch : `feat/layer-${idx}-long-branch`,
    pr: {
      number: 1000 + idx,
      url: `https://github.com/northstar/Beacon/pull/${1000 + idx}`,
      title: `feat(layer-${idx + 1}): very_long_unbroken_title_segment_${idx}`,
      state: idx === 0 ? ("merged" as const) : ("open" as const),
      isDraft: false,
      checkState: "passing" as const
    },
    health
  }));
  return {
    index: height,
    layer: layers[height - 1]!,
    stack: {
      id: "deep-stack",
      source: "tracked",
      catalogRepository: "github.com/northstar/Beacon",
      trunk: { branch: trunkBranch, head: "a".repeat(40) },
      layers
    }
  };
}

test("PR status card layout holds across length and narrow-viewport stress shapes", async () => {
  const stressCases: CardScene[] = [
    {
      id: "short-head-long-base",
      label: "Short head + long base",
      pr: {
        number: 42,
        url: "https://github.com/northstar/Beacon/pull/42",
        title: "Keep short head intact",
        state: "open",
        isDraft: false,
        forge: "github",
        repoPath: "northstar/Beacon",
        headRefName: "fix/a",
        baseRefName: "release/2026-11-quarterly-enterprise-hotfix-candidate"
      }
    },
    {
      id: "long-head-short-base",
      label: "Long head + short base",
      pr: {
        number: 999999999,
        url: "https://gitlab.example.test/org/sub/repo/-/merge_requests/999999999",
        title: "W".repeat(80),
        state: "open",
        isDraft: false,
        forge: "gitlab",
        repoPath: "org/" + "W".repeat(70),
        headRefName: "dependabot/npm_and_yarn/packages/desktop/electron-builder-26.9.0",
        baseRefName: "main"
      }
    },
    {
      id: "deep-stack-long-trunk",
      label: "14-layer stack + long trunk",
      stackPosition: makeDeepStack(14, "release/2026-11-very-long-trunk-branch-name"),
      pr: {
        number: 1013,
        url: "https://github.com/northstar/Beacon/pull/1013",
        title: "Top of 14-layer stack",
        state: "open",
        isDraft: false,
        checkState: "passing",
        forge: "github",
        repoPath: "northstar/Beacon",
        headRefName: "feat/layer-14-long-branch",
        baseRefName: "feat/layer-13-long-branch"
      }
    },
    {
      id: "narrow-viewport-huge-counts",
      label: "Narrow 180px card + huge diff",
      cardWidth: 180,
      pr: {
        number: 1234567,
        url: "https://github.com/northstar/Beacon/pull/1234567",
        title: "fix(ui): narrow viewport with_an_unbroken_token_1234567890",
        state: "closed",
        isDraft: false,
        forge: "github",
        repoPath: "acme-enterprise/platform/services/distributed-gateway",
        headRefName: "feat/long-head-branch-name",
        baseRefName: "feat/long-base-branch-name",
        additions: 99999999,
        deletions: 88888888,
        changedFiles: 99999,
        commitCount: 12345,
        createdAt: HARNESS_NOW - 10 * 86_400_000,
        closedAt: HARNESS_NOW - 2 * 86_400_000
      }
    }
  ];

  for (const theme of ["light", "dark"] as const) {
    const measurements = await page.evaluate(
      ({ t, cases }) => (window as unknown as { __harness: Harness }).__harness.mountCases(t, cases),
      { t: theme, cases: stressCases }
    );
    for (const m of measurements) {
      assertHealthyCard(m, `${theme}/${m.id}`);
    }
    const shortHead = measurements.find((m) => m.id === "short-head-long-base")!;
    expect(shortHead.headTruncated).toBe(false);
    expect(shortHead.baseWidth).toBeGreaterThan(80);

    const shortBase = measurements.find((m) => m.id === "long-head-short-base")!;
    expect(shortBase.numberChipText).toBe("!999999999");
    expect(shortBase.baseTruncated).toBe(false);
    expect(shortBase.headWidth).toBeGreaterThan(80);
  }
});
