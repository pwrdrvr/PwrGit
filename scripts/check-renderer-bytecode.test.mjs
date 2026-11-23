import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { nodeHeapArguments } from "./tool-resource-policy.mjs";
import {
  BYTECODE_BUDGET, budgetFailures, discoverModules, enforceBudget, measureBytecode, transformedModules,
} from "./check-renderer-bytecode.mjs";

async function fixture(run, base = ".local") {
  // Keep Vite's filesystem allowlist and config resolution in this checkout.
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, "bytecode-oracle-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("renderer bytecode oracle", () => {
  it("preserves the compiler heap limit while removing tier and preload settings", async () => {
    await fixture(async (root) => {
      const heapFile = resolve(root, "heap.json");
      const probe = resolve(root, "heap-probe.mjs");
      await writeFile(probe, `import { writeFileSync } from 'node:fs';
        import { getHeapStatistics } from 'node:v8';
        writeFileSync(${JSON.stringify(heapFile)}, JSON.stringify({
          limit: getHeapStatistics().heap_size_limit,
          options: process.env.NODE_OPTIONS
        }));`);
      vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=2048 --jitless --require=/must-not-load.cjs");
      try {
        const heapArgs = nodeHeapArguments(process.env.NODE_OPTIONS, process.execArgv);
        // A real Node process with the inherited heap settings is the oracle;
        // heap_size_limit also includes young-generation space, so do not
        // compare it with a guessed byte total for a 2048 MiB old-space cap.
        const control = spawnSync(process.execPath, [...heapArgs, "-p", "require('node:v8').getHeapStatistics().heap_size_limit"], {
          env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8"
        });
        expect(control.status).toBe(0);
        let compilerArgs;
        await measureBytecode([{ file: "heap-oracle.js", variant: "test", code: "globalThis.__heapProbe = () => 1;" }], {
          spawnCompiler(executable, args, options) {
            compilerArgs = args;
            return spawn(executable, ["--import", pathToFileURL(probe).href, ...args], options);
          }
        });
        const actual = JSON.parse(await readFile(heapFile, "utf8"));
        expect(actual.limit).toBe(Number(control.stdout.trim()));
        expect(actual.options).toBe("");
        expect(compilerArgs.slice(0, heapArgs.length)).toEqual(heapArgs);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
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

  it("uses an inclusive 28 KiB budget and rejects malformed oracle records", () => {
    expect(BYTECODE_BUDGET).toBe(28 * 1024);
    expect(budgetFailures([{ bytes: BYTECODE_BUDGET }])).toEqual([]);
    const invalid = [BYTECODE_BUDGET + 1, NaN, Infinity, -1, 1.5].map((bytes) => ({ bytes }));
    expect(budgetFailures(invalid)).toEqual(invalid);
  });

  it("preserves Fast Refresh without sharing the desktop cache or discovering dependencies", async () => {
    await fixture(async (root) => {
      const entry = resolve(root, "HookView.tsx");
      // A local custom hook exercises the same Refresh signature transform
      // without awaiting React/JSX dependency prebundling in this compile-only
      // regression test.
      await writeFile(entry, `function useCount() { return 0; }
        export function HookView() {
          return useCount();
        }
        throw new Error('APPLICATION MUST NOT EXECUTE');
      `);
      const desktopRoot = resolve("apps/desktop");
      const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
      const { DevEnvironment, normalizePath, resolveConfig: resolveViteConfig } = await import(desktopRequire.resolve("vite"));
      const { resolveConfig: resolveElectronConfig } = await import(desktopRequire.resolve("electron-vite"));
      const listen = vi.spyOn(DevEnvironment.prototype, "listen");
      vi.stubEnv("NODE_ENV", process.env.NODE_ENV);
      let development;
      try {
        for await (const module of transformedModules(root, { productionInput: entry })) {
          if (module.variant === "development") { development = module; break; }
        }
        // Vite starts discovery from listen(). Use its resolved client config
        // as the oracle so the check is independent of cache state and timing.
        const rendererRoot = normalizePath(resolve(desktopRoot, "src/renderer"));
        const call = listen.mock.calls.find(([server]) => server.config.root === rendererRoot);
        expect(call, "renderer dev server started").toBeDefined();
        const { optimizeDeps } = call[0].environments.client.config;
        expect(optimizeDeps.noDiscovery, "compile-only server skips dependency discovery").toBe(true);
        expect(optimizeDeps.include).not.toContain("pixelmatch");
        const desktopConfig = await resolveElectronConfig({ root: desktopRoot }, "serve");
        // The desktop dev command runs from apps/desktop, unlike this test.
        const desktopVite = await resolveViteConfig({ ...desktopConfig.config.renderer, root: rendererRoot }, "serve");
        expect(call[0].config.cacheDir, "oracle and desktop dev server use different caches").not.toBe(desktopVite.cacheDir);
      } finally {
        listen.mockRestore();
        vi.unstubAllEnvs();
      }
      expect(development.code).toContain("$RefreshSig$");
      expect(development.code).toMatch(/_s\(\);/);
      const records = await measureBytecode([development]);
      expect(records.some((record) => record.name === "HookView")).toBe(true);
      expect(() => enforceBudget(records)).not.toThrow();
    }, "apps/desktop/.local");
  });

  it.each([false, true])("compiles without execution and finds nested/anonymous over-budget functions (oversized=%s)", async (oversized) => {
    await fixture(async (root) => {
      const entry = resolve(root, "entry.tsx");
      const body = Array.from({ length: oversized ? 1600 : 3 }, (_, i) => `input.step(${i});`).join("\n");
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
        expect(() => enforceBudget(records, (message) => diagnostics.push(message))).toThrow(`${BYTECODE_BUDGET}-byte limit`);
        expect(diagnostics).toHaveLength(8);
        expect(diagnostics.every((message) => message.includes(`bytes > limit ${BYTECODE_BUDGET}`))).toBe(true);
        // Keep the oracle just above the boundary. Excess bytecode means
        // excess disassembly in every pipeline, contending with the full CI
        // suite. Bound that work deterministically, without timing assertions.
        for (const record of failures) {
          expect(record.bytes, `${record.variant} fixture size`).toBeLessThanOrEqual(BYTECODE_BUDGET + 4096);
        }
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
