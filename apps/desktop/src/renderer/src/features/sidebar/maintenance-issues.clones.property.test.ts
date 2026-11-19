import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { MaintenanceRepoResult, MaintenanceSummary, ReshareWorktreeResult } from "@pwrgit/shared";
import { clonesCardCopy, clonesStepLine, issueReport, issuesReport, looksLikeRawGit, stepIssues } from "./maintenance-issues";

/**
 * Main reports Clones per worktree (`reshare.worktrees`). The Combined card
 * must keep that grain: one row per worktree Git failed in, naming its path
 * and carrying Git's words, so several failures can be told apart and copied.
 * It once folded them into the repository's count sentence ("· 1 failed"),
 * and the worktree, its path and Git's text were gone.
 */

const gitWords = fc.oneof(
  fc.constant("fatal: gitfile does not point to a valid repository: /src/docs-wt/.git"),
  fc.constant("error: could not clone 'assets/hero.webp': Operation not permitted"),
  fc.constant("spawn git ENOENT"),
  fc.stringMatching(/^[a-z][a-z .:'/-]{4,40}$/)
);

/** A worktree as main reports it, with the message main builds. */
const worktree = (repo: string, index: number) =>
  fc.record({
    outcome: fc.constantFrom<ReshareWorktreeResult["outcome"]>("reshared", "already_shared", "skipped", "failed"),
    branch: fc.constantFrom("main", "docs/refresh", "agent/quiet-heron", ""),
    gitError: fc.option(gitWords, { nil: undefined }),
    exitCode: fc.option(fc.constantFrom(0, 1, 128), { nil: undefined }),
    // Git printed no summary (message is Git's words alone) or a summary
    // with failed files (main's count sentence, then Git's words).
    noSummary: fc.boolean()
  }).map(({ outcome, branch, gitError, exitCode, noSummary }): ReshareWorktreeResult => {
    const base = {
      worktreeId: `${repo}-wt${index}`,
      path: `/src/${repo}-worktrees/wt-${index}`,
      branch,
      outcome,
      reshared: 0,
      alreadyShared: 0,
      skipped: 0,
      failed: 0,
      sharedBytes: null
    };
    if (outcome !== "failed") return { ...base, message: "3 files re-shared." };
    const counts = "3 files re-shared · 2 files failed.";
    const message = gitError === undefined
      ? noSummary ? `Git exited ${exitCode ?? 128} without a summary.` : counts
      : noSummary ? gitError : `${counts} ${gitError}`;
    return {
      ...base,
      failed: 2,
      message,
      ...(gitError === undefined ? {} : { gitError }),
      ...(exitCode === undefined ? {} : { exitCode })
    };
  });

const repoResult = (index: number) => {
  const name = `repo-${index}`;
  const repo = { id: name, name, path: `/src/${name}`, profileId: "p", profileName: "P" };
  return fc.oneof(
    // A repository Clones ran in.
    fc.record({
      worktrees: fc.integer({ min: 0, max: 5 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => worktree(name, i)))),
      mainFailed: fc.boolean()
    }).map(({ worktrees, mainFailed }): MaintenanceRepoResult => {
      const failed = worktrees.filter((wt) => wt.outcome === "failed").length;
      return {
        repo,
        outcome: failed === 0 && !mainFailed ? "success" : failed === worktrees.length && worktrees.length > 0 ? "failed" : "partial",
        message: `${worktrees.length} worktrees · nothing new to share${failed > 0 ? ` · ${failed} failed` : ""}.`,
        reshare: {
          main: mainFailed
            ? { outcome: "failed", message: "Main checkout not updated: the fetch failed." }
            : { outcome: "not_requested", message: "Main checkout not updated." },
          worktrees
        }
      };
    }),
    // A repository that failed before any worktree ran.
    fc.constant<MaintenanceRepoResult>({ repo, outcome: "failed", message: "fatal: unable to read the worktree list" })
  );
};

const summaries = fc.integer({ min: 1, max: 4 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => repoResult(i))))
  .map((results): MaintenanceSummary => ({
    operationId: "op",
    startedAt: "2026-11-19T00:00:00.000Z",
    finishedAt: "2026-11-19T00:01:00.000Z",
    cancelled: false,
    results
  }));

describe("Clones problems in Combined maintenance, for any result", () => {
  it("lists each failed worktree as its own row, with its path, Git's words and exit code", () => {
    fc.assert(
      fc.property(summaries, (summary) => {
        const issues = stepIssues(summary, "clones");
        const failed = summary.results.flatMap((row) =>
          (row.reshare?.worktrees ?? []).filter((wt) => wt.outcome === "failed").map((wt) => ({ row, wt })));
        const rows = issues.filter((issue) => issue.kind === "worktree");
        // One row per failed worktree, in main's order.
        expect(rows.map((issue) => issue.path)).toEqual(failed.map(({ wt }) => wt.path));
        rows.forEach((issue, index) => {
          const { row, wt } = failed[index]!;
          expect(issue).toMatchObject({ repo: row.repo.name, repoPath: row.repo.path, branch: wt.branch });
          expect(issue.exitCode).toBe(wt.exitCode);
          // Git's words are kept whole, behind Details, and never lead.
          if (wt.gitError !== undefined) expect(issue.raw).toBe(wt.gitError);
          expect(looksLikeRawGit(issue.reason)).toBe(false);
          if (wt.gitError !== undefined) expect(issue.reason).not.toContain(wt.gitError);
          // What Copy puts on the clipboard identifies and explains the failure.
          const report = issueReport(issue, "Clones");
          expect(report).toContain(`Worktree: ${wt.path}`);
          expect(report).toContain(`Repository: ${row.repo.path}`);
          if (wt.gitError !== undefined) expect(report).toContain(`Git: ${wt.gitError}`);
          if (wt.exitCode !== undefined) expect(report).toContain(`Exit code: ${wt.exitCode}`);
        });
      })
    );
  });

  it("keeps every other problem, and the counts agree with the rows", () => {
    fc.assert(
      fc.property(summaries, (summary) => {
        const issues = stepIssues(summary, "clones");
        const expected = summary.results.reduce((sum, row) => {
          const report = row.reshare;
          const own = (report?.worktrees ?? []).filter((wt) => wt.outcome === "failed").length +
            (report?.main.outcome === "failed" ? 1 : 0);
          // A repository with nothing per worktree to show is one row, as before.
          return sum + (own > 0 ? own : row.outcome === "success" ? 0 : 1);
        }, 0);
        expect(issues).toHaveLength(expected);
        const line = clonesStepLine(null, 1, 41, issues);
        expect(line.endsWith(issues.length > 0 ? ` · ${issues.length} failed` : "41 worktrees")).toBe(true);
        if (issues.length === 0) return;
        const card = clonesCardCopy(issues, 41);
        expect(card.headline).toContain(String(issues.length));
        // Copy all holds every row, in order, under the card's headline.
        const all = issuesReport(card.headline, issues, "Clones");
        expect(all.startsWith(card.headline)).toBe(true);
        let from = 0;
        for (const issue of issues) {
          const at = all.indexOf(issueReport(issue, "Clones"), from);
          expect(at).toBeGreaterThanOrEqual(from);
          from = at + 1;
        }
      })
    );
  });
});
