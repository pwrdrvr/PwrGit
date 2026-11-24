import { runCommand, type CommandRunner } from "@pwrgit/mcp-server";
import { cliSearchPath } from "../forge/cli-runner";
import type { GitExec } from "../git/dugite";
import { githubCredentials } from "../github/gh-cli";
import { GhAccountUnavailableError } from "../github/gh-account";

/** Environment additions that make one `gh` spawn read as its host's pinned
 *  account — `GitHubCredentials.spawnEnv`. */
export type GhAccountEnv = (
  args: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
) => Promise<Record<string, string> | undefined>;

/**
 * Use the desktop's bundled Git while retaining the MCP forge CLI runner.
 *
 * The MCP server's `gh` commands read as the same account Settings → Forges
 * names for that host: they go through the app's credential store, exactly
 * like the app's own `gh` spawns. A pinned account that no longer resolves
 * answers as a failed command (the server reports the forge as unavailable),
 * never as a run under gh's active account.
 */
export function createDesktopMcpRunner(
  execGit: GitExec,
  fallback: CommandRunner = runCommand,
  ghAccountEnv: GhAccountEnv = (args, env) => githubCredentials.spawnEnv(args, env)
): CommandRunner {
  return async (command, args, options) => {
    if (command !== "git") {
      let account: Record<string, string> | undefined;
      if (command === "gh") {
        try {
          account = await ghAccountEnv(args, options.env);
        } catch (cause) {
          if (!(cause instanceof GhAccountUnavailableError)) throw cause;
          return { exitCode: 4, stdout: "", stderr: cause.message };
        }
      }
      return fallback(command, args, {
        ...options,
        env: { ...options.env, ...account, PATH: cliSearchPath() }
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const result = await execGit([...args], options.cwd, {
        signal: controller.signal,
        env: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  };
}
