import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

// Dependency setup must stay strict. Test attempts may continue only when a
// later, mandatory step checks their original outcome and the retry evidence.
function assertStrictConsumer(body, consumer) {
  expect(body).not.toMatch(/run:.*pnpm (?:i|install|rebuild)\b|--ignore-scripts/);
  const parts = body.split(/^      - /m);
  expect(parts[0]).not.toMatch(/^\s*continue-on-error:/m);
  const steps = parts.slice(1);
  const unit = ["linux-test", "windows-test"].includes(consumer);
  const e2e = ["desktop-e2e", "macos-e2e", "windows-e2e"].includes(consumer);
  const allowed = unit ? new Set(["unit-tests"]) : e2e ? new Set(["e2e-tests", "e2e-retry"]) : new Set();
  const tolerated = new Set();
  for (const step of steps) {
    const occurrences = [...step.matchAll(/^\s*continue-on-error:/gm)];
    if (!occurrences.length) continue;
    const id = step.match(/^        id: (.+)$/m)?.[1];
    expect(occurrences).toHaveLength(1);
    expect(allowed.has(id), `${consumer}: unguarded continue-on-error in ${step.split("\n")[0]}`).toBe(true);
    expect(tolerated.has(id)).toBe(false);
    expect(step).toMatch(/^        continue-on-error: true$/m);
    if (id === "unit-tests") expect(step).toMatch(/^name: Test$/m);
    if (id === "e2e-tests") expect(step).toMatch(/^name: Run desktop Electron E2E specs(?: \(.*\))?$/m);
    if (id === "e2e-retry") expect(step).toMatch(/^name: Retry failed E2E tests$/m);
    tolerated.add(id);
  }
  expect(tolerated).toEqual(allowed);
  const named = (name) => {
    const found = steps.filter((step) => step.startsWith(`name: ${name}\n`));
    expect(found, `${consumer}: ${name}`).toHaveLength(1);
    return found[0];
  };
  if (unit) {
    expect(named("Verify unit completion")).toContain("if: steps.unit-tests.outcome == 'success'");
    expect(named("Verify unit completion")).toContain("run: node scripts/ci/run-retry-failures.mjs unit-verify");
    expect(named("Retry failed unit tests")).toContain("if: steps.unit-tests.outcome == 'failure'");
    expect(named("Retry failed unit tests")).toContain("run: pnpm exec node scripts/ci/run-retry-failures.mjs unit");
  }
  if (e2e) {
    expect(named("Verify E2E completion")).toContain("if: steps.e2e-tests.outcome == 'success'");
    expect(named("Verify E2E completion")).toContain("run: node scripts/ci/run-retry-failures.mjs e2e-first-verify");
    expect(named("Select failed E2E tests")).toContain("if: steps.e2e-tests.outcome == 'failure'");
    expect(named("Select failed E2E tests")).toContain("run: node scripts/ci/run-retry-failures.mjs e2e-prepare");
    for (const name of ["Retry failed E2E tests", "Verify E2E retry"]) {
      expect(named(name)).toContain("if: steps.e2e-tests.outcome == 'failure' && steps.e2e-selection.outcome == 'success'");
    }
    expect(named("Verify E2E retry")).toContain("PWRGIT_RETRY_OUTCOME: ${{ steps.e2e-retry.outcome }}");
    expect(named("Verify E2E retry")).toContain("run: node scripts/ci/run-retry-failures.mjs e2e-verify");
  }
}

test("every dependency setup uses the reviewed immutable action revision", () => {
  for (const [, source] of workflows) {
    for (const reference of source.matchAll(/uses: (pwrdrvr\/configure-nodejs@\S+)/g)) {
      expect(reference[1]).toBe(action);
    }
  }
});

test.each([
  ["install-deps", ["typecheck", "linux-test", "desktop-e2e"]],
  ["windows-install-deps", ["windows", "windows-test", "windows-e2e"]],
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
    assertStrictConsumer(consumerJob, consumer);
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
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
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
  for (const name of ["linux-test", "windows-test"]) {
    expect(job(name)).toContain("pnpm --filter @pwrgit/desktop run rebuild:electron-native");
  }
});

test.each([
  ["build", "Build", "typecheck", "windows"],
  ["test", "Test", "linux-test", "windows-test"],
])("%s preserves its required check and rejects unsuccessful platform results", (name, check, linux, windows) => {
  const body = job(name);
  expect(body).toContain(`name: ${check}\n`);
  expect(body).toContain(`needs: [changes, ${linux}, ${windows}]`);
  expect(body).toContain("always() &&");
  expect(body).toContain("needs.changes.outputs.code_impacting == 'true'");
  expect(body).toContain(`LINUX_RESULT: \${{ needs.${linux}.result }}`);
  expect(body).toContain(`WINDOWS_RESULT: \${{ needs.${windows}.result }}`);
  expect(body).not.toContain("uses:");
  const script = body.split("        run: |\n")[1];
  expect(script).toBeDefined();
  for (const [linuxResult, windowsResult] of [
    ["success", "success"], ["failure", "success"], ["success", "failure"],
    ["skipped", "success"], ["success", "skipped"],
    ["cancelled", "success"], ["success", "cancelled"],
    ["", "success"], ["success", ""],
  ]) {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: { ...process.env, LINUX_RESULT: linuxResult, WINDOWS_RESULT: windowsResult },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${linuxResult}/${windowsResult}`).toBe(
      linuxResult === "success" && windowsResult === "success" ? 0 : 1,
    );
  }
});

// Exercise the invariant against every current non-attempt step, including the
// cache restore itself: no newly tolerated failure may bypass the gates.
test.each(["typecheck", "linux-test", "desktop-e2e", "windows", "windows-test", "windows-e2e", "macos-e2e"])(
  "%s rejects continue-on-error on every non-attempt step", (consumer) => {
    const body = job(consumer);
    const steps = body.split(/^      - /m).slice(1);
    expect(() => assertStrictConsumer(`    continue-on-error: true\n${body}`, consumer)).toThrow();
    for (const step of steps) {
      if (/^        continue-on-error:/m.test(step)) continue;
      const mutated = body.replace(`      - ${step}`, `      - ${step.replace("\n", "\n        continue-on-error: true\n")}`);
      expect(() => assertStrictConsumer(mutated, consumer), step.split("\n")[0]).toThrow();
    }
  },
);

test.each([
  ["linux-test", "run: node scripts/ci/run-retry-failures.mjs unit-verify"],
  ["windows-test", "if: steps.unit-tests.outcome == 'failure'"],
  ["desktop-e2e", "run: node scripts/ci/run-retry-failures.mjs e2e-prepare"],
  ["macos-e2e", "PWRGIT_RETRY_OUTCOME: ${{ steps.e2e-retry.outcome }}"],
  ["windows-e2e", "run: node scripts/ci/run-retry-failures.mjs e2e-verify"],
])("%s rejects a missing retry gate", (consumer, gate) => {
  expect(job(consumer)).toContain(gate);
  expect(() => assertStrictConsumer(job(consumer).replace(gate, "# removed gate"), consumer)).toThrow();
});
