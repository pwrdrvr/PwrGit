import { describe, expect, it } from "vitest";
import {
  contributionShareChart,
  contributionShareOwners
} from "./contribution-share";
import {
  contributionWindow,
  type ContributionRecord,
  type ContributionRepo
} from "./contributions";

const identity = { id: "U1", login: "avery-q", host: "github.com" };
const window = contributionWindow(
  "2026-09-01",
  "2026-09-03",
  "UTC",
  new Date("2026-09-10T00:00:00Z")
);
const repo = (
  id: string,
  owner: string,
  name: string,
  ownerKind: ContributionRepo["ownerKind"] = "organization"
): ContributionRepo => ({
  id,
  path: `${owner}/${name}`,
  owner,
  ownerId: `O-${owner}`,
  ownerKind,
  visibility: "PRIVATE",
  archived: false,
  fork: false
});
const REPOS = {
  agent: repo("R1", "lantern-labs", "beacon"),
  snap: repo("R2", "lantern-labs", "shutter"),
  search: repo("R3", "northwind", "search-compare"),
  infra: repo("R4", "northwind", "kube-manifests"),
  dots: repo("R5", "avery-q", "dotfiles", "user"),
  friend: repo("R6", "jordan-p", "side-project", "user")
};
let serial = 0;
const merged = (
  target: ContributionRepo,
  count: number,
  day = "2026-09-02"
): ContributionRecord[] =>
  Array.from({ length: count }, () => ({
    id: `PR${++serial}`,
    repo: target,
    number: serial,
    mergedAt: `${day}T12:00:00Z`,
    mergedBy: "U1",
    author: "U1"
  }));
const records = [
  ...merged(REPOS.agent, 9),
  ...merged(REPOS.snap, 3, "2026-09-01"),
  ...merged(REPOS.search, 4),
  ...merged(REPOS.infra, 2, "2026-09-03"),
  ...merged(REPOS.dots, 2),
  ...merged(REPOS.friend, 1)
];
const MASKED_NAMES = [
  "northwind",
  "search-compare",
  "kube-manifests",
  "jordan-p",
  "side-project"
];

describe("contribution share image names", () => {
  it("ranks owners by volume and marks only the viewer's own namespace as theirs", () => {
    const owners = contributionShareOwners(records, identity, window);
    expect(
      owners.map((owner) => [owner.owner, owner.total, owner.viewer])
    ).toEqual([
      ["lantern-labs", 12, false],
      ["northwind", 6, false],
      ["avery-q", 2, true],
      ["jordan-p", 1, false]
    ]);
  });

  it("masks every namespace except the viewer's own by default", () => {
    const chart = contributionShareChart(
      records,
      identity,
      window,
      {},
      "org",
      {}
    );
    expect(chart.series.map((series) => series.label)).toEqual([
      "Org A",
      "Org B",
      "personal:avery-q",
      "User A"
    ]);
  });

  it("shows exactly the orgs the user chose and letters the rest by volume", () => {
    const chart = contributionShareChart(records, identity, window, {}, "org", {
      "O-lantern-labs": "show",
      "O-avery-q": "mask"
    });
    expect(chart.series.map((series) => series.label)).toEqual([
      "lantern-labs",
      "Org A",
      "Personal",
      "User A"
    ]);
  });

  it("numbers a masked org's repositories and keeps every masked name out of the chart", () => {
    const chart = contributionShareChart(
      records,
      identity,
      window,
      {},
      "repo",
      {
        "O-lantern-labs": "show"
      }
    );
    expect(chart.series.map((series) => series.label)).toEqual([
      "lantern-labs/beacon",
      "Org A/repo 1",
      "lantern-labs/shutter",
      "avery-q/dotfiles",
      "Org A/repo 2",
      "User A/repo 1"
    ]);
    const text = JSON.stringify(chart);
    for (const name of MASKED_NAMES) expect(text).not.toContain(name);
  });

  it("draws totals only with no names at all, and keeps every bucket's sum", () => {
    const chart = contributionShareChart(
      records,
      identity,
      window,
      {},
      "none",
      {
        "O-lantern-labs": "show"
      }
    );
    expect(chart.series).toEqual([
      { key: "__total", label: "Pull requests", total: 21 }
    ]);
    expect(chart.buckets.map((bucket) => bucket.values)).toEqual([
      [3],
      [16],
      [2]
    ]);
    const text = JSON.stringify(chart);
    for (const name of [...MASKED_NAMES, "lantern-labs", "beacon"])
      expect(text).not.toContain(name);
  });

  it("folds the tail into Other past eight series", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      merged(repo(`X${i}`, `org-${i}`, "app"), 11 - i)
    ).flat();
    const chart = contributionShareChart(many, identity, window, {}, "org", {});
    expect(chart.series).toHaveLength(9);
    expect(chart.series.at(-1)).toMatchObject({ label: "Other", total: 6 });
    expect(chart.series.at(-2)).toMatchObject({ label: "Org H" });
    expect(chart.buckets[1]?.values.reduce((a, b) => a + b, 0)).toBe(
      many.length
    );
  });
});
