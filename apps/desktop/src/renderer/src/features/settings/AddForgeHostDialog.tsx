import { useRef, useState } from "react";
import { canonicalForgeHostname, forgeProduct, type ForgeKind } from "@pwrgit/shared";
import { useModal } from "../../lib/useModal";

/**
 * Names one instance and its product together, in that order of importance.
 *
 * The product is settled before this opens — it is which section's button was
 * pressed, and the title says so — leaving exactly one thing to type.
 */
export function AddForgeHostDialog(props: {
  kind: ForgeKind;
  /** Hostnames already on the list — every product's, not just this one's, so a
   *  duplicate is refused in front of the user instead of rewriting an existing
   *  host's product. */
  listed: readonly string[];
  onAdd: (host: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<
    { text: string; seq: number } | undefined
  >();
  const submitting = useRef(false);
  const { label, cli, addHost } = forgeProduct(props.kind);
  const { title, placeholder } = addHost;
  const titleId = `add-forge-host-${props.kind}-title`;
  // Escape is refused mid-write, matching the backdrop.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) props.onClose();
    }
  });

  /** Re-keyed on every rejection, even an identical one: React bails out of a
   *  state update to the same string, so resubmitting an unchanged bad value
   *  left the `role="alert"` node untouched and a screen reader silent. */
  const reject = (text: string): void => {
    setError((current) => ({ text, seq: (current?.seq ?? 0) + 1 }));
  };

  const submit = async (): Promise<void> => {
    // A ref, not `busy`: Enter key-repeat delivers two keydowns before React
    // has re-rendered with the new state, and both used to submit.
    if (submitting.current || busy) return;
    // Mirrors the Add button's own unavailable condition — the Enter path
    // bypassed it, so an untouched field was reported as a malformed hostname.
    if (value.trim() === "") return;
    // Canonicalized HERE, with the function the write path uses. Main silently
    // drops a key it cannot canonicalize, so a URL pasted into this box would
    // otherwise dispatch, succeed, and add no row — the setting appears saved
    // and does nothing.
    const host = canonicalForgeHostname(value);
    if (host === null) {
      // Deliberately not a list of causes: the shared regex also rejects
      // underscores, a trailing dot and non-ASCII labels, and naming only
      // scheme/port/path told those users they had done something they hadn't.
      reject("That is not a hostname. Enter one like github.example.com.");
      return;
    }
    if (props.listed.includes(host)) {
      reject(`${host} is already on the list.`);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const message = await props.onAdd(host);
      if (message === null) props.onClose();
      else reject(message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay-backdrop"
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        ref={modalRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal"
        role="dialog"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title" id={titleId}>
          {title}
        </div>
        <label className="field modal__field">
          <span className="field__label">Hostname</span>
          <input
            className="modal__input"
            autoComplete="off"
            autoFocus
            placeholder={placeholder}
            spellCheck={false}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              // Escape is the dialog's, via useModal.
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        <div className="modal__hint">
          PwrGit will treat this host as {label} and talk to it through{" "}
          <code>{cli}</code>. The hostname plays no
          part in that — this choice does.
        </div>
        {error !== undefined && (
          <div className="modal__error" key={error.seq} role="alert">
            {error.text}
          </div>
        )}
        <div className="modal__actions">
          {/* In-flight is aria-disabled, never disabled: Chromium blurs a
              disabled element the moment it becomes disabled, and inside a
              focus trap that drops the user on <body> with nothing to Tab back
              from (SC 2.4.3). Handlers are guarded instead. An empty field is
              a genuinely unavailable action, so that half keeps `disabled`. */}
          <button
            aria-disabled={busy}
            className="modal__cancel"
            type="button"
            onClick={() => {
              if (busy) return;
              props.onClose();
            }}
          >
            Cancel
          </button>
          <button
            aria-disabled={busy}
            className="modal__create"
            type="button"
            disabled={value.trim() === ""}
            onClick={() => void submit()}
          >
            {busy ? "Adding…" : "Add host"}
          </button>
        </div>
      </div>
    </div>
  );
}
