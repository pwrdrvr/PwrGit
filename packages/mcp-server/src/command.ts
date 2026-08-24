import { execFile } from "node:child_process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number }
) => Promise<CommandResult>;

/** Spawn without a shell, a TTY, inherited credentials in arguments, or an
 * interactive prompt. Output is bounded because forge CLIs talk to remote
 * services and a malformed response must not consume the MCP process. */
export const runCommand: CommandRunner = async (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GCM_INTERACTIVE: "never",
          GH_PROMPT_DISABLED: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GLAB_PROMPT_DISABLED: "1",
          LC_ALL: "C"
        },
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(
          new Error(
            `${command} could not be executed: ${
              error.code === "ENOENT" ? "not installed" : error.message
            }`
          )
        );
      }
    );
  });

export async function git(
  cwd: string,
  args: readonly string[],
  runner: CommandRunner = runCommand
): Promise<CommandResult> {
  return runner("git", args, { cwd });
}

export function requireSuccess(
  result: CommandResult,
  operation: string
): string {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n")[0];
    throw new Error(
      detail === ""
        ? `${operation} failed with exit code ${result.exitCode}`
        : `${operation} failed: ${detail}`
    );
  }
  return result.stdout;
}
