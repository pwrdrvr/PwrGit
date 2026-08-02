import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppDocument, AppDocumentKind } from "@pwrgit/shared";

type AppDocumentDefinition = {
  title: string;
  file: string;
};

const APP_DOCUMENTS: Record<AppDocumentKind, AppDocumentDefinition> = {
  license: {
    title: "PwrGit License",
    file: "LICENSE"
  },
  "third-party-notices": {
    title: "PwrGit Third-Party Notices",
    file: "THIRD_PARTY_LICENSES"
  }
};

export type AppDocumentRoots = {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
};

export function isAppDocumentKind(value: unknown): value is AppDocumentKind {
  return value === "license" || value === "third-party-notices";
}

export function appDocumentPath(
  kind: AppDocumentKind,
  roots: AppDocumentRoots
): string {
  const basePath = roots.isPackaged
    ? roots.resourcesPath
    : resolve(roots.appPath, "..", "..");
  return join(basePath, APP_DOCUMENTS[kind].file);
}

/**
 * Reads from an explicit, fixed allowlist. The renderer selects a document
 * kind, never an arbitrary filesystem path.
 */
export async function readAppDocument(
  kind: AppDocumentKind,
  roots: AppDocumentRoots
): Promise<AppDocument> {
  const definition = APP_DOCUMENTS[kind];
  return {
    kind,
    title: definition.title,
    content: await readFile(appDocumentPath(kind, roots), "utf8")
  };
}
