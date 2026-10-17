// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  contributionShareChart,
  contributionWindow,
  type ContributionShareChart
} from "@pwrgit/shared";
import { contributionFixture } from "./contribution-fixture";
import { niceTicks, shareImageSvg, shareImageTitle } from "./share-image";

const style = {
  title: "PRs merged",
  yLabel: "merged pull requests",
  interval: "day",
  theme: "light"
} as const;

describe("share image", () => {
  it("ticks at round values instead of zero, half and max", () => {
    expect(niceTicks(91)).toEqual({
      top: 100,
      ticks: [0, 20, 40, 60, 80, 100]
    });
    expect(niceTicks(68).ticks).toEqual([0, 20, 40, 60, 80]);
    expect(niceTicks(3)).toEqual({ top: 3, ticks: [0, 1, 2, 3] });
    expect(niceTicks(0)).toEqual({ top: 1, ticks: [0, 1] });
  });

  it("titles the chart with the account only when asked, and flags a partial today", () => {
    const window = contributionWindow(
      "2026-08-01",
      "2026-10-11",
      "America/New_York",
      new Date("2026-10-11T19:19:00Z")
    );
    const base = {
      metric: "merged",
      group: "org",
      interval: "day",
      window
    } as const;
    expect(shareImageTitle({ ...base, login: "demo-user" })).toBe(
      "PRs merged by demo-user · Aug 1 – Oct 11, 2026 · today partial (America/New_York)"
    );
    expect(
      shareImageTitle({ ...base, login: null, group: "repo", interval: "week" })
    ).toBe(
      "Weekly PRs merged by repository · Aug 1 – Oct 11, 2026 · today partial (America/New_York)"
    );
  });

  it("draws labels as text only: no tooltips, no metadata, and escaped", () => {
    const chart: ContributionShareChart = {
      series: [
        { key: "a", label: "R&D <core>", total: 3 },
        { key: "__other", label: "Other", total: 1, other: true }
      ],
      buckets: [
        { date: "2026-09-30", total: 1, values: [1, 0] },
        { date: "2026-10-01", total: 3, values: [2, 1] }
      ]
    };
    const svg = shareImageSvg(chart, style);
    expect(svg).toContain("R&amp;D &lt;core&gt;");
    expect(svg).not.toMatch(/<title|<desc|<metadata|data-/);
    expect(
      new DOMParser()
        .parseFromString(svg, "image/svg+xml")
        .querySelector("parsererror")
    ).toBeNull();
    // Three bar segments, plus the background and two legend swatches.
    expect(svg.match(/<rect /g)).toHaveLength(6);
    expect(svg).toContain(">Oct 01<");
  });

  it("keeps masked namespaces out of the picture entirely", () => {
    const snapshot = contributionFixture();
    const chart = contributionShareChart(
      snapshot.records,
      snapshot.identity,
      snapshot.window,
      {},
      "repo",
      { DEMO_O1: "show" }
    );
    const svg = shareImageSvg(chart, style);
    expect(svg).toContain("demo-org1/canvas");
    expect(svg).toContain("demo-user/notes");
    for (const hidden of ["demo-org0", "orbit", "demo-org2", "relay"])
      expect(svg).not.toContain(hidden);
  });

  it("draws total-only with no legend", () => {
    const snapshot = contributionFixture();
    const chart = contributionShareChart(
      snapshot.records,
      snapshot.identity,
      snapshot.window,
      {},
      "none",
      {}
    );
    const svg = shareImageSvg(chart, { ...style, theme: "dark" });
    expect(svg).not.toContain("Pull requests");
    expect(svg).not.toContain("demo-");
  });
});
