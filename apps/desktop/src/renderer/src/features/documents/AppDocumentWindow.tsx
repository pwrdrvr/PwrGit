import { useEffect, useState } from "react";
import type { AppDocument, AppDocumentKind } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";

/** Read-only viewer for main-process allowlisted app resources. */
export function AppDocumentWindow(props: { kind: AppDocumentKind }) {
  const [document, setDocument] = useState<AppDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void dispatch("app:readDocument", { kind: props.kind }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      window.document.title = result.value.title;
      setDocument(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [props.kind]);

  const title =
    document?.title ??
    (props.kind === "license" ? "PwrGit License" : "PwrGit Third-Party Notices");

  return (
    <main className="document-window">
      <header className="document-window__header">
        <p className="document-window__eyebrow">PwrGit</p>
        <h1>{title}</h1>
      </header>
      {error !== null ? (
        <p className="document-window__error" role="alert">
          Could not load this bundled document: {error}
        </p>
      ) : document === null ? (
        <p className="document-window__loading">Loading…</p>
      ) : (
        <pre aria-label={document.title} className="document-window__content">
          {document.content}
        </pre>
      )}
    </main>
  );
}
