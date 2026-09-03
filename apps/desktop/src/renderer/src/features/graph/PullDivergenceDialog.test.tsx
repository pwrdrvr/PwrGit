import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DivergenceCommit, RemoteDivergence } from "@pwrgit/shared";
import { PullDivergenceDialog } from "./PullDivergenceDialog";

function commit(shortHash: string, subject: string): DivergenceCommit {
  return {
    hash: shortHash.padEnd(40, "0"),
    shortHash,
    subject,
    additions: 1,
    deletions: 0
  };
}

const divergence: RemoteDivergence = {
  branch: "main",
  head: "1".repeat(40),
  upstream: "origin/main",
  upstreamHead: "2".repeat(40),
  workingTreeClean: true,
  localCommits: [commit("aaa1111", "local work")],
  upstreamCommits: [commit("bbb2222", "their work")],
  alignedCommits: [
    {
      local: commit("aaa1111", "local work"),
      upstream: null,
      relation: "local-only"
    },
    {
      local: null,
      upstream: commit("bbb2222", "their work"),
      relation: "upstream-only"
    }
  ],
  matchingCommitSubjects: false
};

function markup(): string {
  return renderToStaticMarkup(
    <PullDivergenceDialog
      divergence={divergence}
      busy={null}
      onClose={() => undefined}
      onRebase={() => undefined}
      onReset={() => undefined}
      onResetElsewhere={() => undefined}
    />
  );
}

describe("diverged-pull recovery dialog", () => {
  /**
   * The commit-alignment view is shared with the reset dialog, which calls the
   * far side "the target". Naming it generically there once rewrote this
   * dialog's labels too, and only the four-minute E2E noticed.
   */
  it("names the far side as the upstream, not as a generic other side", () => {
    const html = markup();

    expect(html).toContain("Only on the upstream branch");
    expect(html).toContain("Not present upstream");
    expect(html).toContain("Only on the local branch");
    expect(html).not.toContain("the other branch");
    expect(html).not.toContain("the target");
  });

  it("keeps both recovery actions and the escape hatch to another branch", () => {
    const html = markup();

    expect(html).toContain("Rebase local commits");
    expect(html).toContain("Reset to remote…");
    expect(html).toContain("Reset to a different branch…");
  });
});
