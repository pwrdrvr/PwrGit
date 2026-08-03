import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Electron's PATH may miss Homebrew etc. in a packaged app; augment it so `gh`
// resolves the way it does in the user's shell.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function ghEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":")
  };
}

/** Run the configured GitHub CLI without exposing its credential storage. */
export async function runGh(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    env: ghEnvironment(),
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return stdout.trim();
}
