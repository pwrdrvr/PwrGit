import { describe, expect, it } from "vitest";
import { signedByAuthor } from "../commit-author";
import type { ForgeRepo } from "../types";
import { GhCliCommitAuthorIdentityTransport } from "./commit-author-transport";

// Asks real GitHub through the signed-in `gh`, so it never runs in CI. Run it
// when the query or its parser changes:
//   PWRGIT_GH_ORACLE=1 pnpm vitest run commit-author-transport.oracle
const enabled = process.env.PWRGIT_GH_ORACLE === "1";

const REPO: ForgeRepo = { kind: "github", host: "github.com", path: "pwrdrvr/PwrGit" };
/** A squash merge: GitHub signed it as `web-flow`. */
const SQUASH_MERGE = "34068a8f5bf6c94fc2e7d737e23938b28401ef68";
/** A commit its author signed locally with an SSH key and pushed (#594). */
const AUTHOR_SIGNED = "26f8ef327270e26b2debbef1db2776f90fe7a82d";
const NOT_ON_GITHUB = "0123456789012345678901234567890123456789";

describe.skipIf(!enabled)("GhCliCommitAuthorIdentityTransport against GitHub", () => {
  it("answers several commits in one request with GitHub's own signature verdicts", async () => {
    const answers = await new GhCliCommitAuthorIdentityTransport().fetchCommits(REPO, [
      SQUASH_MERGE,
      AUTHOR_SIGNED,
      NOT_ON_GITHUB
    ]);

    expect([...answers.keys()]).toEqual([SQUASH_MERGE, AUTHOR_SIGNED]);

    const merged = answers.get(SQUASH_MERGE)!;
    expect(merged.account?.login).toBeTruthy();
    expect(merged.signature).toEqual({ valid: true, signedByForge: true, signerLogin: "web-flow" });
    expect(signedByAuthor(merged)).toBe(false);

    const signed = answers.get(AUTHOR_SIGNED)!;
    expect(signed.signature).toMatchObject({ valid: true, signedByForge: false });
    expect(signed.signature?.signerLogin?.toLowerCase()).toBe(signed.account?.login.toLowerCase());
    expect(signedByAuthor(signed)).toBe(true);
  });
});
