import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  APP_DOCUMENT_TITLES,
  type AppDocument,
  type AppDocumentKind
} from "@pwrgit/shared";

/** The file behind each document. Its title lives in `@pwrgit/shared`, so the
 *  viewer can show the right one before the read returns. */
const APP_DOCUMENT_FILES: Record<AppDocumentKind, string> = {
  license: "LICENSE",
  "third-party-notices": "THIRD_PARTY_LICENSES",
  // Shipped beside the other two by electron-builder's extraResources, and
  // read from the repo root in development, the same as they are.
  changelog: "CHANGELOG.md"
};

export type AppDocumentRoots = {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
};

export function isAppDocumentKind(value: unknown): value is AppDocumentKind {
  return typeof value === "string" && Object.hasOwn(APP_DOCUMENT_FILES, value);
}

export function appDocumentTitle(kind: AppDocumentKind): string {
  return APP_DOCUMENT_TITLES[kind];
}

/**
 * The workspace root an unpackaged app reads its documents from. The app path
 * is not a fixed depth below it: `electron .` (pnpm dev) makes it
 * `apps/desktop`, but launching the built entry directly, as E2E does, makes
 * it `apps/desktop/out/main`. So walk up to `pnpm-workspace.yaml` instead of
 * counting levels.
 */
function workspaceRoot(appPath: string): string {
  for (let dir = resolve(appPath); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return resolve(appPath, "..", "..");
  }
}

export function appDocumentPath(
  kind: AppDocumentKind,
  roots: AppDocumentRoots
): string {
  const basePath = roots.isPackaged
    ? roots.resourcesPath
    : workspaceRoot(roots.appPath);
  return join(basePath, APP_DOCUMENT_FILES[kind]);
}

/**
 * Reads from an explicit, fixed allowlist. The renderer selects a document
 * kind, never an arbitrary filesystem path.
 */
export async function readAppDocument(
  kind: AppDocumentKind,
  roots: AppDocumentRoots
): Promise<AppDocument> {
  return {
    kind,
    title: APP_DOCUMENT_TITLES[kind],
    content: await readFile(appDocumentPath(kind, roots), "utf8")
  };
}
