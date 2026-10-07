import { useEffect, useState } from "react";
import {
  APP_DOCUMENT_TITLES,
  type AppDocument,
  type AppDocumentKind
} from "@pwrgit/shared";
import { AuxiliaryTitleBar } from "../chrome/AuxiliaryTitleBar";
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

  const title = document?.title ?? APP_DOCUMENT_TITLES[props.kind];

  return (
    <main className="document-window">
      <AuxiliaryTitleBar section="Help" title={title} />
      <header className="document-window__header">
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
