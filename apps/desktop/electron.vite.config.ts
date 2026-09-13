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

/**
 * Dev-only: bridge the renderer to the standalone `react-devtools` app.
 *
 * Set to `1` to have the renderer HTML load the DevTools backend from
 * `http://<host>:<port>` as its very first script — the hook has to be
 * installed before `react-dom` initializes or React never registers a
 * renderer with it. Companion vars pick the endpoint; see
 * `apps/desktop/AGENTS.md` ("Profiling the renderer with React DevTools").
 *
 * Read at Vite config time, not at app runtime. With the var unset the plugin
 * below is never constructed, so a normal `electron-vite build` emits the same
 * HTML it does today. `verify-asar-contents.mjs` fails packaging if a bridged
 * HTML ever reaches an app.asar anyway.
 */
const REACT_DEVTOOLS_ENV = "PWRGIT_REACT_DEVTOOLS";
const REACT_DEVTOOLS_HOST_ENV = "PWRGIT_REACT_DEVTOOLS_HOST";
const REACT_DEVTOOLS_PORT_ENV = "PWRGIT_REACT_DEVTOOLS_PORT";
const DEFAULT_REACT_DEVTOOLS_HOST = "localhost";
const DEFAULT_REACT_DEVTOOLS_PORT = "8097";

/**
 * Dev-only: build the renderer against `react-dom/profiling` instead of
 * `react-dom/client`, so the DevTools Profiler can record a production bundle.
 * A plain production `react-dom` is compiled without the timing
 * instrumentation and the Profiler tab reports "Profiling not supported".
 *
 * Only `react-dom/client` is aliased. Every other entry — bare `react-dom` for
 * `createPortal`/`flushSync`, and `react-dom/server` — keeps resolving
 * normally, which is what keeps a single reconciler in the bundle: in React 19
 * both `react-dom/client` and `react-dom/profiling` require the shared bare
 * `react-dom` module for their internals, so swapping the client entry alone
 * cannot produce two copies.
 */
const REACT_PROFILING_ENV = "PWRGIT_REACT_PROFILING";

/**
 * The allowlist the rest of the repository uses for on/off env flags
 * (`isEnabled` in `src/main/diagnostics/hot-cpu-profile-config.ts`,
 * `startup-cpu-profile-config.ts`, `heap-monitor-config.ts`). Anything else is
 * off — in particular `false`, `off`, and `no`, which a "not empty and not 0"
 * test would read as on and silently bake the bridge into a build.
 */
function isEnvEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value !== undefined && ["1", "true", "yes", "on"].includes(value);
}

/**
 * Injects the standalone React DevTools backend as the first `<head>` script.
 * `head-prepend` matters: it lands above the appearance bootstrap in
 * `src/renderer/index.html` and above the `/src/main.tsx` module, which is the
 * ordering the DevTools hook needs. That HTML carries no CSP and main sets
 * none, so the tag has nothing to fight.
 *
 * The script also logs the endpoint to the renderer console. Several PwrDrvr
 * Electron apps usually run at once on one machine and the standalone DevTools
 * window says nothing about which page is on the other end of its socket, so
 * that line is how an operator confirms *this* window is the one attached.
 */
function reactDevtoolsBridge(): Plugin {
  const host = process.env[REACT_DEVTOOLS_HOST_ENV]?.trim()
    || DEFAULT_REACT_DEVTOOLS_HOST;
  const port = process.env[REACT_DEVTOOLS_PORT_ENV]?.trim()
    || DEFAULT_REACT_DEVTOOLS_PORT;
  const endpoint = `http://${host}:${port}`;
  return {
    name: "pwrgit-react-devtools-bridge",
    transformIndexHtml: {
      order: "pre",
      // Returns the bare tag array rather than `{ html, tags }`: the object
      // form's `html` is required by the type, and passing "" to mean "leave
      // the document alone" only works because Vite happens to do
      // `res.html || html`. The array form says the same thing by contract.
      handler: () => [
        {
          tag: "script",
          attrs: { src: endpoint },
          injectTo: "head-prepend" as const
        },
        {
          tag: "script",
          // Vite escapes tag attributes but emits inline-script children
          // verbatim, and JSON.stringify does not escape `<` — so a host
          // carrying `</script>` would close this tag early.
          children: `console.info(${JSON.stringify(
            `[pwrgit] React DevTools bridge -> ${endpoint} (renderer from ${__dirname})`
          ).replaceAll("<", "\\u003c")});`,
          injectTo: "head-prepend" as const
        }
      ]
    }
  };
}

export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  const productionDefine = isBuild
    ? { "process.env.NODE_ENV": JSON.stringify("production") }
    : {};

  const devtoolsBridgeEnabled = isEnvEnabled(REACT_DEVTOOLS_ENV);
  // The profiling alias is a build-only swap. `electron-vite dev` already
  // serves react-dom's development build, which carries the Profiler and the
  // hook-level "why did this render" attribution the production profiling
  // build drops — so aliasing in dev would cost a dependency re-optimization
  // and buy nothing.
  const profilingEnabled = isEnvEnabled(REACT_PROFILING_ENV);
  if (profilingEnabled) {
    console.warn(
      isBuild
        ? `[pwrgit] ${REACT_PROFILING_ENV} is set: aliasing react-dom/client -> react-dom/profiling.`
          + " Do not ship this build."
        : `[pwrgit] ${REACT_PROFILING_ENV} is set but only applies to \`electron-vite build\`;`
          + " the dev server already serves a profilable react-dom."
    );
  }
  if (devtoolsBridgeEnabled && isBuild) {
    console.warn(
      `[pwrgit] ${REACT_DEVTOOLS_ENV} is set: the built renderer HTML will load the`
      + " React DevTools backend over http. Do not ship this build."
    );
  }

  return {
    main: {
      define: productionDefine,
      // Source-form workspace packages get bundled, not externalized — Node's
      // ESM resolver can't follow extensionless `./protocol`-style imports
      // inside source-form packages. Mirrors PwrSnap / PwrAgnt.
      plugins: [
        // Keep ws as a desktop runtime dependency so it stays external here.
        // Bundling its optional native accelerators can emit a top-level
        // missing-bufferutil error even though ws works without them in Node.
        externalizeDepsPlugin({
          exclude: ["@pwrgit/shared", "@pwrgit/mcp-server"]
        }),
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
      plugins: devtoolsBridgeEnabled
        ? [react(), reactDevtoolsBridge()]
        : [react()],
      resolve: {
        alias: {
          "@renderer": resolve(__dirname, "src/renderer/src"),
          ...(profilingEnabled && isBuild
            ? { "react-dom/client": "react-dom/profiling" }
            : {})
        }
      },
      build: { minify: "esbuild", sourcemap: false }
    }
  };
});
