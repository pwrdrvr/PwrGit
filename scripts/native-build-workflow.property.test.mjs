import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";

const workflows = ["docs-screenshots.yml", "release.yml"];
function nativeStep(file) {
  const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const step = source.split(/^      - /m).find((part) => /^name: Build native MCP helper(?: for tests)?\n/.test(part));
  const run = step.match(/^        run: (.+)$/m)[1];
  return run === "|" ? step.split("        run: |\n")[1].split("\n").filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n") : run;
}

// Execute the actual workflow shell with pnpm as an oracle for the scripts
// available in the checked-out ref. Never invoke Cargo, Electron or a release.
function checkWorkflowBuild(modern, failureCode) {
  const root = mkdtempSync(path.join(tmpdir(), "pwrgit-workflow-native-"));
  try {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify(modern ? { scripts: { "build:native": "host build" } } : { scripts: {} }));
    writeFileSync(path.join(root, "bin/pnpm"), `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.NATIVE_TEST_LOG, JSON.stringify(args)+'\\n');
      const valid = args.join(' ') === 'build:native'
        ? !!require(process.cwd()+'/package.json').scripts?.['build:native']
        : args.join(' ') === '--filter @pwrgit/desktop build:mcp --host';
      process.exitCode = valid ? Number(process.env.NATIVE_TEST_EXIT) : 42;
    `, { mode: 0o755 });
    for (const workflow of workflows) {
      const log = path.join(root, `${workflow}.jsonl`);
      const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", nativeStep(workflow)], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH, NATIVE_TEST_LOG: log, NATIVE_TEST_EXIT: String(failureCode) }
      });
      expect(result.status, `${workflow}: ${result.stderr}`).toBe(failureCode);
      const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(commands, workflow).toEqual([modern ? ["build:native"] : ["--filter", "@pwrgit/desktop", "build:mcp", "--host"]]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.skipIf(process.platform === "win32")("supports older release manifests such as v0.59.7", () => {
  checkWorkflowBuild(false, 0);
});

it.skipIf(process.platform === "win32")("selects by script availability and preserves build failures without retrying", () => {
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 0, max: 125 }), checkWorkflowBuild), { numRuns: 12 });
});
