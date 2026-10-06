import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appDocumentPath,
  isAppDocumentKind,
  readAppDocument,
  type AppDocumentRoots
} from "./app-documents";

function roots(): AppDocumentRoots {
  const base = mkdtempSync(join(tmpdir(), "pwrgit-documents-"));
  return {
    appPath: join(base, "apps", "desktop"),
    isPackaged: false,
    resourcesPath: join(base, "resources")
  };
}

describe("app documents", () => {
  it("accepts only bundled document kinds", () => {
    expect(isAppDocumentKind("license")).toBe(true);
    expect(isAppDocumentKind("third-party-notices")).toBe(true);
    expect(isAppDocumentKind("changelog")).toBe(true);
    expect(isAppDocumentKind("../../secret")).toBe(false);
    // Inherited object keys are not documents.
    expect(isAppDocumentKind("toString")).toBe(false);
    expect(isAppDocumentKind("constructor")).toBe(false);
    expect(isAppDocumentKind(undefined)).toBe(false);
  });

  it("reads the changelog electron-builder ships beside the notices", async () => {
    const documentRoots = roots();
    mkdirSync(documentRoots.resourcesPath, { recursive: true });
    writeFileSync(join(documentRoots.resourcesPath, "CHANGELOG.md"), "# Changelog");
    documentRoots.isPackaged = true;

    await expect(readAppDocument("changelog", documentRoots)).resolves.toEqual({
      kind: "changelog",
      title: "PwrGit Changelog",
      content: "# Changelog"
    });
  });

  it("reads a fixed packaged resource, not a renderer-supplied path", async () => {
    const documentRoots = roots();
    mkdirSync(documentRoots.resourcesPath, { recursive: true });
    writeFileSync(join(documentRoots.resourcesPath, "THIRD_PARTY_LICENSES"), "notices");
    documentRoots.isPackaged = true;

    expect(appDocumentPath("third-party-notices", documentRoots)).toBe(
      join(documentRoots.resourcesPath, "THIRD_PARTY_LICENSES")
    );
    await expect(readAppDocument("third-party-notices", documentRoots)).resolves.toEqual({
      kind: "third-party-notices",
      title: "PwrGit Third-Party Notices",
      content: "notices"
    });
  });

  it("finds development documents at the workspace root", async () => {
    const documentRoots = roots();
    const licensePath = appDocumentPath("license", documentRoots);
    mkdirSync(dirname(licensePath), { recursive: true });
    writeFileSync(licensePath, "MIT");

    await expect(readAppDocument("license", documentRoots)).resolves.toEqual({
      kind: "license",
      title: "PwrGit License",
      content: "MIT"
    });
  });

  it("finds the workspace root from the built entry's deeper app path", async () => {
    // Launching out/main/index.js directly (E2E) sets the app path to that
    // file's folder, two levels below where `electron .` puts it.
    const documentRoots = roots();
    const base = join(documentRoots.appPath, "..", "..");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(base, "CHANGELOG.md"), "# Changelog");
    for (const appPath of [
      documentRoots.appPath,
      join(documentRoots.appPath, "out", "main")
    ]) {
      await expect(
        readAppDocument("changelog", { ...documentRoots, appPath })
      ).resolves.toMatchObject({ content: "# Changelog" });
    }
  });
});
