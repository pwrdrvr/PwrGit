import { useEffect, useState } from "react";
import { executablePathExample, normalizeManualExecutablePath } from "@pwrgit/shared";

/**
 * A path field with its own Save and Clear. The draft follows the saved value
 * when it changes elsewhere (another window, a pin), and is checked against
 * the absolute-path rule before anything is sent — main enforces the same rule
 * and would otherwise drop the path without saying why.
 */
export function ManualPathInput(props: {
  executable: string;
  label: string;
  saved: string;
  saveLabel: string;
  disabled: boolean;
  onSave: (path: string) => Promise<string | null>;
  onClear: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(props.saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const platform = window.pwrgit.platform;

  useEffect(() => {
    setDraft(props.saved);
  }, [props.saved]);

  const trimmed = draft.trim();
  const dirty = trimmed.length > 0 && trimmed !== props.saved;

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setError(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-ai-path">
      <div className="settings-field__actions">
        <input
          aria-invalid={error !== null}
          aria-label={props.label}
          className="settings-input settings-ai-path__input"
          disabled={props.disabled}
          // "e.g.", because a bare example path reads as the value — and for
          // Codex it is often the very install already in use.
          placeholder={`e.g. ${executablePathExample(platform, props.executable)}`}
          spellCheck={false}
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
        />
        <button
          aria-busy={busy}
          aria-disabled={busy || !dirty}
          className="settings-inline-button"
          disabled={props.disabled}
          type="button"
          onClick={() => {
            if (busy || !dirty) return;
            const normalized = normalizeManualExecutablePath(platform, draft);
            if (!normalized.ok) {
              setError(normalized.error);
              return;
            }
            void run(() => props.onSave(normalized.path));
          }}
        >
          {busy ? "Saving…" : props.saveLabel}
        </button>
        <button
          aria-disabled={busy || (props.saved === "" && draft === "")}
          className="settings-inline-button"
          disabled={props.disabled}
          type="button"
          onClick={() => {
            if (busy || (props.saved === "" && draft === "")) return;
            setDraft("");
            if (props.saved !== "") void run(props.onClear);
          }}
        >
          Clear
        </button>
      </div>
      {error !== null && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
