import type { ChangeRequestEntry } from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import { filterChangeRequests } from "./RepoChangeRequests";
import { matchedViaChangeRequest } from "./RepoRefsModal";

const entry = (
  number: number,
  title: string,
  head: string,
  author = "octocat"
): ChangeRequestEntry => ({
  pr: {
    number,
    url: `https://github.com/octo/orbit/pull/${number}`,
    title,
    state: "open",
    isDraft: false,
    headRefName: head,
    author
  },
  location: { kind: "unfetched", branch: head }
});

describe("filterChangeRequests", () => {
  const entries = [
    entry(1060, "chore: unrelated", "chore/x"),
    entry(106, "feat: rebuild the console", "codex/console"),
    entry(119, "Bump jest", "dependabot/jest", "dependabot")
  ];

  it("keeps everything for an empty query, in the list's order", () => {
    expect(filterChangeRequests(entries, " ").map((e) => e.pr.number)).toEqual([1060, 106, 119]);
  });

  it("answers a number with that change request only", () => {
    expect(filterChangeRequests(entries, "106").map((e) => e.pr.number)).toEqual([106]);
    expect(filterChangeRequests(entries, "#106").map((e) => e.pr.number)).toEqual([106]);
  });

  it("matches title, head and author", () => {
    expect(filterChangeRequests(entries, "console").map((e) => e.pr.number)).toEqual([106]);
    expect(filterChangeRequests(entries, "dependabot").map((e) => e.pr.number)).toEqual([119]);
    expect(filterChangeRequests(entries, "chore/").map((e) => e.pr.number)).toEqual([1060]);
  });
});

describe("matchedViaChangeRequest", () => {
  const pr = {
    number: 106,
    url: "https://github.com/octo/orbit/pull/106",
    title: "feat: rebuild the console",
    state: "open" as const,
    isDraft: false
  };

  it("says so when only the PR explains the row", () => {
    expect(matchedViaChangeRequest("codex/plan origin/codex/plan wip", pr, "rebuild")).toBe(true);
    expect(matchedViaChangeRequest("codex/plan origin/codex/plan wip", pr, "plan")).toBe(false);
  });

  it("credits a number query to the PR even when the digits are in the name", () => {
    expect(matchedViaChangeRequest("issue-106-fix", pr, "106")).toBe(true);
  });

  it("stays quiet without a query or a PR", () => {
    expect(matchedViaChangeRequest("x", pr, "")).toBe(false);
    expect(matchedViaChangeRequest("x", undefined, "x")).toBe(false);
  });
});
