import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import path from "node:path";

export const GIB = 1024 ** 3;
export const LOW_MEMORY_THRESHOLD = 16 * GIB;

export function toolHeapMiB() {
  // Full PwrGit type checking passes at 2 GiB; every tool keeps that cap.
  return 2048;
}

function readOptional(file, readFile) {
  try { return readFile(file, "utf8").trim(); } catch { return ""; }
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

// The leaf may be unlimited while an enclosing pod or user slice is limited.
// Only visible ancestors can be read; constrainedMemory also covers OS limits.
export function readCgroupMemoryLimits(readFile = readFileSync, platform = process.platform) {
  if (platform !== "linux") return [];
  const memberships = readOptional("/proc/self/cgroup", readFile).split("\n");
  const mounts = readOptional("/proc/self/mountinfo", readFile).split("\n");
  const limits = [];
  for (const mount of mounts) {
    const [left, right] = mount.split(" - ");
    if (!right) continue;
    const fields = left.split(" ");
    const [type, , options] = right.split(" ");
    const v2 = type === "cgroup2";
    if (!v2 && !(type === "cgroup" && options?.split(",").includes("memory"))) continue;
    const membership = memberships.find((line) => {
      const [, controllers] = line.split(":");
      return v2 ? controllers === "" : controllers?.split(",").includes("memory");
    });
    if (!membership) continue;
    const memberPath = membership.slice(membership.indexOf(":", membership.indexOf(":") + 1) + 1);
    const mountRoot = decodeMountPath(fields[3]);
    const mountPoint = decodeMountPath(fields[4]);
    let relative;
    if (memberPath === "/") relative = "."; // Namespaced root.
    else if (mountRoot === "/" || memberPath === mountRoot || memberPath.startsWith(`${mountRoot}/`)) {
      relative = path.posix.relative(mountRoot, memberPath);
    } else continue;
    let directory = path.posix.resolve(mountPoint, relative);
    while (directory === mountPoint || directory.startsWith(`${mountPoint}/`)) {
      const text = readOptional(path.posix.join(directory, v2 ? "memory.max" : "memory.limit_in_bytes"), readFile);
      const value = Number(text);
      if (text !== "" && Number.isFinite(value) && value >= 0) limits.push(value);
      if (directory === mountPoint) break;
      directory = path.posix.dirname(directory);
    }
  }
  return limits;
}

export function getToolResourcePolicy({
  hostMemory = totalmem(),
  constrainedMemory = process.constrainedMemory?.() ?? 0,
  cgroupLimits = readCgroupMemoryLimits(),
} = {}) {
  // Node's OS API uses zero for "unknown/unconstrained". An explicitly read
  // zero cgroup hard limit is a real limit, distinct from an unreadable file.
  const capacities = [hostMemory, constrainedMemory].filter((value) => Number.isFinite(value) && value > 0)
    .concat(cgroupLimits.filter((value) => Number.isFinite(value) && value >= 0));
  const effectiveMemory = Math.min(...capacities);
  return { hostMemory, effectiveMemory, constrained: effectiveMemory < LOW_MEMORY_THRESHOLD };
}

const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(?:[-_]percentage)?(?:=|$)/;
const NODE_VALUE_OPTIONS = new Set([
  "-e", "--eval", "-p", "--print", "-pe", "-ep", "--run",
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--title", "-C", "--conditions", "--input-type", "--env-file", "--env-file-if-exists",
  "--experimental-config-file", "--diagnostic-dir", "--icu-data-dir", "--openssl-config",
  "--inspect-port", "--max-http-header-size", "--dns-result-order",
  "--heapsnapshot-signal", "--heapsnapshot-near-heap-limit",
  "--heap-prof-dir", "--heap-prof-name", "--heap-prof-interval",
  "--cpu-prof-dir", "--cpu-prof-name", "--cpu-prof-interval",
  "--max-semi-space-size", "--max_semi_space_size", "--stack-size", "--stack_size",
  "--allow-fs-read", "--allow-fs-write", "--build-snapshot-config",
  "--disable-proto", "--disable-warning", "--experimental-package-map",
  "--experimental-sea-config", "--experimental-test-tag-filter", "--debug-port",
  "--inspect-publish-uid", "--localstorage-file", "--network-family-autoselection-attempt-timeout",
  "--redirect-warnings", "--report-directory", "--report-dir", "--report-filename", "--report-signal",
  "--secure-heap", "--secure-heap-min", "--snapshot-blob", "--test-concurrency",
  "--test-coverage-branches", "--test-coverage-exclude", "--test-coverage-functions",
  "--test-coverage-include", "--test-coverage-lines", "--test-global-setup",
  "--experimental-test-isolation", "--test-isolation", "--test-name-pattern", "--test-random-seed",
  "--test-reporter", "--test-reporter-destination", "--test-rerun-failures", "--test-shard",
  "--test-skip-pattern", "--test-timeout", "--tls-cipher-list", "--tls-keylog",
  "--trace-event-categories", "--trace-event-file-pattern", "--trace-require-module",
  "--unhandled-rejections", "--use-largepages", "--v8-pool-size", "--watch-kill-signal", "--watch-path",
]);

function removeHeapOptions(tokens) {
  const retained = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^"|"$/g, "");
    if (HEAP_FLAG.test(token)) {
      if (!token.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) i++;
    } else {
      retained.push(tokens[i]);
      // A flag-looking value belongs to its option, not to V8's startup
      // settings (for example --title --max-old-space-size=6144).
      if (NODE_VALUE_OPTIONS.has(token) && i + 1 < tokens.length) retained.push(tokens[++i]);
    }
  }
  return retained;
}

