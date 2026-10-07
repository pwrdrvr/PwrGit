import { tmpdir } from "node:os";
import type { GitExec } from "../git/dugite";
import { readEffectiveGitIdentity } from "./git-identity-read";

export type GitIdentityDefaults = { name?: string; email?: string };

/**
 * The identity that seeds the first-run profile, asked of Git.
 *
 * This used to regex the first `name =` and `email =` anywhere in
 * `~/.gitconfig`: a `[github] name = handle` ahead of `[user]` seeded the
 * forge handle as the commit author, and an identity kept in an included
 * file seeded nothing. `git config --get` resolves sections, `include`, the
 * XDG file and `GIT_CONFIG_GLOBAL` the way every later commit will.
 *
 * Asked from the temp root, so no repository config or `includeIf
 * "gitdir:…"` can answer in place of the global identity. `configPath` is the
 * e2e seam (`PWRGIT_GITCONFIG`): Git reads that file as the global config.
 */
export async function readSeedIdentity(
  git: GitExec,
  configPath?: string
): Promise<GitIdentityDefaults> {
  const pinned: GitExec =
    configPath === undefined || configPath === ""
      ? git
      : (args, cwd, options) =>
          git(args, cwd, { ...options, env: { ...options?.env, GIT_CONFIG_GLOBAL: configPath } });
  const read = await readEffectiveGitIdentity(pinned, tmpdir(), configPath);
  return {
    ...(read.name !== null ? { name: read.name } : {}),
    ...(read.email !== null ? { email: read.email } : {})
  };
}
