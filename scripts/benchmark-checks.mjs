import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { resolve, join, relative, sep, isAbsolute } from "node:path";
import { compilerPath } from "./typecheck.mjs";
import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";
import { runBenchmarkCommand } from "./benchmark-command.mjs";

const projects = ["packages/shared", "packages/mcp-server", "apps/desktop"];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function benchmarkEnvironment(cwd = process.cwd(), env = process.env) {
  return { ...env, PWD: realpathSync(cwd), CI: "true", NODE_OPTIONS: "--max-old-space-size=6144" };
}

export function repositoryInventory(stdout, cwd = process.cwd()) {
  const root = realpathSync(cwd);
  return stdout.split(/\r?\n/).filter(Boolean).map((file) => relative(root, realpathSync(file)))
    .filter((file) => file && !isAbsolute(file) && file !== ".." && !file.startsWith(`..${sep}`)
      && !file.split(sep).includes("node_modules"))
    .map((file) => file.split(sep).join("/")).sort();
}

export async function runCli() {
  if (process.platform !== "darwin") throw new Error("Benchmark requires macOS time -l");
  const output = resolve(process.argv[2] ?? "check-benchmark");
  mkdirSync(output, { recursive: true });
  // Both variants use the same dependencies, configs, sources and job. CI mode
  // bypasses the developer lane/worker cap; 6 GiB leaves room on the 8 GiB VM.
  const env = benchmarkEnvironment();
  const metadata = {
    revision: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    runner: process.env.RUNNER_NAME ?? "managed-e2e-vm",
    processor: cpus()[0]?.model, cpus: cpus().length, ramBytes: totalmem(),
    node: process.version, nodeOptions: env.NODE_OPTIONS,
    typescript6: spawnSync(process.execPath, [compilerPath("typescript"), "--version"], { encoding: "utf8" }).stdout.trim(),
    typescript7: spawnSync(process.execPath, [compilerPath("native"), "--version"], { encoding: "utf8" }).stdout.trim(),
    method: "Three alternating TS6/TS7 samples of identical commands and sources; warm filesystem and dependency-policy caches; no incremental compiler cache. Peak RSS is process RSS from time -l, not agent/LSP memory.",
  };
  const inventories = {};
  for (const project of projects) {
    const variants = {};
    for (const compiler of ["typescript", "native"]) {
      const result = spawnSync(process.execPath, [compilerPath(compiler), "--listFilesOnly", "-p", `${project}/tsconfig.json`], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`Inventory failed: ${project} ${compiler}: ${result.stdout} ${result.stderr}`);
      variants[compiler] = repositoryInventory(result.stdout);
    }
    if (JSON.stringify(variants.typescript) !== JSON.stringify(variants.native)) throw new Error(`Source inventory differs: ${project}`);
    inventories[project] = variants;
  }
  writeFileSync(join(output, "inventories.json"), JSON.stringify(inventories, null, 2));

  // Assert the unused-binding gate and a type error still fail in both engines.
  // A new name created exclusively avoids overwriting anybody's source file.
  const probe = "packages/shared/src/__native_compiler_probe.ts";
  writeFileSync(probe, 'import { setTimeout } from "node:timers";\nexport const typeProbe: string = 123;\nexport function bindingProbe(_allowed: string) { const _unusedLocal = 1; return true; }\n', { flag: "wx" });
  try {
    for (const compiler of ["typescript", "native"]) {
      const result = spawnSync(process.execPath, [compilerPath(compiler), "--noEmit", "-p", "packages/shared/tsconfig.json"], { env, encoding: "utf8" });
      writeFileSync(join(output, `defect-probe-${compiler}.log`), result.stdout + result.stderr);
      if (result.status === 0 || !result.stdout.includes("TS2322") || !result.stdout.includes("'_unusedLocal'") || !result.stdout.includes("'setTimeout'")) throw new Error(`Defect probe not rejected: ${compiler}`);
    }
  } finally { rmSync(probe); }

  const samples = [];
  // Prime the policy cache and require a passing baseline before comparing.
  const warmup = await runBenchmarkCommand("pnpm", ["lint"], { env: { ...env, PWRGIT_TYPECHECK_COMPILER: "typescript" } });
  writeFileSync(join(output, "warmup.log"), (warmup.stdout ?? "") + (warmup.stderr ?? ""));
  if (warmup.status !== 0 || warmup.error) throw new Error("Baseline warmup failed; inspect warmup.log", { cause: warmup.error });
  for (const script of ["typecheck", "lint"]) {
    for (let iteration = 1; iteration <= 3; iteration++) {
      for (const compiler of ["typescript", "native"]) {
        const loadBefore = loadavg();
        const result = await runBenchmarkCommand("/usr/bin/time", ["-l", "pnpm", script], {
          env: { ...env, PWRGIT_TYPECHECK_COMPILER: compiler },
        });
        writeFileSync(join(output, `${script}-${compiler}-${iteration}.log`), (result.stdout ?? "") + (result.stderr ?? ""));
        const seconds = /([\d.]+)\s+real\b/.exec(result.stderr ?? "");
        const rss = /(\d+)\s+maximum resident set size/.exec(result.stderr ?? "");
        const sample = { script, compiler, iteration, exitCode: result.status,
          seconds: seconds ? Number(seconds[1]) : null,
          peakRssMiB: rss ? Number(rss[1]) / 1048576 : null,
          loadBefore, loadAfter: loadavg(), error: result.error?.message };
        samples.push(sample);
        writeFileSync(join(output, "samples.json"), JSON.stringify({ metadata, samples }, null, 2));
        console.log(JSON.stringify(sample));
        if (result.error) throw new Error("Benchmark command failed; refusing to start another sample", { cause: result.error });
      }
    }
  }
  const comparisons = ["typecheck", "lint"].map((script) => {
    const rows = samples.filter((row) => row.script === script);
    const passes = rows.every((row) => row.exitCode === 0 && row.seconds !== null);
    const before = passes ? median(rows.filter((row) => row.compiler === "typescript").map((row) => row.seconds)) : null;
    const after = passes ? median(rows.filter((row) => row.compiler === "native").map((row) => row.seconds)) : null;
    return { script, passes, beforeSeconds: before, afterSeconds: after,
      reductionPercent: passes ? 100 * (1 - after / before) : null };
  });
  const summary = { metadata, sourceCounts: Object.fromEntries(Object.entries(inventories).map(([project, variants]) => [project, variants.native.length])), comparisons, samples };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (comparisons.some((row) => !row.passes)) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) await runCli();
