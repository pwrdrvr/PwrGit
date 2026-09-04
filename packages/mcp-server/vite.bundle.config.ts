import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const OUT_DIR = "dist-bundle";
const OUT_FILE = "pwrgit-mcp.mjs";

/** The shebang has to land after esbuild has transpiled the chunk. As a
 * rollup `banner` it reaches esbuild's input and fails the build on `!`. */
function shebang(): Plugin {
  return {
    name: "pwrgit-shebang",
    closeBundle() {
      const file = join(__dirname, OUT_DIR, OUT_FILE);
      const body = readFileSync(file, "utf8");
      if (body.startsWith("#!")) return;
      writeFileSync(file, `#!/usr/bin/env node\n${body}`);
      chmodSync(file, 0o755);
    }
  };
}

/** Emits a single self-contained `pwrgit-mcp.mjs`.
 *
 * PwrGit.app ships this file so an operator can point any stdio MCP client at
 * the installed app without a Node install, a clone, or a build: the app hands
 * out a config that runs it through Electron with ELECTRON_RUN_AS_NODE=1.
 *
 * It has to be one file. Shipping `dist/` plus a node_modules tree would mean
 * reasoning about pnpm's symlinked store inside an asar, which is the same
 * class of problem that already forced dugite's git out of the archive. */
export default defineConfig({
  plugins: [shebang()],
  // Without this the lib build resolves the "browser" export condition, and
  // `ws` hands back a stub whose WebSocketServer is not a constructor. The
  // bundle then builds cleanly and dies on first launch.
  // `noExternal` is what makes it self-contained: an SSR build leaves
  // node_modules imports alone by default, which is the opposite of what a
  // single shipped file needs.
  ssr: { target: "node", noExternal: true },
  build: {
    ssr: true,
    target: "node20",
    outDir: OUT_DIR,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/bin.ts",
      formats: ["es"],
      fileName: () => OUT_FILE
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        // ws loads these only when present and falls back to its JS paths.
        "bufferutil",
        "utf-8-validate"
      ],
      output: {
        inlineDynamicImports: true,
        // An SSR build names chunks after the entry and ignores lib.fileName.
        entryFileNames: OUT_FILE
      }
    }
  }
});
