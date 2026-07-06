import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Copy the reviewable .sql migrations beside the compiled main bundle so the
 * runtime migration runner (src/main/persistence/db.ts) finds them in a
 * packaged build. In dev/test they resolve directly under src/.
 */
function copyMigrationsPlugin(): Plugin {
  return {
    name: "pwrgit-copy-migrations",
    writeBundle(options) {
      const out = options.dir;
      if (out === undefined) return;
      const src = resolve(__dirname, "src/main/persistence/migrations");
      if (!existsSync(src)) return;
      const dest = resolve(out, "migrations");
      mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(src)) {
        if (file.endsWith(".sql")) {
          copyFileSync(resolve(src, file), resolve(dest, file));
        }
      }
    }
  };
}

export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  const productionDefine = isBuild
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : {};

  return {
    main: {
      define: productionDefine,
      // Source-form workspace packages get bundled, not externalized — Node's
      // ESM resolver can't follow extensionless `./protocol`-style imports
      // inside source-form packages. Mirrors PwrSnap / PwrAgnt.
      plugins: [
        externalizeDepsPlugin({ exclude: ["@pwrgit/shared"] }),
        copyMigrationsPlugin()
      ],
      build: {
        minify: "esbuild",
        sourcemap: false,
        rollupOptions: {
          input: { index: resolve(__dirname, "src/main/index.ts") },
          output: { entryFileNames: "[name].js" }
        }
      }
    },
    preload: {
      define: productionDefine,
      plugins: [externalizeDepsPlugin({ exclude: ["@pwrgit/shared"] })],
      build: {
        minify: "esbuild",
        sourcemap: false,
        // CJS so the sandboxed preload can `require("electron")`. `.cjs`
        // extension is required because the package is `"type": "module"`.
        rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } }
      }
    },
    renderer: {
      plugins: [react()],
      resolve: {
        alias: { "@renderer": resolve(__dirname, "src/renderer/src") }
      },
      build: { minify: "esbuild", sourcemap: false }
    }
  };
});
