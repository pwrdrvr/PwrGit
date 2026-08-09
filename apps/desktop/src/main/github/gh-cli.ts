import { execFile, spawn } from "node:child_process";

// Electron's PATH may miss Homebrew etc. in a packaged app; augment it so `gh`
// resolves the way it does in the user's shell.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_STREAM_TAIL_CHARS = 64 * 1024;

export type GhRunOptions = {
  timeoutMs?: number;
  /** Stream stderr instead of buffering it in execFile. */
  onStderr?: (chunk: string) => void;
  env?: Record<string, string | undefined>;
};

export function ghEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":")
  };
}

function environmentWith(overrides: GhRunOptions["env"]): NodeJS.ProcessEnv {
  return { ...ghEnvironment(), ...overrides };
}

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_STREAM_TAIL_CHARS
    ? combined
    : combined.slice(-MAX_STREAM_TAIL_CHARS);
}

function runStreamingGh(
  args: string[],
  options: GhRunOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env: environmentWith(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const rejectOnce = (cause: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(cause);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutTail = appendTail(stdoutTail, chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrTail = appendTail(stderrTail, text);
      options.onStderr?.(text);
    });
    child.once("error", rejectOnce);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (exitCode === 0 && !timedOut) {
        resolve(stdoutTail.trim());
        return;
      }
      const message = timedOut
        ? `gh timed out after ${timeoutMs}ms`
        : stderrTail.trim() ||
          `gh exited ${exitCode ?? `after signal ${signal ?? "unknown"}`}`;
      const failure = new Error(message) as Error & {
        stdout?: string;
        stderr?: string;
      };
      failure.stdout = stdoutTail;
      failure.stderr = stderrTail;
      reject(failure);
    });
  });
}

/** Run the configured GitHub CLI without exposing its credential storage. */
export async function runGh(
  args: string[],
  options: GhRunOptions = {}
): Promise<string> {
  if (options.onStderr !== undefined) {
    return runStreamingGh(args, options);
  }
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        env: environmentWith(options.env),
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: MAX_BUFFER_BYTES,
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
  });
}
