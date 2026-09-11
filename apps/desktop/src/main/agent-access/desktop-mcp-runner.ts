import { runCommand, type CommandRunner } from "@pwrgit/mcp-server";
import { cliSearchPath } from "../forge/cli-runner";
import type { GitExec } from "../git/dugite";

/** Use the desktop's bundled Git while retaining the MCP forge CLI runner. */
export function createDesktopMcpRunner(execGit: GitExec, fallback: CommandRunner = runCommand): CommandRunner {
  return async (command, args, options) => {
    if (command !== "git") return fallback(command, args, {
      ...options, env: { ...options.env, PATH: cliSearchPath() }
    });
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
