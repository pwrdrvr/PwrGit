import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { benchmarkEnvironment, repositoryInventory } from "./benchmark-checks.mjs";
import { runBenchmarkCommand } from "./benchmark-command.mjs";
import { compilerPath } from "./typecheck.mjs";
import { processStartedAt, readPosixProcesses } from "./lib/tool-processes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function fixture() {
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  return mkdtempSync(join(cache, "benchmark-regression-"));
}

describe.skipIf(process.platform === "win32")("benchmark regressions", () => {
  it("compares both compilers through a symlink with inherited logical PWD", () => {
    const directory = fixture();
    const checkout = join(directory, "checkout");
    const alias = join(directory, "alias");
    mkdirSync(join(checkout, "src"), { recursive: true });
    mkdirSync(join(checkout, "node_modules", "fixture"), { recursive: true });
    writeFileSync(join(checkout, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(checkout, "node_modules", "fixture", "index.ts"), "export {};\n");
    writeFileSync(join(checkout, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true, types: [], skipLibCheck: true }, include: ["src/**/*.ts"],
    }));
    symlinkSync(checkout, alias);
    try {
      expect(repositoryInventory(`${join(alias, "src", "index.ts")}\n${join(alias, "node_modules", "fixture", "index.ts")}\n`, checkout)).toEqual(["src/index.ts"]);
      const env = benchmarkEnvironment(alias, { ...process.env, PWD: alias });
      expect(env.PWD).toBe(realpathSync(checkout));
      const variants = ["typescript", "native"].map((compiler) => {
        const result = spawnSync(process.execPath, [compilerPath(compiler), "--listFilesOnly", "-p", "tsconfig.json"], {
          cwd: alias, env, encoding: "utf8",
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        return repositoryInventory(result.stdout, alias);
      });
      expect(variants).toEqual([["src/index.ts"], ["src/index.ts"]]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([false, true])("drains a time-wrapped child and descendants with detached=%s before returning", async (detached) => {
    const directory = fixture();
    const identities = join(directory, "identities.json");
    const command = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const { processStartedAt } = require(${JSON.stringify(fileURLToPath(new URL("./lib/tool-processes.mjs", import.meta.url)))});
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        { detached: ${detached}, stdio: 'ignore' });
      writeFileSync(${JSON.stringify(identities)}, JSON.stringify([process.pid, child.pid].map(pid => ({ pid, startedAt: processStartedAt(pid) }))));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    let processes = [];
    try {
      const result = await runBenchmarkCommand("/usr/bin/time", [process.platform === "darwin" ? "-l" : "-p", process.execPath, "-e", command], {
        env: { ...process.env, CI: "true" }, timeoutMs: 3000,
      });
      processes = JSON.parse(readFileSync(identities, "utf8"));
      expect(result.error?.code).toBe("ETIMEDOUT");
      const rows = readPosixProcesses();
      for (const { pid, startedAt } of processes) {
        expect(startedAt).toBeTruthy();
        expect(!rows.has(pid) || rows.get(pid).startedAt !== startedAt || rows.get(pid).state.startsWith("Z")).toBe(true);
      }
      const next = await runBenchmarkCommand(process.execPath, ["-e", 'process.stdout.write("next sample")']);
      expect(next.status).toBe(0);
      expect(next.stdout).toBe("next sample");
    } finally {
      // Retain cleanup if a regression leaves fixture processes alive.
      if (!processes.length && existsSync(identities)) processes = JSON.parse(readFileSync(identities, "utf8"));
      for (const { pid, startedAt } of processes) {
        if (startedAt && processStartedAt(pid) === startedAt) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
