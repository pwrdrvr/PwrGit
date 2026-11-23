import { commitIdentityArgs, SCRUBBED_IDENTITY_ENV, type CommitIdentity } from "./commit-identity";
import type { GitExec } from "./dugite";
import type { GitRunner } from "./stack-engine";

/** Desktop binding for the portable engine. Planning writes commit objects,
 * so the profile must be applied here, before Apply publishes those objects. */
export function createStackReplayRunner(git: GitExec, identity: CommitIdentity): GitRunner {
  const identityArgs = commitIdentityArgs(identity);
  return {
    async run(cwd, args, opts) {
      const createsCommits = args[0] === "replay" || args[0] === "rebase";
      const result = await git(createsCommits ? [...identityArgs, ...args] : args, cwd, {
        ...(opts?.stdin === undefined ? {} : { input: opts.stdin }),
        ...(createsCommits ? { env: { ...SCRUBBED_IDENTITY_ENV, GIT_EDITOR: "true" } } : {}),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
  };
}
