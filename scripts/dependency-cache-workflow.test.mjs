import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflowDirectory = resolve(root, ".github/workflows");
const workflows = readdirSync(workflowDirectory).filter((name) => name.endsWith(".yml"))
  .map((name) => [name, readFileSync(resolve(workflowDirectory, name), "utf8")]);
const ci = workflows.find(([name]) => name === "ci.yml")[1];
const action = "pwrdrvr/configure-nodejs@d416c1c78119b25fe03ee3ef78b75af0d69b10a7";

function job(name) {
  const body = ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  if (!body) throw new Error(`Missing job: ${name}`);
  return body;
}

function setup(body) {
  const step = body.split(/^      - /m).find((part) => part.includes("uses: pwrdrvr/configure-nodejs@"));
  if (!step) throw new Error("Missing dependency setup");
  return step;
}

function input(step, name) {
  return step.match(new RegExp(`^          ${name}: (.+)$`, "m"))?.[1];
}

function cacheInputs(step) {
  return step.split("          cache-inputs: |\n")[1]?.match(/^            \S+$/gm)
    .map((line) => line.trim()) ?? [];
}

test("every dependency setup uses the reviewed immutable action revision", () => {
  for (const [, source] of workflows) {
    for (const reference of source.matchAll(/uses: (pwrdrvr\/configure-nodejs@\S+)/g)) {
      expect(reference[1]).toBe(action);
    }
  }
});

test.each([
  ["install-deps", ["typecheck", "build", "test", "desktop-e2e"]],
  ["windows-install-deps", ["windows", "windows-e2e"]],
  ["macos-install-deps", ["macos-e2e"]],
])("%s has compatible strict completed-tree consumers", (producer, consumers) => {
  const producerJob = job(producer);
  const producerSetup = setup(producerJob);
  expect(input(producerSetup, "cache-mode")).toBe("populate");
  expect(producerJob).not.toContain("PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN");
  for (const consumer of consumers) {
    const consumerJob = job(consumer);
    const consumerSetup = setup(consumerJob);
    expect(consumerJob).toContain(producer);
    expect(consumerJob.match(/^    runs-on: .+$/m)[0]).toBe(producerJob.match(/^    runs-on: .+$/m)[0]);
    expect(input(consumerSetup, "cache-mode")).toBe("restore");
    for (const key of ["node-version", "dependency-cache", "cache-key-suffix", "cache-inputs", "cache-electron", "working-directory", "package-manager"]) {
      expect(input(consumerSetup, key)).toBe(input(producerSetup, key));
    }
    expect(cacheInputs(consumerSetup)).toEqual(cacheInputs(producerSetup));
    expect(consumerJob).toContain('PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false"');
    // The MCP prepare output lives outside node_modules and must be rebuilt
    // from this checkout, including on a cache hit after MCP-only source edits.
    expect(consumerJob).toMatch(/run: pnpm (?:--filter @pwrgit\/mcp-server build|run build)/);
    expect(consumerJob).not.toMatch(/run:.*pnpm (?:i|install|rebuild)\b|--ignore-scripts|continue-on-error/);
  }
  expect(input(producerSetup, "dependency-cache")).toBe("node-modules");
  expect(input(producerSetup, "cache-key-suffix")).toContain(action.split("@")[1]);
  expect(producerSetup).not.toMatch(/lookup-only|persistent-store-dir/);
});

test("completed-tree inputs include install scripts and their local import closure", () => {
  const inputs = cacheInputs(setup(job("install-deps")));
  const visit = (file, seen = new Set()) => {
    if (seen.has(file)) return;
    seen.add(file);
    expect(inputs).toContain(file);
    const absolute = resolve(root, file);
    expect(existsSync(absolute)).toBe(true);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/from ["'](\.[^"']+)["']/g)) {
      visit(relative(root, resolve(dirname(absolute), match[1])).replaceAll("\\", "/"), seen);
    }
  };
  for (const file of [
    ".nvmrc", "scripts/check-node-version.mjs", "scripts/linux-sandbox.mjs",
    "scripts/resource-run.mjs", "scripts/windows-tool-job.ps1",
    "apps/desktop/scripts/install-electron-binary.mjs",
    "apps/desktop/scripts/rebuild-native-for-electron.mjs",
  ]) visit(file);
  expect(readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8")).toContain("packageImportMethod: auto");
});

test("CI runs only on GitHub-hosted runners", () => {
  for (const [name, source] of workflows) {
    expect(source, name).not.toMatch(/self-hosted|persistent-store-dir/);
  }
});

test("unit-test jobs keep the Electron SQLite rebuild", () => {
  for (const name of ["test", "windows"]) {
    expect(job(name)).toContain("pnpm --filter @pwrgit/desktop run rebuild:electron-native");
  }
});
