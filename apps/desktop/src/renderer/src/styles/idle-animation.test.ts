import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An idle window draws nothing.
 *
 * Chromium repaints every frame while a CSS animation runs on screen (60 or
 * 120 a second; an opacity animation on an SVG child is not even composited).
 * The HEAD ring's endless `head-pulse` kept a one-repository window at a
 * steady ~7% renderer + GPU CPU for as long as HEAD was in view. Measured in
 * an offscreen Electron window against this stylesheet: 60 paints/s with the
 * pulse, 0 without.
 *
 * So an `infinite` animation may only run on something that exists or
 * matches while work is in flight: a spinner, a busy state, an indeterminate
 * bar. Each one is listed here with what gates it. A new `infinite` must join
 * the list with its gate, or be made finite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const appCss = strip(readFileSync(resolve(here, "app.css"), "utf8"));

/** Every rule as [selectors, body], `@media` contents included. */
const rules = [...appCss.matchAll(/([^@{};\s][^{};]*)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
  body: m[2]!
}));

/** Selector -> what mounts or matches it only while work is running. */
const IN_FLIGHT_ONLY: Record<string, string> = {
  ".clone-destination-progress__dot": "CloneRepoDialog, while destinationsLoading",
  ".clone-progress__track.is-indeterminate > span": "clone/fork progress with no percent yet",
  ".msg-box__input--scan": "commit/squash message while drafting",
  ".bulk-sync__spinner": "bulk sync / clones panel while running",
  ".bulk-sync__bar > .is-in-flight": "bulk sync toast, repositories in flight",
  ".prune__spinner": "prune / reclaim panels while working",
  ".refs-tag-source__spin": "TagSourceStrip while checking",
  ".removal-toast__spinner": "App, while removalProgress !== null",
  ".pr-chip--checks-running .pr-chip__dot": "PR chip while checks run",
  '[aria-busy="true"] > .refresh-glyph': "refresh controls while busy",
  ".wt-btn__spinner": "sync/pull/push buttons while in flight",
  ".app-toast__track--indeterminate > span": "update toast, indeterminate download",
  ".cr-view__src.is-busy .cr-view__src-dot": "change-request source while loading"
};

const endless = rules.filter(({ body }) =>
  /(?:^|;)\s*animation(?:-iteration-count)?\s*:[^;]*\binfinite\b/.test(body)
);

describe("idle animations", () => {
  it("runs `infinite` animations only on in-flight state", () => {
    const unlisted = endless
      .flatMap((rule) => rule.selectors)
      .filter((selector) => !(selector in IN_FLIGHT_ONLY));
    expect(unlisted).toEqual([]);
  });

  it("lists no selector the stylesheet no longer animates forever", () => {
    const live = new Set(endless.flatMap((rule) => rule.selectors));
    expect(Object.keys(IN_FLIGHT_ONLY).filter((s) => !live.has(s))).toEqual([]);
  });

  it("settles HEAD's ring at the opacity its pulse ends on", () => {
    const body = rules
      .filter((rule) => rule.selectors.includes(".graph-lanes .head-ring"))
      .map((rule) => rule.body)
      .join(";");
    expect(body).toMatch(/animation\s*:\s*head-pulse\b[^;]*\s\d+\s*;/);
    // Without a resting value the ring would jump to opacity 1 when the
    // pulse stops; the keyframes start and end at 0.9.
    expect(body).toMatch(/(?:^|;)\s*opacity\s*:\s*0\.9\s*;/);
  });
});
