import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import { openDatabase } from "../persistence/db";
import type { CommitAuthorRemoteCommit } from "../forge/commit-author";
import {
  GitHubCommitAuthorIdentityService,
  type GitHubCommitAuthorIdentityTransport
} from "./commit-author-identity";

/**
 * The rule review finding 1 on #594 broke: a signature belongs to one exact
 * commit, so a network lookup must learn it from that commit, never from
 * the email→account row another commit wrote.
 *
 * Model: one author, several commits, each signed by them or not. Look them
 * up over the network in any order, as often as you like. Oracle: every
 * lookup reports `signatureVerified` exactly when that commit was signed by
 * the author, and the forge is asked about each commit at most once while its
 * answer is fresh. The pre-fix service answered every commit after the first
 * from the account row without asking, so a signed second commit never read
 * as verified.
 */
const AUTHOR = { name: "Rowan Vale", email: "rowan@vale.example" };
const LOGIN = "rowan-vale";

describe("GitHubCommitAuthorIdentityService signatures (property)", () => {
  it("answers each network lookup with that exact commit's own signature verdict", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[0-9a-f]{40}$/), { minLength: 1, maxLength: 6 })
          .chain((shas) => fc.tuple(
            fc.constant(shas),
            fc.array(fc.boolean(), { minLength: shas.length, maxLength: shas.length }),
            fc.array(fc.nat({ max: shas.length - 1 }), { minLength: 1, maxLength: 12 })
          )),
        async ([shas, signed, order]) => {
          const db = openDatabase(":memory:");
          try {
            seedWorktree(db);
            const asked: string[] = [];
            const transport: GitHubCommitAuthorIdentityTransport = {
              fetchCommit: async ({ commitSha }) => {
                asked.push(commitSha);
                return remoteCommit(commitSha, signed[shas.indexOf(commitSha)] === true);
              }
            };
            const git: GitExec = async () =>
              ok({ stdout: "git@github.com:octo-org/example-repo.git\n", stderr: "", exitCode: 0 });
            const service = new GitHubCommitAuthorIdentityService(db, git, {
              transport,
              now: () => 1_000_000
            });

            for (const index of order) {
              const lookup = await service.request({
                worktreeId: "worktree-1",
                commitHash: shas[index]!,
                authorName: AUTHOR.name,
                authorEmail: AUTHOR.email
              }).completion;
              expect(lookup?.identity?.login).toBe(LOGIN);
              expect(lookup?.signatureVerified === true).toBe(signed[index] === true);
            }
            expect(new Set(asked).size).toBe(asked.length);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});

/** What GitHub answers for one of the author's commits. */
function remoteCommit(sha: string, signedByAuthor: boolean): CommitAuthorRemoteCommit {
  return {
    sha,
    author: AUTHOR,
    account: { id: 7, login: LOGIN },
    ...(signedByAuthor
      ? { signature: { valid: true, signedByForge: false, signerLogin: LOGIN } }
      : {})
  };
}

function seedWorktree(database: ReturnType<typeof openDatabase>): void {
  database
    .prepare("INSERT INTO profiles (id, name, email, roots) VALUES (?, ?, ?, ?)")
    .run("profile-1", "Personal", AUTHOR.email, "[]");
  database
    .prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
    .run("repo-1", "profile-1", "example-repo", "/example/repo");
  database
    .prepare("INSERT INTO worktrees (id, repo_id, branch, path) VALUES (?, ?, ?, ?)")
    .run("worktree-1", "repo-1", "main", "/example/repo");
}
