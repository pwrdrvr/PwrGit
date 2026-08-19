import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Commit, PrSummary } from "@pwrgit/shared";
import { CommitContextCard } from "./CommitContextCard";

const commit: Commit = {
  hash: "abc1234567890",
  shortHash: "abc1234",
  parents: ["parent"],
  subject: "Keep branch context honest",
  authorName: "Harold Hunt",
  authorEmail: "harold@example.com",
  committedAt: "2026-08-01T20:11:03.000Z",
  isMerge: false
};

function card(
  viewingBranch: string | null,
  defaultBranch = "main",
  defaultRef = "origin/main",
  githubIdentity?: { login: string; avatarUrl?: string },
  cardCommit: Commit = commit,
  pullRequest?: PrSummary
): string {
  return renderToStaticMarkup(
    <CommitContextCard
      commit={cardCommit}
      viewingBranch={viewingBranch}
      defaultBranch={defaultBranch}
      defaultRef={defaultRef}
      now={new Date("2026-08-01T21:00:00.000Z").getTime()}
      stats={null}
      githubIdentity={githubIdentity}
      pullRequest={pullRequest}
    />
  );
}

describe("CommitContextCard branch context", () => {
  it("omits branch labels for history already reachable from the base", () => {
    const markup = card(null);

    expect(markup).not.toContain("Viewing branch");
    expect(markup).not.toContain("Base branch");
    expect(markup).not.toContain("Base ref");
  });

  it("labels only a detached head's commits beyond the base", () => {
    const markup = card("detached@4025a6d");

    expect(markup).toContain("Viewing branch");
    expect(markup).toContain("detached@4025a6d");
    expect(markup).toContain("Base branch");
    expect(markup).toContain("main");
    expect(markup).not.toContain("Base ref");
  });

  it("makes a local default branch ahead of its remote explicit", () => {
    const markup = card("main");

    expect(markup).toContain("Viewing branch");
    expect(markup).toContain("Base ref");
    expect(markup).toContain("origin/main");
    expect(markup).not.toContain("Base branch");
  });
});

describe("CommitContextCard identity", () => {
  it("keeps the local Git author as the card identity when GitHub is unknown", () => {
    const markup = card(null);

    expect(markup).toContain("Harold Hunt");
    expect(markup).toContain("harold@example.com");
    expect(markup).toContain("commit-context-card__github-login--placeholder");
    expect(markup).not.toContain("commit-context-card__avatar-image");
  });

  it("adds a proven GitHub login and avatar without replacing local Git data", () => {
    const markup = card(null, "main", "origin/main", {
      login: "harold",
      avatarUrl:
        "pwrgit-avatar://thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=1000000"
    });

    expect(markup).toContain("Harold Hunt");
    expect(markup).toContain("harold@example.com");
    expect(markup).toContain("@harold");
    expect(markup).toContain("commit-context-card__github-login");
    expect(markup).not.toContain("commit-context-card__github-login--placeholder");
    expect(markup).toContain("commit-context-card__avatar-image");
    expect(markup).toContain("pwrgit-avatar://thumbnail/");
    expect(markup).toContain('decoding="sync"');
  });

  it("always labels a proven GitHub login even when the local name matches", () => {
    const markup = card(
      null,
      "main",
      "origin/main",
      { login: "huntharo" },
      { ...commit, authorName: "huntharo" }
    );

    expect(markup).toContain("huntharo");
    expect(markup).toContain("@huntharo");
    expect(markup).not.toContain("commit-context-card__github-login--placeholder");
  });
});

describe("CommitContextCard pull request", () => {
  it("shows the same clickable PR chip inside commit context", () => {
    const markup = card(
      null,
      "main",
      "origin/main",
      undefined,
      commit,
      {
        number: 29,
        url: "https://github.com/pwrdrvr/PwrGit/pull/29",
        title: "Anchor commit context",
        state: "merged",
        isDraft: false
      }
    );

    expect(markup).toContain("pr-chip--merged");
    expect(markup).toContain("merged #29");
    // The chip names the forge's own object type for screen readers.
    expect(markup).toContain("Pull request #29 (merged)");
  });
});
