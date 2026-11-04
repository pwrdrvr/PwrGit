import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A Vite build of one harness page (`<name>/index.html` beside this file)
 * against the real renderer source, imported by relative path: the app's own
 * components and stylesheets, with the page supplying a fake preload bridge. Relative
 * `base`, so the output loads from `file://`. Returns the built HTML's path.
 */
export async function buildHarness(name: string, outDir: string): Promise<string> {
  await build({
    configFile: false,
    root: join(HERE, name),
    base: "./",
    logLevel: "warn",
    plugins: [react()],
    build: { outDir, emptyOutDir: true, minify: false, sourcemap: false }
  });
  return join(outDir, "index.html");
}
