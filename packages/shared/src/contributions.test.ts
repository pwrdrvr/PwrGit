import { describe, expect, it } from "vitest";
import { aggregateAuthorFlow, aggregateContributions, contributionCsv, contributionWindow, defaultContributionDates, type ContributionRecord } from "./contributions";

const repo = { id: "R1", path: "sample-org/widget", owner: "sample-org", ownerId: "O1", ownerKind: "organization" as const, archived: false, fork: true, visibility: "PRIVATE" };
const record = (id: string, mergedAt: string, mergedBy = "U1", author = "U2"): ContributionRecord => ({ id, repo, number: 1, mergedAt, mergedBy, author });

describe("contribution dates and aggregation", () => {
  it("pins six calendar months at month ends, leap years and the last complete local day", () => {
    expect(defaultContributionDates("America/New_York", new Date("2024-08-31T15:00:00Z"))).toEqual({ startDate: "2024-02-29", endDate: "2024-08-30" });
    const window = contributionWindow("2026-04-11", "2026-10-10", "America/New_York");
    expect(window.start).toBe("2026-04-11T04:00:00.000Z");
    expect(window.end).toBe("2026-10-11T04:00:00.000Z");
    expect(aggregateContributions([], "U1", window).days).toHaveLength(183);
  });
  it("freezes a partial today cutoff and keeps its inclusive average separate from complete-day average", () => {
    const now = new Date("2026-08-03T16:00:00Z");
    const window = contributionWindow("2026-08-01", "2026-08-03", "America/New_York", now);
    expect(window.end).toBe(now.toISOString()); expect(window.partialDay).toBe(true);
    const result = aggregateContributions([record("1", "2026-08-01T15:00:00Z"), record("2", "2026-08-02T15:00:00Z"), record("3", "2026-08-03T15:00:00Z"), record("4", now.toISOString())], "U1", window);
    expect(result.total).toBe(3); expect(result.completeTotal).toBe(2);
    expect(result.perCompleteDay).toBe(1); expect(result.perCalendarDay).toBe(1);
    expect(result.completeDays).toBe(2); expect(result.calendarDays).toBe(3);
  });
  it("reconstructs shifted historical backlog through closes/reopens and counts the authored cohort separately", () => {
    const window = contributionWindow("2026-08-01", "2026-08-03", "UTC");
    const life = (createdAt: string, events: { kind: "closed" | "reopened"; at: string }[], state: "OPEN" | "MERGED") => ({ createdAt, updatedAt: "2026-08-04T15:00:00Z", closedAt: null, state, complete: true, cursor: null, events: events.map((event, i) => ({ ...event, id: `E${i}` })) });
    const rows: ContributionRecord[] = [
      { ...record("older", window.start, "U2", "U1"), mergedAt: null, lifecycle: life("2026-01-01T00:00:00Z", [{ kind: "closed", at: "2026-08-02T12:00:00Z" }, { kind: "reopened", at: "2026-08-03T12:00:00Z" }], "OPEN") },
      { ...record("cohortMerged", "2026-08-02T10:00:00Z", "BOT", "U1"), lifecycle: life("2026-08-01T08:00:00Z", [], "MERGED") },
      { ...record("cohortClosed", window.start, "U2", "U1"), mergedAt: null, lifecycle: life("2026-08-01T09:00:00Z", [{ kind: "closed", at: "2026-08-01T12:00:00Z" }, { kind: "reopened", at: "2026-08-02T13:00:00Z" }, { kind: "closed", at: "2026-08-03T13:00:00Z" }, { kind: "reopened", at: "2026-08-04T13:00:00Z" }], "OPEN") },
      record("otherAuthor", "2026-08-01T10:00:00Z", "U1", "U2")
    ];
    const result = aggregateAuthorFlow(rows, "U1", window);
    expect(result.complete).toBe(true); expect(result.baseline).toBe(1); expect(result.ending).toBe(1);
    expect(result.days.map(day => day.open)).toEqual([2, 1, 1]);
    expect(result.created).toBe(2); expect(result.merged).toBe(1);
    expect(result.unmergedEnding).toBe(result.unmergedBaseline + result.created - result.merged);
    let stock = result.baseline;
    for (const day of result.days) { stock += day.created + day.reopened - day.merged - day.closedUnmerged; expect(day.open).toBe(stock); }
    expect(result.closedUnmerged).toBe(3); expect(result.reopened).toBe(2);
    expect(result.cohortMergePercentage).toBe(50); expect(result.cohortNotMerged).toBe(1); expect(result.cohortClosed).toBe(1);
    expect(aggregateContributions(rows, "U1", window).total).toBe(1);
    const shifted = contributionWindow("2026-08-02", "2026-08-03", "UTC");
    expect(aggregateAuthorFlow(rows, "U1", shifted).baseline).toBe(2);
    expect(aggregateContributions(rows, "U1", window, { metric: "created" }).total).toBe(2);
  });
  it("neutralizes spreadsheet formulas in forge metadata", () => {
    expect(contributionCsv(["name"], [["=HYPERLINK(1)"]])).toContain("'=HYPERLINK(1)");
  });
  it("uses half-open local-day boundaries and handles both copies of the DST rollback hour", () => {
    const window = contributionWindow("2026-11-01", "2026-11-01", "America/New_York", new Date("2027-01-01T00:00:00Z"));
    expect(window.end).toBe("2026-11-02T05:00:00.000Z");
    const result = aggregateContributions([
      record("before", "2026-11-01T03:59:59Z"), record("first", window.start),
      record("hour1", "2026-11-01T05:30:00Z"), record("hour2", "2026-11-01T06:30:00Z"), record("after", window.end)
    ], "U1", window);
    expect(result.total).toBe(3);
    expect(result.days[0]?.total).toBe(3);
  });
  it("separates merge actor, author and overlap, dedups immutable identity and retains Other totals", () => {
    const window = contributionWindow("2026-05-01", "2026-05-03", "UTC");
    const rows = [record("P1", window.start), record("P1", window.start), record("P2", window.start, "BOT", "U1"), record("P3", window.start, "U1", "U1"), record("P4", window.start, null as unknown as string, "U1"), { ...record("P5", window.start), repo: { ...repo, id: "R2", path: "sample-user/other", ownerKind: "user" as const, ownerId: "U9", owner: "sample-user" } }];
    const result = aggregateContributions(rows, "U1", window, { topN: 1, group: "repo" });
    expect(result.total).toBe(3);
    expect(result.authored).toBe(3);
    expect(result.overlap).toBe(1);
    expect(result.calendarDays).toBe(3);
    expect(result.activeDays).toBe(1);
    expect(result.days.map(d => d.total)).toEqual([3, 0, 0]);
    expect(result.series.map(s => s.total)).toEqual([2, 1]);
    expect(result.series[1]?.label).toBe("Other");
    expect(result.series.reduce((sum, s) => sum + s.total, 0)).toBe(result.total);
    expect(aggregateContributions(rows, "U1", window, { ownerId: "O1" }).total).toBe(2);
    expect(aggregateContributions(rows, "U1", window, { metric: "authored", interval: "week" }).total).toBe(3);
  });
  it("buckets scalar mergedAt before midnight/cutoff while merge and paired close events lag one second", () => {
    const mergedAt = "2026-08-02T03:59:59Z", eventAt = "2026-08-02T04:00:00Z";
    const pr: ContributionRecord = { ...record("LAG", mergedAt, "U1", "U1"), lifecycle: {
      createdAt: "2026-07-01T12:00:00Z", updatedAt: eventAt, closedAt: eventAt, state: "MERGED", complete: true, cursor: null,
      events: [{ id: "C", kind: "closed", at: eventAt }, { id: "M", kind: "merged", at: eventAt }]
    } };
    const window = contributionWindow("2026-08-01", "2026-08-01", "America/New_York");
    const result = aggregateAuthorFlow([pr], "U1", window);
    expect(result.baseline).toBe(1); expect(result.ending).toBe(0);
    expect(result.merged).toBe(1); expect(result.closedUnmerged).toBe(0);
    expect(aggregateContributions([pr], "U1", window).days[0]?.total).toBe(1);
    const next = aggregateAuthorFlow([pr], "U1", contributionWindow("2026-08-02", "2026-08-02", "America/New_York"));
    expect(next.baseline).toBe(0); expect(next.merged).toBe(0); expect(next.closedUnmerged).toBe(0);
  });

});
