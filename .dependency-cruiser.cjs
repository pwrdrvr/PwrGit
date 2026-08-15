/**
 * Dependency-boundary lint (`pnpm lint:boundaries`).
 *
 * Ported from PwrAgnt's `.dependency-cruiser.cjs` and scoped to what PwrGit
 * actually has: one app (`apps/desktop`) with the three Electron process
 * bundles, and one workspace package (`packages/shared`).
 *
 * The contract these rules protect, in one sentence: **main, preload, and
 * renderer are three separate bundles in three separate runtimes, and the only
 * thing they may share is `@pwrgit/shared`.** Everything else crosses at
 * runtime through the typed command bus (see `apps/desktop/AGENTS.md`).
 *
 * Why a linter and not just review: every one of these violations
 * type-checks and most of them *bundle*. They fail at launch, or — worse —
 * silently pull a second copy of main-process code into the renderer bundle.
 * `tsc` cannot see any of it.
 *
 * Test files are exempted from two of the renderer rules (marked below).
 * Vitest specs run under Node, not in the sandboxed renderer, so a spec that
 * reaches across the boundary to assert the two sides agree is legitimate —
 * `renderer/src/styles/theme-contract.test.ts` pins renderer CSS tokens to the
 * native chrome colors in `main/window-chrome.ts`, and must import both.
 */

/** Vitest specs — see the note above about the renderer carve-outs. */
const TEST_FILE = "\\.(test|spec)\\.tsx?$";

/**
 * Resolved paths for npm packages carry the pnpm store prefix and the exact
 * version (`node_modules/.pnpm/electron@41.10.4/node_modules/electron/...`),
 * so match the trailing `node_modules/<name>/` segment instead of anchoring.
 * The trailing slash is what keeps `electron/` from also matching
 * `electron-updater/`.
 */
