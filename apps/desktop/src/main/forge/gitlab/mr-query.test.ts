import { describe, expect, it } from "vitest";
import {
  buildMrBranchQuery,
  buildMrNumberQuery,
  parseMrPage,
  pickBestAssociation,
  pickBestByBranch,
  toSummary,
  type MrNode
} from "./mr-query";

function node(overrides: Partial<MrNode> = {}): MrNode {
  return {
    iid: "7",
    title: "Add a thing",
    webUrl: "https://gitlab.com/g/s/p/-/merge_requests/7",
    state: "opened",
    draft: false,
    sourceBranch: "feat-open",
    ...overrides
  };
}

describe("buildMrBranchQuery", () => {
  it("passes branches as a variable and batches them in one field", () => {
    const built = buildMrBranchQuery("pwrdrvr/qa/forge/PwrGit-Test", [
      "feat-open",
      "feat-merged"
    ]);

    expect(built.variables).toEqual({
      path: "pwrdrvr/qa/forge/PwrGit-Test",
      branches: ["feat-open", "feat-merged"],
      first: 100,
      after: null
    });
    // Unlike GitHub, one field covers every branch — no aliasing.
    expect(built.query).toContain("mergeRequests(sourceBranches: $branches");
    expect(built.query).toContain("sort: CREATED_DESC");
    expect(built.query).not.toContain("feat-open");
  });

  it("threads a cursor for the next page", () => {
    expect(buildMrBranchQuery("g/p", ["b"], "CURSOR").variables.after).toBe(
      "CURSOR"
    );
  });
});

describe("buildMrNumberQuery", () => {
  it("sends iids as strings, which is what the GitLab schema expects", () => {
    const built = buildMrNumberQuery("g/p", [4, 5]);
    expect(built.variables.iids).toEqual(["4", "5"]);
    expect(built.query).toContain("mergeRequests(iids: $iids");
  });
});

describe("parseMrPage", () => {
  it("reads nodes and page info, dropping nulls", () => {
    expect(
      parseMrPage({
        project: {
          mergeRequests: {
            nodes: [node(), null],
            pageInfo: { endCursor: "C", hasNextPage: true }
          }
        }
      })
    ).toEqual({ nodes: [node()], endCursor: "C", hasNextPage: true });
  });

  it("tolerates a project we cannot see", () => {
    expect(parseMrPage({ project: null })).toEqual({
      nodes: [],
      endCursor: null,
      hasNextPage: false
    });
    expect(parseMrPage(null)).toEqual({
      nodes: [],
      endCursor: null,
      hasNextPage: false
    });
  });
});

describe("toSummary", () => {
  it("parses the String iid GraphQL sends into a number", () => {
    expect(toSummary(node({ iid: "118" })).number).toBe(118);
    // REST hands back a real number for the same field.
    expect(toSummary(node({ iid: 118 })).number).toBe(118);
  });

  it("maps GitLab's lowercase states onto PrLifecycle", () => {
    expect(toSummary(node({ state: "opened" })).state).toBe("open");
    expect(toSummary(node({ state: "merged" })).state).toBe("merged");
    expect(toSummary(node({ state: "closed" })).state).toBe("closed");
    // A locked MR is still live; treating it as terminal would stop refreshes.
    expect(toSummary(node({ state: "locked" })).state).toBe("open");
  });

  it("reads draft from the boolean, not the title", () => {
    expect(toSummary(node({ draft: true })).isDraft).toBe(true);
    expect(toSummary(node({ draft: null, title: "Draft: x" })).isDraft).toBe(
      false
    );
  });

  it("fills absent title and url rather than emitting undefined", () => {
    expect(toSummary(node({ title: null, webUrl: null }))).toMatchObject({
      title: "",
      url: ""
    });
  });
});

describe("pickBestByBranch", () => {
  it("prefers a live MR over a newer terminal one", () => {
    const best = pickBestByBranch([
      node({ iid: "20", state: "closed", sourceBranch: "b" }),
      node({ iid: "10", state: "opened", sourceBranch: "b" })
    ]);
    expect(best.get("b")?.summary).toMatchObject({ number: 10, state: "open" });
  });

  it("falls back to the highest iid when none is live", () => {
    const best = pickBestByBranch([
      node({ iid: "10", state: "merged", sourceBranch: "b" }),
      node({ iid: "20", state: "closed", sourceBranch: "b" })
    ]);
    expect(best.get("b")?.summary.number).toBe(20);
  });

  it("groups per branch and ignores nodes with no source branch", () => {
    const best = pickBestByBranch([
      node({ iid: "1", sourceBranch: "a" }),
      node({ iid: "2", sourceBranch: "b" }),
      node({ iid: "3", sourceBranch: null }),
      node({ iid: "4", sourceBranch: "  " })
    ]);
    expect([...best.keys()].sort()).toEqual(["a", "b"]);
  });
});

describe("pickBestAssociation", () => {
  it("returns null when a commit has no merge request", () => {
    expect(pickBestAssociation([])).toBeNull();
  });

  it("prefers a live association, then the newest", () => {
    expect(
      pickBestAssociation([
        node({ iid: "5", state: "merged" }),
        node({ iid: "3", state: "opened" })
      ])?.number
    ).toBe(3);
    expect(
      pickBestAssociation([
        node({ iid: "5", state: "merged" }),
        node({ iid: "9", state: "merged" })
      ])?.number
    ).toBe(9);
  });
});
