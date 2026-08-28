import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const IDENTITY_TEST = "apps/desktop/src/main/github/commit-author-identity.test.ts";
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const VITEST_CLI = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

describe("commit-author identity worker lifecycle", () => {
  it("runs every unit assertion in a real fork and exits cleanly", async () => {
    const result = await runFocusedSuiteInFork();
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.signal, output).toBeNull();
    expect(result.code, output).toBe(0);
    expect(output).toMatch(/Tests\s+19 passed \(19\)/);
  });
});

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runFocusedSuiteInFork(): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1"
    };
    delete environment.VITEST_POOL_ID;
    delete environment.VITEST_WORKER_ID;

    const child = spawn(
      process.execPath,
      [
        VITEST_CLI,
        "run",
        IDENTITY_TEST,
        "--pool=forks",
        "--reporter=dot"
      ],
      {
        cwd: REPO_ROOT,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
