import { readFileSync } from "node:fs";
import { createVitest } from "vitest/node";
import { isCliEntrypoint } from "../lib/cli-entrypoint.mjs";

export async function runRetry(plan, config) {
  const vitest = await createVitest("test", {
    watch: false,
    ...(config ? { config } : {}),
    reporters: ["default", "./scripts/ci/vitest-ci-reporter.mjs"],
  });
  try {
    await vitest.standalone();
    const available = await vitest.globTestSpecifications();
    const selected = [];
    for (const { project, file, tests } of plan) {
      const matches = available.filter((spec) => spec.project.name === project && spec.moduleId === file);
      if (matches.length !== 1 || !tests.length) throw new Error(`Ambiguous or missing unit module: ${file}`);
      const spec = matches[0];
      spec.testIds = tests.map((test) => test.id);
      selected.push(spec);
    }
    if (new Set(selected).size !== selected.length) throw new Error("Duplicate unit module selection");
    const result = await vitest.runTestSpecifications(selected);
    if (result.unhandledErrors.length || result.testModules.some((module) => !module.ok())) process.exitCode = 1;
  } finally {
    await vitest.close();
  }
}

if (isCliEntrypoint(import.meta.url)) {
  try {
    await runRetry(JSON.parse(readFileSync(process.argv[2], "utf8")), process.argv[3]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