const ELECTRON_PACKAGE = "node_modules/electron/";

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "All dependencies in the repository must remain acyclic. Cycles make " +
        "module init order load-bearing, which in an ESM main bundle shows up " +
        "as an undefined import at launch rather than a build error.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment:
        "Every import must resolve. This rule is load-bearing for the rules " +
        "below: they match on resolved paths, so an import that silently " +
        "fails to resolve would slip through every boundary check.",
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: "main-does-not-import-renderer",
      severity: "error",
      comment:
        "The main process must not import renderer code. Main runs in Node " +
        "with full filesystem and git access; renderer modules assume a DOM " +
        "and would drag React into the main bundle. Main addresses the " +
        "renderer by URL/hash (see main/settings-window.ts), never by import.",
      from: {
        path: "^apps/desktop/src/main/",
      },
      to: {
        path: "^apps/desktop/src/renderer/",
      },
    },
    {
      name: "main-does-not-import-preload",
      severity: "error",
      comment:
        "The main process must not import preload code. Preload is a separate " +
        "bundle that main references by file path at window-creation time; " +
        "importing it would evaluate contextBridge calls in the wrong runtime.",
      from: {
        path: "^apps/desktop/src/main/",
      },
      to: {
        path: "^apps/desktop/src/preload/",
      },
    },
    {
      name: "renderer-does-not-import-main",
      severity: "error",
      comment:
        "The renderer must not import main-process code. The renderer talks to " +
        "main only through the typed command bus exposed by preload. A direct " +
        "import bundles main's Node/native dependencies into the sandboxed " +
        "renderer, where they cannot load. Exempt: vitest specs, which run " +
        "under Node and may assert both sides agree.",
      from: {
        path: "^apps/desktop/src/renderer/",
        pathNot: TEST_FILE,
      },
      to: {
        path: "^apps/desktop/src/main/",
      },
    },
    {
      name: "renderer-does-not-import-preload",
      severity: "error",
      comment:
        "The renderer must not import preload code either. Preload's exports " +
        "reach the renderer as `window.pwrgit` at runtime via contextBridge; " +
        "importing the module directly gets a second copy that is not bridged " +
        "and whose `electron` import is unavailable in the renderer sandbox.",
      from: {
        path: "^apps/desktop/src/renderer/",
      },
      to: {
        path: "^apps/desktop/src/preload/",
      },
    },
    {
      name: "renderer-does-not-import-electron",
      severity: "error",
      comment:
        "The renderer must not import `electron`. It runs sandboxed with node " +
        "integration off, so `ipcRenderer` and friends are simply absent — the " +
        "bridge in src/preload is the only supported surface.",
      from: {
        path: "^apps/desktop/src/renderer/",
      },
      to: {
        path: ELECTRON_PACKAGE,
      },
    },
    {
      name: "renderer-does-not-import-node-builtins",
      severity: "error",
      comment:
        "The renderer must not import Node core modules (`node:fs`, `node:path`, " +
        "…). Same sandbox reason as the `electron` rule: these resolve at build " +
        "time and throw at runtime. Anything needing the filesystem belongs in " +
        "main behind a command. Exempt: vitest specs, which run under Node.",
      from: {
        path: "^apps/desktop/src/renderer/",
        pathNot: TEST_FILE,
      },
      to: {
        dependencyTypes: ["core"],
      },
    },
    {
      name: "preload-imports-only-electron-and-shared",
      severity: "error",
      comment:
        "Preload is an allowlist, not a denylist: it may import `electron`, " +
        "`@pwrgit/shared`, and its own modules — nothing else. It runs in a " +
        "privileged context bridged into the renderer, so every extra import " +
        "widens the surface a compromised renderer can reach.",
      from: {
        path: "^apps/desktop/src/preload/",
      },
      to: {
        pathNot: [
          "^apps/desktop/src/preload/",
          "^packages/shared/",
          ELECTRON_PACKAGE,
        ],
      },
    },
    {
      name: "shared-is-a-leaf",
      severity: "error",
      comment:
        "packages/shared must not import app code or any other workspace " +
        "package. It is the one module loaded by all three processes; a single " +
        "edge back into apps/** would pull main-process code into the renderer " +
        "bundle through the back door.",
      from: {
        path: "^packages/shared/",
      },
      to: {
        path: "^(@pwrgit/(?!shared)|apps/|packages/(?!shared/))",
      },
    },
    {
      // Split from the Node-core rule below because every attribute inside a
      // single `to` block is ANDed — one rule matching both `dependencyTypes`
      // and `path` would require a dependency that is somehow a core module
      // *and* the electron package, i.e. it could never fire.
      name: "shared-does-not-import-electron",
      severity: "error",
      comment:
        "packages/shared must not import `electron`. It is loaded in the " +
        "sandboxed renderer, where the electron module is absent; a single " +
        "import here breaks all three processes' shared contract at once.",
      from: {
        path: "^packages/shared/",
      },
      to: {
        path: ELECTRON_PACKAGE,
      },
    },
    {
      name: "shared-does-not-import-node-builtins",
      severity: "error",
      comment:
        "packages/shared must not import Node core modules. It has to stay " +
        "types and pure functions so the renderer can load it — the moment it " +
        "reaches for `node:fs` the renderer build breaks.",
      from: {
        path: "^packages/shared/",
      },
      to: {
        dependencyTypes: ["core"],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
      dependencyTypes: [
        "npm",
        "npm-dev",
        "npm-optional",
        "npm-peer",
        "npm-bundled",
        "npm-no-pkg",
      ],
    },
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    /**
     * Without this, `@pwrgit/shared` does not resolve: the package exposes
     * TypeScript sources through its `exports` map (`"." : "./src/index.ts"`),
     * and dependency-cruiser's default resolver extensions do not include
     * `.ts`. Every workspace import then lands as an unresolvable bare
     * specifier, which quietly defeats `shared-is-a-leaf` and cycle detection
     * across the package boundary.
     */
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".node"],
    },
  },
};
