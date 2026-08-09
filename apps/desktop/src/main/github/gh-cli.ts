import { execFile } from "node:child_process";

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
  options: { timeoutMs?: number; onStderr?: (chunk: string) => void } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = execFile(
      "gh",
      args,
      {
        env: ghEnvironment(),
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        resolve(stdout.trim());
      }
    );
    process.stderr?.on("data", (chunk: Buffer | string) => {
      options.onStderr?.(chunk.toString());
    });
  });
}