export function cappedNodeOptions(options = "", heapMiB = 2048) {
  // Preserve spelling of unrelated options, including quoted preload paths.
  const tokens = options.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? [];
  return [...removeHeapOptions(tokens), `--max-old-space-size=${heapMiB}`].join(" ");
}

function withoutOptions(args, names, booleans = []) {
  const retained = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].split("=")[0];
    if (names.includes(name)) {
      if (!args[i].includes("=")) i++;
    } else if (booleans.includes(name)) {
      if (!args[i].includes("=") && ["true", "false"].includes(args[i + 1])) i++;
    } else retained.push(args[i]);
  }
  return retained;
}

export function resourceEnvironment(command, args, env, policy, heapMiB = 2048) {
  if (!policy.constrained) return env;
  let options = env.NODE_OPTIONS ?? "";
  if (path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase() === "pnpm") {
    // pnpm 12's native CLI no longer accepts --node-options. Consume the
    // wrapper's override here and pass its unrelated options through env.
    let override;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--node-options" || args[i].startsWith("--node-options=")) {
        override = args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[++i];
      }
    }
    if (override !== undefined) options = `${options} ${override}`;
  }
  return { ...env, NODE_OPTIONS: cappedNodeOptions(options, heapMiB) };
}

export function resourceCommand(command, args, policy, heapMiB = 2048) {
  if (!policy.constrained) return args;
  const name = path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (name === "node") {
    // Eval/print consumes an expression but Node continues parsing startup
    // options afterwards. A script/positional argument or -- ends that scan.
    let end = args.length;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--" || args[i] === "-" || !args[i].startsWith("-")) { end = i; break; }
      if (NODE_VALUE_OPTIONS.has(args[i]) || (HEAP_FLAG.test(args[i]) && !args[i].includes("="))) i++;
    }
    return [`--max-old-space-size=${heapMiB}`, ...removeHeapOptions(args.slice(0, end)), ...args.slice(end)];
  }
  if (name === "pnpm") {
    const capped = withoutOptions(args, ["--node-options"]);
    return args.some((arg) => ["-r", "--recursive"].includes(arg))
      ? ["--workspace-concurrency=1", ...withoutOptions(capped, ["--workspace-concurrency"], ["--parallel"])] : capped;
  }
  if (name === "vitest") {
    return [...withoutOptions(args, ["--maxWorkers", "--max-workers", "--minWorkers", "--min-workers", "--maxConcurrency", "--max-concurrency"], ["--fileParallelism", "--file-parallelism", "--no-file-parallelism"]), "--maxWorkers=1", "--no-file-parallelism", "--maxConcurrency=1"];
  }
  if (name === "playwright" && args[0] === "test") {
    return [...withoutOptions(args, ["--workers", "-j"]), "--workers=1"];
  }
  return args;
}
