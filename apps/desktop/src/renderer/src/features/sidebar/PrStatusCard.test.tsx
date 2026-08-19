import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwrgit/shared";
import { PrStatusCard } from "./PrStatusCard";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 121,
    url: "https://github.com/pwrdrvr/PwrGit/pull/121",
    title: "Read merge request status from GitLab",
    state: "open",
    isDraft: false,
    ...overrides
  };
}

function render(overrides: Partial<PrSummary> = {}): string {
  return renderToStaticMarkup(<PrStatusCard pr={pr(overrides)} now={NOW} />);
}

describe("PrStatusCard", () => {
  it("uses each forge's own word and reference form", () => {
    const github = render({ forge: "github", repoPath: "pwrdrvr/PwrGit" });
    expect(github).toContain("Pull request");
    expect(github).toContain("pwrdrvr/PwrGit#121");

    const gitlab = render({
      forge: "gitlab",
      repoPath: "pwrdrvr/qa/forge/PwrGit-Test",
      number: 4
    });
    expect(gitlab).toContain("Merge request");
    // `!4` is what GitLab itself shows, and what pastes back into it.
    expect(gitlab).toContain("pwrdrvr/qa/forge/PwrGit-Test!4");
  });

  it("falls back to the app's neutral term for a row with no forge stamp", () => {
    // Rows cached before forge identity existed never gain it.
    expect(render()).toContain("Pull request");
  });

  it("renders the branch flow when both ends are known", () => {
    const html = render({ headRefName: "feat-x", baseRefName: "main" });
    expect(html).toContain("feat-x");
    expect(html).toContain("main");
  });

  it("shows the head branch alone when the base is unknown", () => {
    const html = render({ headRefName: "feat-x" });
    expect(html).toContain("feat-x");
    expect(html).not.toContain("pr-status-card__branch-base");
  });

  it("omits every section it has no evidence for", () => {
    const html = render();
    expect(html).not.toContain("Changes");
    expect(html).not.toContain("Timeline");
    // No dashes, no "unknown", no empty headers.
    expect(html).not.toContain("—");
    expect(html).not.toContain("unknown");
  });

  it("never renders a missing count as zero", () => {
    // changedFiles absent must not become "0 files": "not known" and "changes
    // nothing" are different claims.
    const html = render({ additions: 10, deletions: 2 });
    expect(html).toContain("+10");
    expect(html).not.toContain("0 files");
    expect(html).not.toContain("0 commits");
  });

  it("renders a real zero, which is a different claim from absent", () => {
    const html = render({ additions: 0, deletions: 0, changedFiles: 0 });
    expect(html).toContain("0 files");
  });

  it("proportions the meter by the diff split", () => {
    const html = render({ additions: 75, deletions: 25 });
    expect(html).toContain("width:75%");
    expect(html).toContain("width:25%");
  });

  it("omits the meter for an empty diff, which has no proportion", () => {
    expect(render({ additions: 0, deletions: 0 })).not.toContain(
      "pr-status-card__meter"
    );
  });

  it("singularizes counts", () => {
    const html = render({ changedFiles: 1, commitCount: 1 });
    expect(html).toContain("1 file");
    expect(html).not.toContain("1 files");
    expect(html).toContain("1 commit");
    expect(html).not.toContain("1 commits");
  });

  it("reports only the transitions that actually happened", () => {
    const merged = render({
      state: "merged",
      createdAt: NOW - 3 * 60 * 60 * 1000,
      mergedAt: NOW - 60 * 60 * 1000,
      // GitHub reports closedAt for a merged PR; it is not also "Closed".
      closedAt: NOW - 60 * 60 * 1000
    });
    expect(merged).toContain("Opened");
    expect(merged).toContain("Merged");
    expect(merged).not.toContain("Closed");

    const closed = render({
      state: "closed",
      createdAt: NOW - 3 * 60 * 60 * 1000,
      closedAt: NOW - 60 * 60 * 1000
    });
    expect(closed).toContain("Closed");
    expect(closed).not.toContain("Merged");
  });

  it("marks an open draft, and lets a terminal state win over a stale draft bit", () => {
    expect(render({ state: "open", isDraft: true })).toContain("draft");
    expect(render({ state: "merged", isDraft: true })).not.toContain("draft");
  });
});
