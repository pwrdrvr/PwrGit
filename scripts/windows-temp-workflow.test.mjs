import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";

const jobs = {
  "ci.yml": ["windows-install-deps", "windows", "windows-test", "windows-e2e"],
  "preview-build.yml": ["preview-windows"],
  "release.yml": ["windows-prepare", "windows-sign"],
  "package-distribution.yml": ["windows"],
};

test("hosted Windows disk work inherits the runner temp volume", () => {
  for (const [file, names] of Object.entries(jobs)) {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    for (const name of names) {
      const body = source.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
      expect(body, `${file}: ${name}`).toBeDefined();
      const jobEnv = body.split(/^    env:\s*$/m)[1]?.split(/^    [\w-]+:/m)[0];
      for (const variable of ["TEMP", "TMP"]) {
        expect(jobEnv?.split("\n"), `${file}: ${name} ${variable}`).toContain(
          `      ${variable}: \${{ runner.temp }}`,
        );
        // A step override would take precedence over the job environment.
        expect(body, `${file}: ${name} overrides ${variable}`).not.toMatch(new RegExp(`^          ${variable}:`, "m"));
      }
    }
  }
});

test("the contract inventories every directly selected hosted Windows job", () => {
  for (const file of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((name) => /\.ya?ml$/.test(name))) {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const found = [...source.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
      .filter(([, , body]) => /^    runs-on: windows-(?:latest|\d+)\s*$/m.test(body))
      .map(([, name]) => name);
    expect(found, file).toEqual(jobs[file] ?? []);
  }
});
