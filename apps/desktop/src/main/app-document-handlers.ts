import { app } from "electron";
import { err, ok, pwrGitError } from "@pwrgit/shared";
import { isAppDocumentKind, readAppDocument } from "./app-documents";
import { openAppDocumentWindow } from "./app-document-window";
import type { CommandBus } from "./command-bus";

function documentRoots() {
  return {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  };
}

function invalidDocumentKind(value: unknown) {
  return err(
    pwrGitError(
      "validation",
      "invalid_document_kind",
      `Unknown app document: ${String(value)}`
    )
  );
}

/** Register the allowlisted read/open surface for bundled legal documents. */
export function registerAppDocumentHandlers(bus: CommandBus): void {
  bus.register("app:readDocument", async (req) => {
    if (!isAppDocumentKind(req.kind)) return invalidDocumentKind(req.kind);
    try {
      return ok(await readAppDocument(req.kind, documentRoots()));
    } catch (cause) {
      return err(
        pwrGitError(
          "unknown",
          "document_read_failed",
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      );
    }
  });

  bus.register("app:openDocumentWindow", (req) => {
    if (!isAppDocumentKind(req.kind)) return invalidDocumentKind(req.kind);
    openAppDocumentWindow(req.kind);
    return ok(null);
  });
}
