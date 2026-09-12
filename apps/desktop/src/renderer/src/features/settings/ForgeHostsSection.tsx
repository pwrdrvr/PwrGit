import { useCallback, useEffect, useRef, useState } from "react";
import {
  canonicalForgeHostname,
  type ForgeHostConfig,
  type ForgeHostRow,
  type ForgeKind
} from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { useModal } from "../../lib/useModal";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const KIND_LABEL: Record<ForgeHostRow["kind"], string> = {
  github: "GitHub",
  gitlab: "GitLab"
};

/**
 * Adding a host by hand, one product at a time.
 *
 * There is a button per product because the product is *chosen* here, never
 * derived. Enumeration carries it for free — `gh` only knows GitHub hosts,
 * `glab` only GitLab ones — but a hostname is not evidence of anything, so a
 * single "Add host…" button would have to guess from the name or ask "which
 * forge is this?" afterwards. Both are the thing `forge/AGENTS.md` rules out.
 */
const ADD_HOST: Record<
  ForgeKind,
  { button: string; title: string; placeholder: string; cli: string }
> = {
  github: {
    button: "Add GitHub Enterprise…",
    title: "Add a GitHub Enterprise host",
    placeholder: "github.acme-inc.com",
    cli: "gh"
  },
  gitlab: {
    button: "Add GitLab instance…",
    title: "Add a GitLab instance",
    placeholder: "gitlab.example.com",
    cli: "glab"
  }
};

/**
 * Settings → Forges → Hosts.
 *
 * Rows come from main, which enumerates what `gh` and `glab` are signed in to,
 * plus the hosts the user added by hand. Git remotes are deliberately not a
 * source: a remote is an ssh target, and a NAS or a box on a home network is
 * not a forge — see `forge/AGENTS.md`.
 *
 * The switch is enforced at the transport, not here: a disabled host resolves
 * to null in main, so nothing spawns its CLI or mints its token. This pane only
 * ever writes the setting and re-reads what main says.
 */
