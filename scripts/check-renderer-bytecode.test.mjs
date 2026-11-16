import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BYTECODE_BUDGET, budgetFailures, discoverModules, enforceBudget, measureBytecode, transformedModules,
} from "./check-renderer-bytecode.mjs";

async function fixture(run) {
  // Keep Vite's filesystem allowlist and config resolution in this checkout.
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local/bytecode-oracle-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("renderer bytecode oracle", () => {
  it("automatically discovers new modules and workers, excluding only test/declaration surfaces", async () => {
    await fixture(async (root) => {
      const included = ["App.tsx", "new/helper.ts", "pixel.worker.ts", "plain.js", "common.cts", "module.mts", "view.jsx"];
      const excluded = ["unit.test.tsx", "model.property.test.ts", "unit.spec.ts", "types.d.ts", "types.d.mts", "test-support/helper.ts", "__tests__/fixture.ts", "node_modules/vendor.js"];
      for (const file of [...included, ...excluded]) {
        await mkdir(resolve(root, file, ".."), { recursive: true });
        await writeFile(resolve(root, file), "export {};");
      }
      expect((await discoverModules(root)).map((file) => relative(root, file).replaceAll("\\", "/"))).toEqual(included.sort());
    });
  });

  it("uses an inclusive 48 KiB budget and rejects malformed oracle records", () => {
    expect(budgetFailures([{ bytes: BYTECODE_BUDGET }])).toEqual([]);
    const invalid = [BYTECODE_BUDGET + 1, NaN, Infinity, -1, 1.5].map((bytes) => ({ bytes }));
    expect(budgetFailures(invalid)).toEqual(invalid);
  });

  it.each([false, true])("compiles without execution and finds nested/anonymous over-budget functions (oversized=%s)", async (oversized) => {
    await fixture(async (root) => {
      const entry = resolve(root, "entry.tsx");
      const body = Array.from({ length: oversized ? 8000 : 3 }, (_, i) => `input.step(${i});`).join("\n");
      // Both a named nested helper and an anonymous array element must be
      // found, even though none is executed or exported on its own.
      await writeFile(entry, `import './sentinel';
        export function factory() {
          return [function nested(input) { ${body} }, function(input) { ${body} }];
        }
        globalThis.__bytecodeFixture = factory;
        throw new Error('APPLICATION MODULE MUST NOT EXECUTE');
      `);
      await writeFile(resolve(root, "sentinel.ts"), "globalThis.__bytecodeImportExecuted = true; export {};");
      const records = await measureBytecode(transformedModules(root, { productionInput: entry }));
      const failures = budgetFailures(records);
      const diagnostics = [];
      if (oversized) {
        expect(() => enforceBudget(records, (message) => diagnostics.push(message))).toThrow("49152-byte limit");
        expect(diagnostics).toHaveLength(8);
        expect(diagnostics.every((message) => message.includes("bytes > limit 49152"))).toBe(true);
      } else expect(() => enforceBudget(records)).not.toThrow();
      expect(globalThis.__bytecodeFixture).toBeUndefined();
      expect(globalThis.__bytecodeImportExecuted).toBeUndefined();
      for (const variant of ["Vitest-SSR", "Vitest-jsdom", "development", "production"]) {
        const functions = records.filter((r) => r.variant === variant);
        expect(functions.length).toBeGreaterThan(2);
        const rejected = failures.filter((r) => r.variant === variant);
        expect(rejected).toHaveLength(oversized ? 2 : 0);
        if (variant !== "production" && oversized) {
          expect(rejected.some((r) => r.name === "nested")).toBe(true);
          // V8 may infer a contextual name for the syntactically anonymous
          // function; both distinct function records must still be rejected.
          expect(new Set(rejected.map((r) => r.ordinal)).size).toBe(2);
        }
      }
    });
  });
});
