import { useCallback, useEffect, useRef, useState } from "react";
import {
  canonicalForgeHostname,
  FORGE_CLI,
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
  { button: string; title: string; placeholder: string }
> = {
  github: {
    button: "Add GitHub Enterprise…",
    title: "Add a GitHub Enterprise host",
    placeholder: "github.acme-inc.com"
  },
  gitlab: {
    button: "Add GitLab instance…",
    title: "Add a GitLab instance",
    placeholder: "gitlab.example.com"
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
 * The switch is enforced in main, not here. It covers every BACKGROUND reader
 * by hostname: request status, commit authors, the identity refresh, and the
 * status probe itself. It does not cover everything: the CLI sign-in check
 * that discovers the host in the first place still runs, and the clone and
 * fork dialogs gate on `forgeSaasBlock` — the SaaS host — so a CLI clone aimed
 * at a self-managed instance runs against a host whose own switch was never
 * consulted (`forge/AGENTS.md`, "Clone and fork are gated too"). `sourceNote`
 * names both exceptions rather than claiming a clean "runs no command":
 * promising a stop we do not deliver is the setting lying in the other
 * direction, and a per-host claim belongs on the row, not in the section
 * blurb. This pane only ever writes the setting and re-reads what main says.
 */
export function ForgeHostsSection(props: { saving: boolean }) {
  const [hosts, setHosts] = useState<ForgeHostRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  const [rowError, setRowError] = useState<
    { host: string; message: string } | undefined
  >();
  const [adding, setAdding] = useState<ForgeKind | undefined>();
  const mounted = useRef(false);
  const requestRef = useRef(0);
  /**
   * In-flight, read synchronously.
   *
   * `busy` cannot gate a write: it is render state, so it is not visible to a
   * second click in the same tick, and `read` only raises it AFTER the write
   * has resolved. `props.saving` cannot either — it belongs to
   * `useAppSettings.update`, and this pane dispatches `settings:update`
   * itself. Without this ref a double-click sent the write twice.
   */
  const writing = useRef(false);

  const read = useCallback(async (refresh: boolean): Promise<void> => {
    // Reads DO overlap — StrictMode mounts twice, a write re-reads, and
    // Re-check can land on top of either — and a plain `mounted` ref does not
    // order them. Without this token the slower response wins and repaints a
    // stale list over a fresh one. Same shape as `ForgesSettings`.
    const request = ++requestRef.current;
    setBusy(true);
    try {
      const result = await dispatch("forge:hosts", refresh ? { refresh } : {});
      if (!mounted.current || request !== requestRef.current) return;
      if (result.ok) {
        setHosts(result.value.hosts);
        // A latched "Copied" belongs to the row it was clicked on. Rows can be
        // removed and added back, and the label would otherwise reappear on a
        // host nothing was ever copied for.
        setCopied(undefined);
        setError(undefined);
      } else {
        setError(result.error.message);
      }
    } catch (cause) {
      // Without this the rejection escapes past `setBusy(false)` and every
      // control stays disabled on "Checking…" forever, with nothing shown.
      if (mounted.current && request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (mounted.current && request === requestRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read(false);
    return () => {
      mounted.current = false;
    };
  }, [read]);

  // "Copied" is feedback, not a state the row is in. Left latched it never
  // reverts, so a second copy of the same command confirms nothing.
  useEffect(() => {
    if (copied === undefined) return;
    const timer = window.setTimeout(() => setCopied(undefined), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * Write one host's entry, then refresh the list.
   *
   * Returns the failure message rather than setting it, so each caller can put
   * it where the user is looking — the row for a switch or a Remove, the dialog
   * for an add. `null` means it worked, matching every other write callback in
   * the app.
   *
   * The re-read is deliberately NOT awaited: it is what repaints the list, but
   * a caller that waits on it stays "in flight" until it lands, and the dialog
   * made that visible — a slow `forge:hosts` left it on "Adding…" with Cancel,
   * Escape and the backdrop all refused, after the write had already succeeded.
   * It is never a `refresh` either: a config entry changes nothing either CLI
   * would report, and refreshing spawns two subprocesses to learn that.
   */
  const writeHost = async (
    host: string,
    value: ForgeHostConfig | null
  ): Promise<string | null> => {
    if (writing.current) return null;
    writing.current = true;
    try {
      const result = await dispatch("settings:update", {
        patch: { forgeHosts: { [host]: value } }
      });
      if (!mounted.current) return null;
      if (!result.ok) return result.error.message;
      void read(false);
      return null;
    } catch (cause) {
      if (!mounted.current) return null;
      return cause instanceof Error ? cause.message : String(cause);
    } finally {
      writing.current = false;
    }
  };

  /** A row's own write. Its failure belongs on that row, not on the section
   *  header, where it named no host. */
  const writeRow = async (
    row: ForgeHostRow,
    value: ForgeHostConfig | null
  ): Promise<void> => {
    const message = await writeHost(row.host, value);
    setRowError(message === null ? undefined : { host: row.host, message });
  };

  const connected = hosts?.filter((row) => row.enabled).length;
  /** Written four times before this, and the Add buttons still went without
   *  one — naming it is what made that omission visible. */
  const blocked = props.saving || busy;

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
                busy={blocked}
                label={`Read ${KIND_LABEL[row.kind]} status from ${row.host}`}
                onChange={(next) => {
                  if (blocked) return;
                  // Always write the value the user asked for. An earlier
                  // version cleared the entry instead, on the theory that
                  // clearing returns the host to its derived default — but the
                  // derived default can BE the value they are trying to leave,
                  // in which case the switch silently snapped back and the host
                  // could not be turned off at all.
                  void writeRow(row, { enabled: next });
                }}
              />
            }
            error={rowError?.host === row.host ? rowError.message : undefined}
            help={
              <>
                {/* Two independent questions, and conflating them was a bug.
                    `origin` says whether a CLI holds an account here, which is
                    what earns the sign-in command. `kindSource` says whether a
                    PERSON chose the product, which is what makes the host
                    removable. Gating both on `origin` put "Added by you" and a
                    Remove button on a host the user had merely switched off —
                    and removing it there cleared the `enabled:false`, turning
                    the host back ON and dropping the row that could undo it. */}
                {row.kindSource === "config" ? "Added by you. " : null}
                {row.origin === "config" ? (
                  <>
                    <code>{row.cli}</code> holds no account for this host yet —
                    run <code>{signInCommand(row)}</code>{" "}
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
                  </>
                ) : (
                  sourceNote(row)
                )}
                {/* An env-pinned or switched-off row still needs its
                    explanation; `sourceNote` used to be unreachable for every
                    config row, so the switch that cannot move said nothing
                    about why. */}
                {row.origin === "config" && row.enabledSource !== "auto" ? (
                  <> {sourceNote(row)}</>
                ) : null}
                {row.kindSource === "config" ? (
                  <>
                    {" "}
                    {/* "Remove host", not "Remove": it sits beside a command
                        the button above copies, and bare "Remove" reads as if
                        it might take the command or the account instead. The
                        label names the host so several rows are
                        distinguishable, and keeps the visible text as its
                        prefix (SC 2.5.3). */}
                    <button
                      aria-disabled={blocked}
                      aria-label={`Remove host ${row.host}`}
                      className="settings-inline-button"
                      type="button"
                      onClick={() => {
                        if (blocked) return;
                        // `null` clears the entry, and for a hand-added host
                        // the stored kind is the only thing naming its product
                        // — so the row goes rather than lingering as an unknown
                        // forge. Safe to offer without confirmation only
                        // because `kindSource` proves there is a chosen product
                        // to withdraw.
                        void writeRow(row, null);
                      }}
                    >
                      Remove host
                    </button>
                  </>
                ) : null}
              </>
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
                // Genuinely unavailable, not in-flight: until the list has
                // loaded the dialog cannot tell a new host from one already
                // present, and an add that lands on an existing host rewrites
                // its product — routing that instance at the wrong CLI.
                disabled={hosts === undefined}
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
      {adding !== undefined && hosts !== undefined && (
        <AddForgeHostDialog
          kind={adding}
          listed={hosts.map((row) => row.host)}
          // `enabled: true` and not just `{ kind }`: main merges into the
          // stored entry, so a stale `enabled:false` left behind by a CLI
          // sign-out would survive and the host would arrive switched off,
          // moments after the dialog said PwrGit would talk to it.
          onAdd={(host) => writeHost(host, { kind: adding, enabled: true })}
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
  /** Hostnames already on the list, so a duplicate is refused in front of the
   *  user instead of rewriting an existing host's product. */
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
  const { title, placeholder } = ADD_HOST[props.kind];
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
          PwrGit will treat this host as {KIND_LABEL[props.kind]} and talk to it
          through <code>{FORGE_CLI[props.kind]}</code>. The hostname plays no
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
      : "Off. Nothing in the background reads this host or mints a token for it. Still running: the sign-in check that lists it here, and any clone you start yourself.";
  }
  // `auto` means nobody has decided — a known forge is on by default. It does
  // NOT mean "on because a CLI is signed in"; permission deliberately does not
  // depend on enumeration having succeeded.
  const scopes =
    row.scopes === undefined ? "" : ` · scopes: ${row.scopes.join(", ")}`;
  return `On by default${scopes}`;
}
