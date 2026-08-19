import { describe, expect, it } from "vitest";
import {
  PR_DETAIL_COLUMNS,
  PR_SUMMARY_COLUMNS,
  prSummaryFromRow,
  prSummarySelect
} from "./pr-row";

describe("prSummarySelect", () => {
  it("projects every summary column, not just the identity ones", () => {
    const select = prSummarySelect("p");
    // The bug this guards: a projection that stopped at is_draft meant the
    // hover card could never show Changes or Timeline, whatever the cache held.
    for (const column of PR_SUMMARY_COLUMNS) {
      expect(select).toContain(`p.${column} AS pr_${column}`);
    }
    expect(select).toContain("p.additions AS pr_additions");
    expect(select).toContain("p.opened_at AS pr_opened_at");
  });

  it("honors the table alias and an empty prefix", () => {
    expect(prSummarySelect("branch_pr", "")).toContain(
      "branch_pr.number AS number"
    );
  });

  it("keeps the detail list a subset of the summary list", () => {
    // pr-service builds its INSERT from the detail half; if the two lists ever
    // diverge, a column gets selected but never written.
    for (const column of PR_DETAIL_COLUMNS) {
      expect(PR_SUMMARY_COLUMNS).toContain(column);
    }
  });
});

describe("prSummaryFromRow", () => {
  const full = {
    pr_number: 4242,
    pr_url: "https://gitlab.com/g/s/p/-/merge_requests/4242",
    pr_title: "Detailed",
    pr_state: "merged",
    pr_is_draft: 0,
    pr_forge: "gitlab",
    pr_host: "gitlab.com",
    pr_repo_path: "g/s/p",
    pr_head_ref: "feature",
    pr_base_ref: "main",
    pr_additions: 12,
    pr_deletions: 5,
    pr_changed_files: 3,
    pr_commit_count: 2,
    pr_opened_at: 1000,
    pr_merged_at: 2000,
    pr_closed_at: null
  };

  it("rebuilds the whole summary", () => {
    expect(prSummaryFromRow(full)).toEqual({
      number: 4242,
      url: full.pr_url,
      title: "Detailed",
      state: "merged",
      isDraft: false,
      forge: "gitlab",
      host: "gitlab.com",
      repoPath: "g/s/p",
      headRefName: "feature",
      baseRefName: "main",
      additions: 12,
      deletions: 5,
      changedFiles: 3,
      commitCount: 2,
      createdAt: 1000,
      mergedAt: 2000
    });
  });

  it("returns undefined when the join found no PR", () => {
    expect(prSummaryFromRow({ pr_number: null })).toBeUndefined();
    expect(prSummaryFromRow({})).toBeUndefined();
  });

  it("leaves unknown detail absent rather than zero", () => {
    const summary = prSummaryFromRow({
      pr_number: 7,
      pr_url: "u",
      pr_title: "t",
      pr_state: "open",
      pr_is_draft: 0
    });
    for (const key of ["additions", "changedFiles", "commitCount", "createdAt"]) {
      expect(summary).not.toHaveProperty(key);
    }
  });

  it("keeps a real zero, which is a different claim from absent", () => {
    expect(prSummaryFromRow({ ...full, pr_additions: 0 })?.additions).toBe(0);
  });

  it("guards the stored forge instead of trusting it", () => {
    // A stale row may hold anything; an unrecognized value must not reach the
    // renderer as if it were a ForgeKind.
    expect(prSummaryFromRow({ ...full, pr_forge: "bitbucket" })).not.toHaveProperty(
      "forge"
    );
    expect(prSummaryFromRow({ ...full, pr_forge: null })).not.toHaveProperty("forge");
  });

  it("maps unknown states to open rather than passing them through", () => {
    expect(prSummaryFromRow({ ...full, pr_state: "locked" })?.state).toBe("open");
    expect(prSummaryFromRow({ ...full, pr_state: null })?.state).toBe("open");
  });

  it("reads with an empty prefix, as the direct table reads do", () => {
    expect(
      prSummaryFromRow(
        { number: 1, url: "u", title: "t", state: "open", is_draft: 1, additions: 4 },
        ""
      )
    ).toMatchObject({ number: 1, isDraft: true, additions: 4 });
  });
});
