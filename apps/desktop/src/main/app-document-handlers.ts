import { app } from "electron";
import {
  err,
  ok,
  pwrGitError,
  type AppDocumentKind
} from "@pwrgit/shared";
import { isAppDocumentKind, readAppDocument } from "./app-documents";
import type { CommandBus, CommandContext } from "./command-bus";

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

/**
 * Register the allowlisted read/open surface for bundled legal documents.
 *
 * `openWindow` is injected rather than called directly: a document viewer
 * borrows its palette from the window that summoned it, which only the caller
 * that owns the window registry can resolve — hence the forwarded context.
 */
export function registerAppDocumentHandlers(
  bus: CommandBus,
  openWindow: (kind: AppDocumentKind, context: CommandContext) => void
): void {
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

  bus.register("app:openDocumentWindow", (req, context) => {
    if (!isAppDocumentKind(req.kind)) return invalidDocumentKind(req.kind);
    openWindow(req.kind, context);
    return ok(null);
  });
}
