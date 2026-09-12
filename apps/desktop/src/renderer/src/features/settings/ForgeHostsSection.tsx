import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeHostRow } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { copyText } from "../../lib/copyText";
import { RefreshGlyph } from "../../lib/RefreshGlyph";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const KIND_LABEL: Record<ForgeHostRow["kind"], string> = {
  github: "GitHub",
  gitlab: "GitLab"
};

/**
 * Settings → Forges → Hosts.
 *
 * Rows come from main, which enumerates what `gh` and `glab` are signed in to.
 * Git remotes are deliberately not a source: a remote is an ssh target, and a
 * NAS or a box on a home network is not a forge — see `forge/AGENTS.md`.
 *
 * The switch is enforced in main, not here. It covers every BACKGROUND reader
 * by hostname: request status, commit authors, the identity refresh, and the
 * status probe itself. It does not cover everything: the CLI sign-in check
 * that discovers the host in the first place still runs, and the clone and
 * fork dialogs gate on `forgeSaasBlock` — the SaaS host — so a CLI clone aimed
 * at a self-managed instance runs against a host whose own switch was never
 * consulted (`forge/AGENTS.md`, "Clone and fork are gated too"). The copy
 * below names both exceptions rather than claiming a clean "reads nothing";
 * promising a stop we do not deliver is the setting lying in the other
 * direction. This pane only ever writes the setting and re-reads what main
 * says.
 */
export function ForgeHostsSection(props: { saving: boolean }) {
  const [hosts, setHosts] = useState<ForgeHostRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
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

  const toggle = async (row: ForgeHostRow, next: boolean): Promise<void> => {
    // Always write the value the user asked for. An earlier version cleared
    // the entry instead, on the theory that clearing returns the host to its
    // derived default — but the derived default can BE the value they are
    // trying to leave, in which case the switch silently snapped back and the
    // host could not be turned off at all.
    try {
      const result = await dispatch("settings:update", {
        patch: { forgeHosts: { [row.host]: { enabled: next } } }
      });
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await read(false);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const connected = hosts?.filter((row) => row.enabled).length;

  return (
    <SettingsSection
      title="Hosts"
      eyebrow="Integrations"
      description="Reported by the GitHub and GitLab CLIs. PwrGit only ever talks to a host on this list — a plain ssh remote never appears here. Switching one off stops everything that reads it in the background: request status, commit authors, repository identity. The clone and fork dialogs follow the switch on github.com and gitlab.com."
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
          Sign in from a terminal, then re-check.
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
                </>
              ) : (
                sourceNote(row)
              )
            }
          />
        ))
      )}
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
    </SettingsSection>
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