export function ForgeHostsSection(props: { saving: boolean }) {
  const [hosts, setHosts] = useState<ForgeHostRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  const [adding, setAdding] = useState<ForgeKind | undefined>();
  const mounted = useRef(false);

  const read = useCallback(async (refresh: boolean): Promise<void> => {
    setBusy(true);
    try {
      const result = await dispatch("forge:hosts", refresh ? { refresh } : {});
      if (!mounted.current) return;
      if (result.ok) {
        setHosts(result.value.hosts);
        setError(undefined);
      } else {
        setError(result.error.message);
      }
    } catch (cause) {
      // Without this the rejection escapes past `setBusy(false)` and every
      // control stays disabled on "Checking…" forever, with nothing shown.
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read(false);
    return () => {
      mounted.current = false;
    };
  }, [read]);

  /**
   * Write one host's entry and re-read the list from main.
   *
   * Returns the failure message rather than setting it, so each caller can put
   * it where the user is looking — the section for a switch or a Remove, the
   * dialog for an add. A re-read is never a `refresh`: adding or clearing a
   * config entry changes nothing either CLI would report, and refreshing spawns
   * two subprocesses to learn that.
   */
  const writeHost = async (
    host: string,
    value: ForgeHostConfig | null
  ): Promise<string | undefined> => {
    try {
      const result = await dispatch("settings:update", {
        patch: { forgeHosts: { [host]: value } }
      });
      if (!mounted.current) return undefined;
      if (!result.ok) return result.error.message;
      await read(false);
      return undefined;
    } catch (cause) {
      if (!mounted.current) return undefined;
      return cause instanceof Error ? cause.message : String(cause);
    }
  };

  const toggle = async (row: ForgeHostRow, next: boolean): Promise<void> => {
    // Always write the value the user asked for. An earlier version cleared
    // the entry instead, on the theory that clearing returns the host to its
    // derived default — but the derived default can BE the value they are
    // trying to leave, in which case the switch silently snapped back and the
    // host could not be turned off at all.
    const message = await writeHost(row.host, { enabled: next });
    if (message !== undefined) setError(message);
  };

  const remove = async (row: ForgeHostRow): Promise<void> => {
    // `null` clears the whole entry, and for a hand-added host that entry is
    // the only thing naming its product — so the row goes away rather than
    // lingering as an unknown forge (`ForgeHosts.list` skips a config entry
    // whose kind resolves to null). No confirmation: nothing is destroyed, and
    // the two buttons below put it back.
    const message = await writeHost(row.host, null);
    if (message !== undefined) setError(message);
  };

  const connected = hosts?.filter((row) => row.enabled).length;

  return (
    <SettingsSection
      title="Hosts"
      eyebrow="Integrations"
      description="Reported by the GitHub and GitLab CLIs, plus hosts you add. PwrGit only ever talks to a host on this list — a plain ssh remote never appears here."
      chip={
        hosts === undefined
          ? undefined
          : hosts.length === 0
            ? "None"
            : `${connected} of ${hosts.length} on`
      }
      chipKind={hosts !== undefined && connected === 0 ? "warn" : "ok"}
    >
      {error !== undefined && (
        <p className="settings-field__error" role="alert">
          {error}
        </p>
      )}
      {hosts === undefined ? (
        <SettingsField
          label="Checking…"
          control={<span className="settings-card__chip">Reading</span>}
        />
      ) : hosts.length === 0 ? (
        <p className="settings-empty">
          Neither <code>gh</code> nor <code>glab</code> is signed in to a host.
          Sign in from a terminal, then re-check — or add the instance below.
        </p>
      ) : (
        hosts.map((row) => (
          <SettingsField
            key={row.host}
            label={row.host}
            sub={describe(row)}
            control={
              <SettingsSwitch
                checked={row.enabled}
                // In-flight is aria-disabled, never disabled: Chromium blurs a
                // disabled element, throwing keyboard focus to <body> for the
                // length of the operation. The handler is guarded instead.
                busy={props.saving || busy}
                label={`Read ${KIND_LABEL[row.kind]} status from ${row.host}`}
                onChange={(next) => {
                  if (props.saving || busy) return;
                  void toggle(row, next);
                }}
              />
            }
            help={
              row.origin === "config" ? (
                <>
                  Added by you. <code>{row.cli}</code> holds no account for this
                  host yet — run{" "}
                  <code>{signInCommand(row)}</code>
                  {" "}
                  <button
                    className="settings-inline-button"
                    type="button"
                    onClick={() => {
                      void copyText(signInCommand(row));
                      setCopied(row.host);
                    }}
                  >
                    {copied === row.host ? "Copied" : "Copy"}
                  </button>
                  {" "}
                  {/* "Remove host", not "Remove": it sits beside a command
                      the button above copies, and bare "Remove" reads as if it
                      might take the command or the account instead. The label
                      names the host so several rows are distinguishable, and
                      keeps the visible text as its prefix (SC 2.5.3). */}
                  <button
                    aria-disabled={props.saving || busy}
                    aria-label={`Remove host ${row.host}`}
                    className="settings-inline-button"
                    type="button"
                    onClick={() => {
                      if (props.saving || busy) return;
                      void remove(row);
                    }}
                  >
                    Remove host
                  </button>
                </>
              ) : (
                sourceNote(row)
              )
            }
          />
        ))
      )}
      <SettingsField
        label="Add a host"
        sub="For an instance you have not signed in to yet."
        control={
          <div className="settings-field__actions">
            {(Object.keys(ADD_HOST) as ForgeKind[]).map((kind) => (
              <button
                key={kind}
                className="settings-button"
                type="button"
                onClick={() => setAdding(kind)}
              >
                {ADD_HOST[kind].button}
              </button>
            ))}
          </div>
        }
        help="You name the host and its product. Nothing is inferred from a hostname, and no ssh remote ever appears here on its own."
      />
      <SettingsField
        label="Re-check"
        sub="Ask both CLIs again — after signing in from a terminal."
        control={
          <button
            aria-busy={busy}
            aria-disabled={busy}
            className="settings-button"
            type="button"
            onClick={() => {
              if (busy) return;
              void read(true);
            }}
          >
            <RefreshGlyph />
            {busy ? "Checking…" : "Re-check"}
          </button>
        }
      />
      {adding !== undefined && (
        <AddForgeHostDialog
          kind={adding}
          listed={hosts ?? []}
          onAdd={(host, kind) => writeHost(host, { kind })}
          onClose={() => setAdding(undefined)}
        />
      )}
    </SettingsSection>
  );
}

/**
 * Names one instance and its product together, in that order of importance.
 *
 * The product is settled before this opens — it is which button was pressed,
 * and the title says so — leaving exactly one thing to type.
 */
function AddForgeHostDialog(props: {
  kind: ForgeKind;
  /** Hosts already on the list, so a duplicate is refused in front of the user
   *  instead of writing an entry that changes nothing visible. */
  listed: readonly ForgeHostRow[];
  onAdd: (host: string, kind: ForgeKind) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const copy = ADD_HOST[props.kind];
  const titleId = `add-forge-host-${props.kind}-title`;
  // Escape is refused mid-write, matching the backdrop.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) props.onClose();
    }
  });

  const submit = async (): Promise<void> => {
    if (busy) return;
    // Canonicalized HERE, with the function the write path uses. Main silently
    // drops a key it cannot canonicalize, so a URL pasted into this box would
    // otherwise dispatch, succeed, and add no row — the setting appears saved
    // and does nothing.
    const host = canonicalForgeHostname(value);
    if (host === null) {
      setError("Enter just the hostname — no scheme, port or path.");
      return;
    }
    if (props.listed.some((row) => row.host === host)) {
      setError(`${host} is already on the list.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const message = await props.onAdd(host, props.kind);
    setBusy(false);
    if (message === undefined) props.onClose();
    else setError(message);
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
          {copy.title}
        </div>
        <label className="field add-forge-host__field">
          <span className="field__label">Hostname</span>
          <input
            className="modal__input"
            autoComplete="off"
            autoFocus
            placeholder={copy.placeholder}
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
          PwrGit will treat this host as {KIND_LABEL[props.kind]} and talk to it
          through <code>{copy.cli}</code>. The hostname plays no part in that —
          this choice does.
        </div>
        {error !== undefined && (
          <div className="modal__error" role="alert">
            {error}
          </div>
        )}
        <div className="modal__actions">
          <button
            className="modal__cancel"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="modal__create"
            type="button"
            disabled={busy || value.trim() === ""}
            onClick={() => void submit()}
          >
            {busy ? "Adding…" : "Add host"}
          </button>
        </div>
      </div>
    </div>
  );
}

function signInCommand(row: ForgeHostRow): string {
  return `${row.cli} auth login --hostname ${row.host}`;
}

function describe(row: ForgeHostRow): string {
  const parts = [KIND_LABEL[row.kind]];
  if (row.account !== undefined) parts.push(`signed in as ${row.account}`);
  return parts.join(" · ");
}

/** Says WHY the switch reads as it does, so a derived default never looks like
 *  a choice somebody made. */
function sourceNote(row: ForgeHostRow): string {
  if (row.enabledSource === "env") {
    return "Set by an environment variable; the switch cannot change it.";
  }
  if (row.enabledSource === "config") {
    return row.enabled
      ? "On because you turned it on."
      : "Off. PwrGit runs no command and mints no token for this host.";
  }
  // `auto` means nobody has decided — a known forge is on by default. It does
  // NOT mean "on because a CLI is signed in"; permission deliberately does not
  // depend on enumeration having succeeded.
  const scopes =
    row.scopes === undefined ? "" : ` · scopes: ${row.scopes.join(", ")}`;
  return `On by default${scopes}`;
}
